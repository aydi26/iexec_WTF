/* global process */
// ============================================================================
// Noxus keeper — Vercel serverless function
// ----------------------------------------------------------------------------
// Executes the 5 PERMISSIONLESS epoch steps on behalf of the user so a plain-EOA
// wallet (Rabby / MetaMask, no EIP-5792 atomic batching) doesn't have to sign
// them: close -> settle(+CCTP burn) -> [Iris attest] -> relay+check -> finalize.
//
// These steps are permissionless BY DESIGN — every one is gated by epoch state,
// the Circle attestation, and the on-chain KMS proof, never by caller identity
// (see docs/PLAN.md §3.0). So a keeper key can drive them and CANNOT steal funds
// or alter amounts; the worst a broken/hostile keeper can do is not advance an
// epoch (the user can still self-serve client-side, or forceFallback recovers).
// The keeper key therefore only ever needs gas, and lives ONLY in the Vercel
// env (KEEPER_PRIVATE_KEY), never in the client bundle.
//
// Thin per-phase design: each phase is one short call (submit + maybe one fast
// Arb wait), so every invocation finishes well inside a serverless timeout. The
// frontend waits for each tx via its own resilient RPC and orchestrates order.
// ============================================================================

import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, arbitrumSepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

const require = createRequire(import.meta.url);
const BATCHER_ABI = require("../src/abis/NoxusBatcher.json");
const DIST_ABI = require("../src/abis/NoxusDistributor.json");
const DEPLOY = {
  11155111: require("../src/deployments/11155111.json"),
  421614: require("../src/deployments/421614.json"),
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
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Simulate-then-send: the keeper never broadcasts a tx that would revert, so a
// hostile caller can't drain its gas by requesting phases in invalid states
// (each phase also state-checks and no-ops, but simulation closes the race).
async function send(pub, wallet, params) {
  const { request } = await pub.simulateContract({ ...params, account: wallet.account });
  return wallet.writeContract(request);
}

async function publicDecryptWithRetry(hc, handle, timeoutMs = 150_000) {
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
    return amount / 1000n > 0n ? amount / 1000n : 1n; // 10 bps fallback
  }
}

// ---- phase handlers --------------------------------------------------------
// Each is idempotent-ish: it inspects epoch state and no-ops if the step is
// already done, so a retried call never double-acts.

async function doClose(route, epochId) {
  const { pub, wallet } = clients(route.srcChainId);
  const info = await pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId] });
  const state = Number(info[0]);
  if (state !== 0) return { hash: null, skipped: true, state }; // already Closed/Settled
  const hash = await send(pub, wallet, { address: route.batcher, abi: BATCHER_ABI, functionName: "closeEpoch", args: [] });
  return { hash };
}

async function doSettle(route, epochId) {
  const { pub, wallet } = clients(route.srcChainId);
  const info = await pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId] });
  if (Number(info[0]) === 2) {
    // Already settled — recover the burn tx hash from the EpochSettled event so
    // the frontend can still poll Iris.
    const hash = await settledTxHash(pub, route, epochId);
    return { hash, aggregate: (info[2] ?? 0n).toString(), skipped: true };
  }
  const [encSum, unwrapReqId] = await pub.readContract({ address: route.batcher, abi: BATCHER_ABI, functionName: "epochHandles", args: [epochId] });
  const hc = await createViemHandleClient(wallet);
  const [sumRes, unwrapRes] = await Promise.all([
    publicDecryptWithRetry(hc, encSum),
    publicDecryptWithRetry(hc, unwrapReqId),
  ]);
  const total = sumRes.value;
  const maxFee = await computeMaxFee(total, route.srcDomain, route.dstDomain);
  const hash = await send(pub, wallet, {
    address: route.batcher, abi: BATCHER_ABI, functionName: "settleEpoch",
    args: [sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee],
  });
  return { hash, aggregate: total.toString() };
}

async function settledTxHash(pub, route, epochId) {
  try {
    const logs = await pub.getContractEvents({
      address: route.batcher, abi: BATCHER_ABI, eventName: "EpochSettled",
      args: { epochId }, fromBlock: "earliest", toBlock: "latest",
    });
    return logs[logs.length - 1]?.transactionHash ?? null;
  } catch {
    return null;
  }
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
    di = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "epochInfo", args: [epochId] });
  }
  let checkHash = null;
  if (Number(di[0]) === 2) {
    checkHash = await send(pub, wallet, { address: route.distributor, abi: DIST_ABI, functionName: "checkEpoch", args: [epochId] });
    await pub.waitForTransactionReceipt({ hash: checkHash });
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
  if (checkRes.value !== 1n) {
    // Integrity failed (Sum != A) -> the fallback/refund lane owns this epoch,
    // not finalize. Surface it; the client shows the failure.
    return { hash: null, checkFailed: true, value: checkRes.value.toString() };
  }
  const hash = await send(pub, wallet, { address: route.distributor, abi: DIST_ABI, functionName: "finalizeEpoch", args: [epochId, checkRes.decryptionProof] });
  await pub.waitForTransactionReceipt({ hash });
  const di2 = await pub.readContract({ address: route.distributor, abi: DIST_ABI, functionName: "epochInfo", args: [epochId] });
  return { hash, state: Number(di2[0]) };
}

// Dispatch — exported so it can be driven directly from a headless test.
export async function runPhase(body) {
  const { phase, direction } = body;
  const route = routeFor(direction);
  const epochId = body.epochId != null ? BigInt(body.epochId) : undefined;
  switch (phase) {
    case "ping": return { ok: true, keeper: account().address };
    case "close": return await doClose(route, epochId);
    case "settle": return await doSettle(route, epochId);
    case "attest": return await doAttest(body.domain, body.txHash);
    case "relaycheck": return await doRelayCheck(route, epochId, body.message, body.attestation);
    case "finalize": return await doFinalize(route, epochId);
    default: throw new Error(`unknown phase: ${phase}`);
  }
}

// Vercel Node serverless entrypoint.
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
    // BigInt-safe JSON
    return res.status(200).json(JSON.parse(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
  } catch (e) {
    return res.status(500).json({ error: String(e?.shortMessage || e?.message || e).slice(0, 300) });
  }
}
