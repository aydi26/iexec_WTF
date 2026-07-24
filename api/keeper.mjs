/* global process */
// ============================================================================
// Noxus keeper — Vercel serverless function (repo-root deployment)
// ----------------------------------------------------------------------------
// The Vercel project builds from the REPO ROOT, so the serverless function lives
// here at /api/keeper.mjs (Vercel serves the root /api directory). It is
// SELF-CONTAINED: viem + @iexec-nox/handle resolve from the ROOT node_modules
// (installed by the root install step), and the ABIs/addresses are read from the
// co-located ./abis + ./deployments (shipped via vercel.json includeFiles). No
// cross-directory imports — that is what makes it bundle cleanly from the root.
//
// It executes the 5 PERMISSIONLESS epoch steps (close, settle+CCTP burn, relay,
// integrity check, finalize) plus the batch fillers, so a plain-EOA wallet only
// signs its own deposit. These steps are gated by epoch state + the Circle
// attestation + the on-chain KMS proof, never by caller identity — so the keeper
// key CANNOT steal funds or alter amounts; it only ever needs gas and lives ONLY
// in the Vercel env (KEEPER_PRIVATE_KEY), never in any client bundle.
// ============================================================================

import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, arbitrumSepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

const require = createRequire(import.meta.url);
const BATCHER_ABI = require("./abis/NoxusBatcher.json");
const DIST_ABI = require("./abis/NoxusDistributor.json");
const CUSDC_ABI = require("./abis/NoxusCUSDC.json");
const DEPLOY = {
  11155111: require("./deployments/11155111.json"),
  421614: require("./deployments/421614.json"),
};

