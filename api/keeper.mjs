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

async function sendNonce(pub, wallet, params, nonce) {
  const { request } = await pub.simulateContract({ ...params, account: wallet.account });
  return wallet.writeContract({ ...request, nonce });
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
  try {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, { signal: AbortSignal.timeout(15000) });
    const arr = await r.json();
    const fast = arr.find((x) => x.finalityThreshold <= 1000) ?? arr[0];
    const bps = BigInt(Math.ceil((fast?.minimumFee ?? 1) * 100));
    const fee = (amount * bps + 999_999n) / 1_000_000n;
    return fee * 3n > 0n ? fee * 3n : 1n;
  } catch {
    return amount / 1000n > 0n ? amount / 1000n : 1n;
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
    for (let i = 0; i < entryCount; i++) {
      const d = await src.pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "entryAt", args: [epochId, BigInt(i)] });
      if (String(d[0]).toLowerCase() === me.toLowerCase() && !d[3]) return { skipped: true, reason: "already filled" };
    }
    if (activeCount > 1) return { skipped: true, reason: "epoch already has co-depositors" };

    const units = [drawFiller(), drawFiller()]; // private to the operator
    const srcHc = await createViemHandleClient(src.wallet);
    const need = units[0] + units[1];
    try {
      const balHandle = await src.pub.readContract({ address: route.cusdc, abi: CUSDC_ABI, functionName: "confidentialBalanceOf", args: [me] });
      if (balHandle && balHandle !== `0x${"0".repeat(64)}`) {
        const dec = await srcHc.decrypt(balHandle);
        if (BigInt(dec.value) < need) return { skipped: true, reason: "keeper filler liquidity exhausted" };
      } else {
        return { skipped: true, reason: "keeper filler liquidity exhausted" };
      }
    } catch { /* gateway blip — proceed */ }

    const dstHc = await createViemHandleClient(dst.wallet);
    const fills = [];
    for (const amount of units) {
      const dstEnc = await dstHc.encryptInput(amount, "uint256", route.distributor);
      const srcEnc = await srcHc.encryptInput(amount, "uint256", route.batcher);
      fills.push({ dstEnc, srcEnc });
    }

    const dstNonce = await dst.pub.getTransactionCount({ address: me, blockTag: "pending" });
    const srcNonce = await src.pub.getTransactionCount({ address: me, blockTag: "pending" });
    const preHashes = [];
    const depHashes = [];
    for (let i = 0; i < fills.length; i++) {
      preHashes.push(await sendNonce(dst.pub, dst.wallet, { address: route.distributor, abi: DIST_ABI, functionName: "preRegister", args: [epochId, me, fills[i].dstEnc.handle, fills[i].dstEnc.handleProof] }, dstNonce + i));
      depHashes.push(await sendNonce(src.pub, src.wallet, { address: route.batcher, abi: BATCHER_ABI, functionName: "deposit", args: [me, fills[i].srcEnc.handle, fills[i].srcEnc.handleProof, fills[i].dstEnc.handle] }, srcNonce + i));
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
  try {
    const logs = await pub.getContractEvents({ address: route.batcher, abi: BATCHER_ABI, eventName: "EpochSettled", args: { epochId }, fromBlock: "earliest", toBlock: "latest" });
    return logs[logs.length - 1]?.transactionHash ?? null;
  } catch { return null; }
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
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const out = await runPhase(body);
    return res.status(200).json(JSON.parse(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  } catch (e) {
    return res.status(500).json({ error: String(e?.shortMessage || e?.message || e).slice(0, 300) });
  }
}