const IRIS = "https://iris-api-sandbox.circle.com";
const CHAINS = {
  11155111: { chain: sepolia, domain: 0, rpc: process.env.ETH_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com" },
  421614: { chain: arbitrumSepolia, domain: 3, rpc: process.env.ARB_SEPOLIA_RPC_URL || "https://arbitrum-sepolia-rpc.publicnode.com" },
};

// getLogs support varies wildly across free RPC tiers (publicnode 403s wide
// ranges, Alchemy free caps at 10 blocks) — the burn-tx recovery walks these
// logs-capable public fallbacks after the configured RPC. Window/chunk are
// per-chain: 50k blocks ≈ 7 days on ETH Sepolia but only hours on Arb Sepolia
// (sub-second blocks), so Arb gets a much wider window.
const LOGS = {
  11155111: {
    window: 50_000n, chunk: 9_500n,
    rpcs: ["https://sepolia.drpc.org", "https://ethereum-sepolia.blockpi.network/v1/rpc/public", "https://eth-sepolia.public.blastapi.io", "https://1rpc.io/sepolia"],
  },
  421614: {
    window: 600_000n, chunk: 45_000n,
    rpcs: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia.drpc.org", "https://arbitrum-sepolia.blockpi.network/v1/rpc/public"],
  },
};

function account() {
  const pk = process.env.KEEPER_PRIVATE_KEY;
  if (!pk) throw new Error("KEEPER_PRIVATE_KEY is not set on the server.");
  return privateKeyToAccount(pk.startsWith("0x") ? pk : `0x${pk}`);
}

function clients(chainId) {
  const c = CHAINS[chainId];
  const transport = http(c.rpc);
  return {
    pub: createPublicClient({ chain: c.chain, transport }),
    wallet: createWalletClient({ account: account(), chain: c.chain, transport }),
  };
}

function routeFor(direction) {
  const [s, d] = direction === "arb-eth" ? [421614, 11155111] : [11155111, 421614];
  return {
    srcChainId: s,
    dstChainId: d,
    srcDomain: CHAINS[s].domain,
    dstDomain: CHAINS[d].domain,
    batcher: DEPLOY[s].NoxusBatcher,
    distributor: DEPLOY[d].NoxusDistributor,
    cusdc: DEPLOY[s].NoxusCUSDC,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(pub, wallet, params) {
  const { request } = await pub.simulateContract({ ...params, account: wallet.account });
  return wallet.writeContract(request);
}

async function publicDecryptWithRetry(hc, handle, timeoutMs = 45_000) {
  const t0 = Date.now();
  let delay = 1500;
  for (;;) {
    try {
      const r = await hc.publicDecrypt(handle);
      return { value: BigInt(r.value), decryptionProof: r.decryptionProof };
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
      await sleep(delay);
      delay = Math.min(delay * 1.4, 8000);
    }
  }
}

async function computeMaxFee(amount, srcDomain, dstDomain) {
  // settleEpoch/initiateRefund enforce require(maxFee <= amount/100), so the
  // returned value MUST be clamped to that cap — otherwise a high Iris fee makes
  // the 3x margin exceed 1% of A and the settle tx reverts, stranding the epoch.
  const cap = amount / 100n; // 1% of A (the on-chain bound)
  const clamp = (v) => (cap > 0n && v > cap ? cap : v > 0n ? v : 1n);
  try {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, { signal: AbortSignal.timeout(15000) });
    const arr = await r.json();
    const fast = arr.find((x) => x.finalityThreshold <= 1000) ?? arr[0];
    const bps = BigInt(Math.ceil((fast?.minimumFee ?? 1) * 100));
    const fee = (amount * bps + 999_999n) / 1_000_000n;
    return clamp(fee * 3n);
  } catch {
    return clamp(amount / 1000n);
  }
}

// Filler amounts are RANDOMIZED per bridge (0.20–0.70 cUSD each, 0.01 grain),
// drawn server-side and never returned to the client: with fixed public filler
// constants an observer could compute the user's amount as A − constant. With
// private random fillers, the public aggregate only bounds the user's amount
// within the filler-sum distribution (the operator itself still knows its own
// fillers — documented as the residual k=1-vs-operator in SECURITY.md).
const FILLER_MIN = 200_000n;
const drawFiller = () => FILLER_MIN + BigInt(Math.floor(Math.random() * 51)) * 10_000n;
const fillingNow = new Set();

async function doFill(route, epochId) {
  const dampKey = `${route.srcChainId}:${epochId}`;
  if (fillingNow.has(dampKey)) return { skipped: true, reason: "fill already in progress" };
  fillingNow.add(dampKey);
  try {
    const src = clients(route.srcChainId);
    const dst = clients(route.dstChainId);
    const me = account().address;

    const info = await src.pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId] });
    if (Number(info[0]) !== 0) return { skipped: true, reason: `epoch not open (state ${Number(info[0])})` };
    const activeCount = Number(info[1]);
    const entryCount = Number(info[4]);
    // Idempotency by ON-CHAIN count (the in-memory dampener is per-warm-instance
    // on serverless and shares nothing across cold starts / concurrent lambdas):
    // count how many live filler deposits the keeper ALREADY has in this epoch,
    // and only top up the gap. Non-keeper depositors present => it's a co-deposit
    // (pool mode) — don't add fillers.
    let ownedByKeeper = 0;
    let othersPresent = false;
    for (let i = 0; i < entryCount; i++) {
      const d = await src.pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "entryAt", args: [epochId, BigInt(i)] });
      if (d[3]) continue; // withdrawn
      if (String(d[0]).toLowerCase() === me.toLowerCase()) ownedByKeeper += 1;
      else othersPresent = true;
    }
    if (ownedByKeeper >= 2) return { skipped: true, reason: "already filled" };
    const others = activeCount - ownedByKeeper;
    if (others > 1 || othersPresent && others > 1) return { skipped: true, reason: "epoch already has co-depositors" };
    const toFill = 2 - ownedByKeeper; // only the missing fillers

    const units = Array.from({ length: toFill }, () => drawFiller()); // private to the operator
    const srcHc = await createViemHandleClient(src.wallet);
    const need = units.reduce((a, b) => a + b, 0n);
    // Fail CLOSED on a persistent liquidity-read failure: rather than deposit and
    // risk enc(0) fillers (which would flip the integrity check), skip so the
    // frontend falls back to self-filler mode. One bounded retry absorbs a blip.
    let liq = null;
    for (let i = 0; i < 2 && liq === null; i++) {
      try {
        const balHandle = await src.pub.readContract({ address: route.cusdc, abi: CUSDC_ABI, functionName: "confidentialBalanceOf", args: [me] });
        if (!balHandle || balHandle === `0x${"0".repeat(64)}`) return { skipped: true, reason: "keeper filler liquidity exhausted" };
        liq = BigInt((await srcHc.decrypt(balHandle)).value);
      } catch { await sleep(1200); }
    }
    if (liq === null) return { skipped: true, reason: "keeper liquidity unreadable — deferring to self-filler" };
    if (liq < need) return { skipped: true, reason: "keeper filler liquidity exhausted" };

    const dstHc = await createViemHandleClient(dst.wallet);
    const fills = [];
    for (const amount of units) {
      const dstEnc = await dstHc.encryptInput(amount, "uint256", route.distributor);
      const srcEnc = await srcHc.encryptInput(amount, "uint256", route.batcher);
      fills.push({ dstEnc, srcEnc });
    }

    // No explicit nonces: each `send` awaits its writeContract, and viem reads the
    // PENDING nonce per send — so the second src deposit sees the first in the
    // mempool and takes nonce+1 automatically. Sequential awaits keep them ordered
    // without paying for receipt confirmations (fill returns in ~5 s); the frontend
    // polls the batch to 3/3 before asking for close. Concurrent cross-instance
    // fills are backstopped by the on-chain idempotency count + TooManyClaims.
    const preHashes = [];
    const depHashes = [];
    for (let i = 0; i < fills.length; i++) {
      preHashes.push(await send(dst.pub, dst.wallet, { address: route.distributor, abi: DIST_ABI, functionName: "preRegister", args: [epochId, me, fills[i].dstEnc.handle, fills[i].dstEnc.handleProof] }));
      depHashes.push(await send(src.pub, src.wallet, { address: route.batcher, abi: BATCHER_ABI, functionName: "deposit", args: [me, fills[i].srcEnc.handle, fills[i].srcEnc.handleProof, fills[i].dstEnc.handle] }));
    }
    return { preHashes, depHashes };
  } finally {
    fillingNow.delete(dampKey);
  }
}

async function doClose(route, epochId) {
  const { pub, wallet } = clients(route.srcChainId);
  const info = await pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId] });
  if (Number(info[0]) !== 0) return { hash: null, skipped: true, state: Number(info[0]) };
  const hash = await send(pub, wallet, { address: route.batcher, abi: BATCHER_ABI, functionName: "closeEpoch", args: [] });
  return { hash };
}

async function doSettle(route, epochId) {
  const { pub, wallet } = clients(route.srcChainId);
  const info = await pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId] });
  if (Number(info[0]) === 2) {
    const hash = await settledTxHash(pub, route, epochId);
    return { hash, aggregate: (info[2] ?? 0n).toString(), skipped: true };
  }
  const [encSum, unwrapReqId] = await pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "epochHandles", args: [epochId] });
  const hc = await createViemHandleClient(wallet);
  const [sumRes, unwrapRes] = await Promise.all([publicDecryptWithRetry(hc, encSum), publicDecryptWithRetry(hc, unwrapReqId)]);
  const total = sumRes.value;
  const maxFee = await computeMaxFee(total, route.srcDomain, route.dstDomain);
  const hash = await send(pub, wallet, { address: route.batcher, abi: BATCHER_ABI, functionName: "settleEpoch", args: [sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee] });
  return { hash, aggregate: total.toString() };
}

async function settledTxHash(pub, route, epochId) {
  // Recover the settle/burn tx of an already-Settled epoch from EpochSettled
  // logs. The configured RPC is tried first, then the LOGS fallbacks; each RPC
  // gets one wide-range query, then a newest-first chunked scan (free tiers cap
  // ranges differently). Bounded by one overall deadline so the serverless
  // settle phase stays snappy; null only if every route is exhausted.
  const chainId = route.srcChainId;
  const { window, chunk, rpcs } = LOGS[chainId];
  const deadline = Date.now() + 20_000;
  const candidates = [pub, ...rpcs.filter((u) => u !== CHAINS[chainId].rpc).map((u) => createPublicClient({ chain: CHAINS[chainId].chain, transport: http(u) }))];
  for (const c of candidates) {
    if (Date.now() > deadline) break;
    let tip;
    try { tip = await c.getBlockNumber(); } catch { continue; }
    const from = tip > window ? tip - window : 0n;
    const query = async (fromBlock, toBlock) => {
      const logs = await c.getContractEvents({ address: route.batcher, abi: BATCHER_ABI, eventName: "EpochSettled", args: { epochId }, fromBlock, toBlock });
      return logs[logs.length - 1]?.transactionHash ?? null;
    };
    try {
      const h = await query(from, "latest");
      if (h) return h;
      continue; // wide range accepted but no event in the window — try next RPC
    } catch { /* wide range rejected — fall through to the chunked scan */ }
    try {
      for (let hi = tip; hi > from && Date.now() < deadline; ) {
        const lo = hi - chunk + 1n > from ? hi - chunk + 1n : from;
        const h = await query(lo, hi);
        if (h) return h;
        if (lo <= from) break;
        hi = lo - 1n;
      }
    } catch { /* this RPC rejects even chunked queries — next candidate */ }
  }
  return null;
}

async function doAttest(domain, txHash) {
  const url = `${IRIS}/v2/messages/${domain}?transactionHash=${txHash}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) return { status: "pending" };
  const j = await r.json();
  const m = j.messages?.[0];
  if (m?.status === "complete" && m.message && m.attestation && m.attestation !== "0x") {
    return { status: "complete", message: m.message, attestation: m.attestation };
  }
  return { status: "pending", delayReason: m?.delayReason ?? null };
}

async function doRelayCheck(route, epochId, message, attestation) {
  const { pub, wallet } = clients(route.dstChainId);
  let relayHash = null;
  let di = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "epochInfo", args: [epochId] });
  if (Number(di[0]) < 2) {
    relayHash = await send(pub, wallet, { address: route.distributor, abi: DIST_ABI, functionName: "relayReceive", args: [message, attestation] });
    await pub.waitForTransactionReceipt({ hash: relayHash });
    // Stale-read guard: some RPCs briefly serve pre-receipt state right after
    // the receipt — re-read until the Received state is visible, else the
    // check below would be silently skipped.
    for (let i = 0; i < 6; i++) {
      di = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "epochInfo", args: [epochId] });
      if (Number(di[0]) >= 2) break;
      await sleep(1500);
    }
  }
  let checkHash = null;
  if (Number(di[0]) === 2) {
    checkHash = await send(pub, wallet, { address: route.distributor, abi: DIST_ABI, functionName: "checkEpoch", args: [epochId] });
    await pub.waitForTransactionReceipt({ hash: checkHash });
    di = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "epochInfo", args: [epochId] });
  }
  return { relayHash, checkHash, state: Number(di[0]) };
}

async function doFinalize(route, epochId) {
  const { pub, wallet } = clients(route.dstChainId);
  const di = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "epochInfo", args: [epochId] });
  if (Number(di[0]) === 4) return { hash: null, skipped: true, state: 4 };
  const checkNum = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "checkHandle", args: [epochId] });
  const hc = await createViemHandleClient(wallet);
  const checkRes = await publicDecryptWithRetry(hc, checkNum);
  if (checkRes.value !== 1n) return { hash: null, checkFailed: true, value: checkRes.value.toString() };
  const hash = await send(pub, wallet, { address: route.distributor, abi: DIST_ABI, functionName: "finalizeEpoch", args: [epochId, checkRes.decryptionProof] });
  await pub.waitForTransactionReceipt({ hash });
  // Stale-read guard (same as relaycheck): re-read until the post-tx state shows.
  let di2 = di;
  for (let i = 0; i < 6; i++) {
    di2 = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "epochInfo", args: [epochId] });
    if (Number(di2[0]) >= 4) break;
    await sleep(1500);
  }
  return { hash, state: Number(di2[0]) };
}

export async function runPhase(body) {
  const { phase, direction } = body;
  const route = routeFor(direction);
  const epochId = body.epochId != null ? BigInt(body.epochId) : undefined;
  switch (phase) {
    case "ping": return { ok: true, keeper: account().address };
    case "fill": return await doFill(route, epochId);
    case "close": return await doClose(route, epochId);
    case "settle": return await doSettle(route, epochId);
    case "attest": return await doAttest(body.domain, body.txHash);
    case "relaycheck": return await doRelayCheck(route, epochId, body.message, body.attestation);
    case "finalize": return await doFinalize(route, epochId);
    default: throw new Error(`unknown phase: ${phase}`);
  }
}

export const config = { maxDuration: 60 };

// Best-effort per-warm-instance rate limit. The endpoint is intentionally
// unauthenticated (every phase is permissionless by design and defended in depth:
// simulate-before-send means no gas is spent on reverting calls, all phases are
// idempotent/state-guarded so replays no-op, and `fill` is on-chain-capped to two
// filler deposits per epoch). This limiter just blunts casual POST floods; it does
// not (and need not) enforce hard security. A production edge would add real rate
// limiting / origin binding — see SECURITY.md L-5.
const RL = { hits: [], windowMs: 10_000, max: 20 };
function rateLimited() {
  const now = Date.now();
  RL.hits = RL.hits.filter((t) => now - t < RL.windowMs);
  if (RL.hits.length >= RL.max) return true;
  RL.hits.push(now);
  return false;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    try { return res.status(200).json({ ok: true, keeper: account().address }); }
    catch (e) { return res.status(500).json({ error: String(e?.message || e) }); }
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (rateLimited()) return res.status(429).json({ error: "rate limited — retry shortly" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const out = await runPhase(body);
    return res.status(200).json(JSON.parse(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  } catch (e) {
    return res.status(500).json({ error: String(e?.shortMessage || e?.message || e).slice(0, 300) });
  }
}
