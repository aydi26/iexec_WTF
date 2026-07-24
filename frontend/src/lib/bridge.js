// ============================================================================
// Confidential cross-chain bridge — in-browser orchestration
// ----------------------------------------------------------------------------
// Faithful port of scripts/04_honest_e2e.ts to the browser. Drives the WHOLE
// confidential cross-chain flow from the wallet, no scripts:
//
//   deposit (ETH) -> close -> settle + CCTP burn (ETH) -> Iris relay
//   -> integrity check (Arb) -> confidential distribution (Arb)
//
// Depositors pre-register their dst claim on Arb (owner-binding), deposit the
// encrypted amount on ETH re-using the EXACT SAME dstHandle (the on-chain
// committed-list binding requires it), the batch settles + bridges one public
// aggregate A, the Distributor relays the mint, runs the on-chain integrity
// check (Sum == A) and distributes confidentially.
//
// Chain switching: the flow crosses chains, so we NEVER reuse a stale wallet
// client. `getWalletClient()` (passed in by the caller) always returns a fresh
// wallet client bound to the CURRENTLY active chain, and the Nox handle client
// is recreated from that wallet client after every switch (the SDK resolves its
// network from the wallet's chainId). Order minimises switches: all Arb
// pre-registrations first, then all ETH work, then Arb finalize.
// ============================================================================

import { createWalletClient, encodeFunctionData, fallback, http } from "viem";
import { toAccount } from "viem/accounts";
import { sepolia, arbitrumSepolia } from "viem/chains";
import { sendCalls, getCapabilities, waitForCallsStatus } from "viem/actions";
import { createViemHandleClient } from "@iexec-nox/handle";
import {
  BATCHER_ABI,
  CUSDC_ABI,
  DISTRIBUTOR_ABI,
  ERC20_ABI,
  FAR_FUTURE_EXPIRY,
} from "../config/contracts";
import { RPC_URLS } from "../config/wagmi";

const IRIS = "https://iris-api-sandbox.circle.com";
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

// One-time max allowance for the cUSDC wrapper (see the fund step below).
const MAX_UINT256 = 2n ** 256n - 1n;
// Extra USDC wrapped beyond this bridge's shortfall so the NEXT bridge's
// fillers are already covered and the wrap tx disappears from later bridges.
const WRAP_HEADROOM = 1_000_000n; // ~one extra bridge of filler liquidity (2 x 0.5 cUSD)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Iris (Circle CCTP V2 sandbox) helpers — ported from scripts/lib/cctp.ts.
// NOTE: browser fetch to Iris may hit CORS. We catch that and surface a clear,
// actionable error rather than crashing silently.
// ---------------------------------------------------------------------------

function isCorsLikeError(e) {
  // Browser cross-origin fetch failures throw a TypeError "Failed to fetch"
  // with no useful detail; treat network-level TypeErrors as CORS-like.
  return (
    e instanceof TypeError ||
    /failed to fetch|networkerror|load failed/i.test(String(e?.message || e))
  );
}

/** Live fast fee (bps) for src->dst from Iris, with a safety multiple, CLAMPED to
 *  the on-chain cap: settleEpoch/initiateRefund require(maxFee <= amount/100), so
 *  a high Iris fee times the 3x margin must never exceed 1% of A or the settle
 *  reverts and strands the epoch. */
async function computeMaxFee(amount, srcDomain, dstDomain) {
  const cap = amount / 100n; // 1% of A (the on-chain bound)
  const clamp = (v) => (cap > 0n && v > cap ? cap : v > 0n ? v : 1n);
  try {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, {
      signal: AbortSignal.timeout(15000),
    });
    const arr = await r.json();
    const fast = arr.find((x) => x.finalityThreshold <= 1000) ?? arr[0];
    const bps = BigInt(Math.ceil((fast?.minimumFee ?? 1) * 100));
    // maxFee = ceil(amount * bps / 1e6) * 3 (margin), then clamped to the cap.
    const fee = (amount * bps + 999_999n) / 1_000_000n;
    return clamp(fee * 3n);
  } catch (e) {
    if (isCorsLikeError(e)) {
      // CORS-blocked fee lookup -> safe 10 bps estimate (still clamped); the relay
      // leg surfaces the CORS guidance if Iris is truly unreachable.
      return clamp(amount / 1000n);
    }
    return clamp(amount / 1000n); // fallback 10 bps
  }
}

/** Poll Iris until the burn is attested; returns { message, attestation }. */
async function fetchAttestation(srcDomain, burnTxHash, onWait, timeoutMs = 300_000) {
  const url = `${IRIS}/v2/messages/${srcDomain}?transactionHash=${burnTxHash}`;
  const t0 = Date.now();
  let delay = 3000;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const j = await r.json();
        const m = j.messages?.[0];
        if (m?.status === "complete" && m.message && m.attestation && m.attestation !== "0x") {
          return { message: m.message, attestation: m.attestation };
        }
        if (m?.delayReason && onWait) onWait(`Iris: ${m.delayReason}`);
      }
    } catch (e) {
      if (isCorsLikeError(e)) {
        throw new Error(
          "Iris relay blocked by CORS — the browser cannot poll Circle's attestation API directly. " +
            "Run the keeper script for the relay leg (scripts), then the remaining Arb steps will succeed."
        );
      }
      // transient (timeout / 5xx) — keep polling
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`Iris attestation timeout for ${burnTxHash} (waited ${Math.round((Date.now() - t0) / 1000)}s)`);
    }
    if (onWait) onWait(`waiting for Circle attestation… (${Math.round((Date.now() - t0) / 1000)}s)`);
    await sleep(delay);
    delay = Math.min(delay * 1.3, 8000);
  }
}

// ---------------------------------------------------------------------------
// Nox handle clients pinned to OUR resilient RPCs.
// The SDK extends whatever viem client it is given with publicActions and runs
// ALL its on-chain reads through that client's transport — so a client built
// from the injected wallet routes the gateway() resolution AND every
// publicDecrypt poll through the WALLET's own RPC (rate-limited/flaky for many
// users; the exact "Failed to read contract … (method: gateway)" seen in the
// field). encryptInput and publicDecrypt never sign (verified in the SDK), so
// for those we hand the SDK a client with the user's ADDRESS (owner binding)
// but chain + transport pinned to the app's fallback RPC pool. Only private
// `decrypt` (signTypedData) still needs the real wallet — and both decrypt
// call sites are best-effort.
// ---------------------------------------------------------------------------
const CHAIN_DEF = { [sepolia.id]: sepolia, [arbitrumSepolia.id]: arbitrumSepolia };
const noxClientCache = new Map();

// Build the SDK handle client, retrying client creation (which performs the
// on-chain gateway() read that failed in the field) a few times. `walletClient`
// is the LAST-RESORT transport: if the RPC-pinned read keeps failing, fall back
// to the real wallet's client — the path that worked before RPC-pinning — so we
// are strictly more robust than either transport alone.
async function buildNoxClient(chainId, address, walletClient) {
  const account = toAccount({
    address,
    async signMessage() { throw new Error("read-only Nox client cannot sign"); },
    async signTransaction() { throw new Error("read-only Nox client cannot sign"); },
    async signTypedData() { throw new Error("read-only Nox client cannot sign"); },
  });
  const pinned = createWalletClient({
    account,
    chain: CHAIN_DEF[chainId],
    transport: fallback(RPC_URLS[chainId].map((u) => http(u))),
  });
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await createViemHandleClient(pinned);
    } catch (e) {
      lastErr = e;
      await sleep(1000 * (i + 1));
    }
  }
  // Pinned RPCs failed 3× — try the wallet's own client as a fallback.
  if (walletClient) {
    try {
      return await createViemHandleClient(walletClient);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function noxClientFor(chainId, address, walletClient) {
  const key = `${chainId}:${String(address).toLowerCase()}`;
  if (!noxClientCache.has(key)) {
    // Cache the promise; evict on failure so a transient error doesn't poison
    // every later call with the same rejected promise.
    const p = buildNoxClient(chainId, address, walletClient).catch((e) => {
      noxClientCache.delete(key);
      throw e;
    });
    noxClientCache.set(key, p);
  }
  return noxClientCache.get(key);
}

// Encrypt with a bounded retry: the remaining failure mode after pinning RPCs
// is a transient Handle Gateway hiccup (observed 401/403 propagation blips).
async function encryptWithRetry(hc, value, app, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      return await hc.encryptInput(value, "uint256", app);
    } catch (e) {
      if (i >= tries - 1) throw e;
      await sleep(1200 * (i + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// Nox reveal helper: poll publicDecrypt until the KMS proof is ready.
// (Ported from scripts/lib/common.ts publicDecryptWithRetry.)
// ---------------------------------------------------------------------------
async function publicDecryptWithRetry(handleClient, handle, onWait, timeoutMs = 180_000) {
  const t0 = Date.now();
  let delay = 1500;
  for (;;) {
    try {
      const r = await handleClient.publicDecrypt(handle);
      return { value: BigInt(r.value), decryptionProof: r.decryptionProof };
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
      if (onWait) onWait(`waiting for KMS reveal… (${Math.round((Date.now() - t0) / 1000)}s)`);
      await sleep(delay);
      delay = Math.min(delay * 1.4, 8000);
    }
  }
}

// ---------------------------------------------------------------------------
// Submission resilience. A wallet broadcasts through ITS OWN RPC; public ones
// (e.g. the Tenderly gateway MetaMask defaults to on Sepolia) rate-limit under a
// burst of txs. These classifiers + a nonce-guarded retry let a transient
// rate-limit self-heal instead of aborting the whole bridge.
// ---------------------------------------------------------------------------
function isUserReject(e) {
  const s = String(e?.shortMessage || e?.message || e);
  return /user rejected|user denied|rejected the request|4001|action_rejected/i.test(s);
}
function isTransientRpc(e) {
  const s = String(e?.shortMessage || e?.message || e?.details || e);
  return /rate.?limit|too many requests|429|limit exceeded|timeout|timed out|failed to fetch|network ?error|load failed|econn|503|502|-32005|temporarily|try again/i.test(s);
}

// writeContract with a bounded retry on transient RPC / rate-limit errors.
// Double-send safety: we PIN one nonce (read once, before the loop) and reuse it
// on every retry. If the first attempt actually broadcast before erroring, the
// node already has that nonce, so the retry is rejected as "nonce too low /
// already known" — never a second distinct tx. (The old before/after comparison
// missed this: pending already counts the broadcast tx while latest lags, so an
// advance was almost never detected and viem would auto-assign a fresh nonce.)
// User-rejections and real reverts are never retried.
async function writeResilient(wallet, pub, params, onNote) {
  const addr = params.account?.address ?? params.account;
  let pinnedNonce;
  if (pub && addr) {
    try { pinnedNonce = await pub.getTransactionCount({ address: addr, blockTag: "pending" }); } catch { /* fall back to wallet-managed nonce */ }
  }
  const call = pinnedNonce != null ? { ...params, nonce: pinnedNonce } : params;
  for (let attempt = 0; ; attempt++) {
    try {
      return await wallet.writeContract(call);
    } catch (e) {
      // A retry that hits the already-broadcast tx surfaces as nonce-too-low /
      // already-known — treat that as success-in-flight, not an error to retry.
      if (/nonce too low|already known|already imported|replacement transaction/i.test(String(e?.shortMessage || e?.message || e))) throw e;
      if (isUserReject(e) || !isTransientRpc(e) || attempt >= 3) throw e;
      onNote?.(`RPC busy — retrying (${attempt + 1}/3)…`);
      await sleep(1500 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------
// EIP-5792 atomic batching. Runs a group of writes as ONE wallet confirmation
// when the wallet supports it (MetaMask smart-account / EIP-7702, etc.), else
// returns null so the caller runs them sequentially — the proven fallback path.
// `forceAtomic` makes the bundle all-or-nothing: a revert rolls everything back,
// so falling back is always safe (no partial state). Calls encrypt off-chain
// FIRST (encryptInput never prompts), so a whole phase collapses to one signature.
// Each call: { address, abi, functionName, args, value?, key, label }.
// ---------------------------------------------------------------------------
async function tryBatch(wallet, waitReceipt, calls) {
  // Empty list -> null (not []): [] is truthy, which would make runCalls treat
  // an empty batch as "done" and silently skip. null routes to the (no-op)
  // sequential loop instead. Unreachable today (all call sites pass >=2 calls),
  // kept as belt-and-suspenders against a future caller.
  if (!calls.length) return null;

  // (1) Capability probe — if this fails, NOTHING was submitted, so returning
  // null (→ sequential fallback) is safe.
  let caps;
  try {
    caps = await getCapabilities(wallet, { account: wallet.account.address, chainId: wallet.chain.id });
  } catch {
    return null; // no wallet_getCapabilities -> no EIP-5792
  }
  const atomic = caps?.atomic?.status;
  if (atomic !== "supported" && atomic !== "ready") return null;

  // (2) Submit the bundle. If sendCalls THROWS (rejected/unsupported), nothing
  // executed → null → safe sequential fallback.
  const encoded = calls.map((c) => ({
    to: c.address,
    data: encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args }),
    ...(c.value != null ? { value: c.value } : {}),
  }));
  let submitted;
  try {
    submitted = await sendCalls(wallet, { account: wallet.account, chain: wallet.chain, calls: encoded, forceAtomic: true });
  } catch {
    return null; // rejected before submission -> safe to fall back
  }
  const id = typeof submitted === "string" ? submitted : submitted?.id;

  // (3) The bundle IS submitted. From here we must NOT fall back to sequential —
  // that would re-execute the same calls (double-spend). Resolve to success or
  // throw. forceAtomic => a failure means the whole bundle reverted (no partial
  // state), so throwing lets the user retry the flow cleanly.
  // If sendCalls resolved without an id we cannot track the bundle; because it
  // MAY be in flight, we throw a clear message (never fall back) — retrying the
  // whole flow is safe (atomic bundle, no partial state) and the batch either
  // never landed or is idempotent-checked by the on-chain guards on retry.
  if (!id) throw new Error("Wallet accepted the batch but returned no tracking id — check your wallet, the bridge may have gone through; retry only if it didn't.");
  const res = await waitForCallsStatus(wallet, { id, timeout: 240_000 });
  const ok =
    res.status === "success" ||
    res.status === 200 ||
    (Array.isArray(res.receipts) && res.receipts.length > 0 && res.status !== "failure" && res.status !== "reverted");
  if (!ok) throw new Error("Batched transaction did not succeed — please retry.");
  const receipts = res.receipts ?? [];
  const last = receipts[receipts.length - 1]?.transactionHash;
  if (last) { try { await waitReceipt(last); } catch { /* already mined in the bundle */ } }
  return receipts;
}

// Execute a list of tagged calls either as one atomic batch or sequentially
// (identical calls, identical order — so the fallback matches the proven flow).
// Returns the last tx hash. `step`/`wait` drive the tracker + finality.
async function runCalls(wallet, wait, pub, chainId, calls, step, batchNote) {
  const batched = await tryBatch(wallet, wait, calls);
  if (batched) {
    const h = batched[batched.length - 1]?.transactionHash;
    for (const c of calls) step(c.key, "done", `${c.label} · batched`, undefined, chainId);
    if (batchNote) step(calls[calls.length - 1].key, "done", batchNote, h, chainId);
    return h;
  }
  let last;
  for (const c of calls) {
    step(c.key, "active", `${c.label} · confirm in wallet`);
    last = await writeResilient(
      wallet, pub,
      { address: c.address, abi: c.abi, functionName: c.functionName, args: c.args, ...(c.value != null ? { value: c.value } : {}), account: wallet.account, chain: wallet.chain },
      (n) => step(c.key, "active", `${c.label} · ${n}`)
    );
    step(c.key, "active", `${c.label} · confirming`, last, chainId);
    await wait(last);
    step(c.key, "done", `${c.label} · done`, last, chainId);
  }
  return last;
}

// ---------------------------------------------------------------------------
// Serverless keeper. The 5 permissionless steps (close, settle+burn, relay,
// check, finalize) are, by design, gated by epoch state + the Circle attestation
// + the on-chain KMS proof — never by caller identity — so a hosted keeper can
// run them and CANNOT steal funds or alter amounts. Moving them off the user
// means a plain EOA (Rabby / MetaMask, no EIP-5792) only signs preRegister x3 +
// funding + deposit x3. `keeper(phase, body)` POSTs to the /api/keeper function;
// if it is unavailable (local dev, offline) we fall back to the user signing
// these steps client-side — the proven path — so a bridge is never blocked.
// ---------------------------------------------------------------------------
async function keeperAvailable(keeper) {
  try {
    const r = await keeper("ping", {});
    return !!(r && r.ok);
  } catch {
    return false;
  }
}

// Client-side mirror of the keeper's burn-tx recovery: the app's RPCs differ
// from the keeper's, so each side covers the other's getLogs blind spots. One
// wide-range query, then a newest-first chunked scan (free tiers cap ranges
// differently). Window/chunk per chain: 50k blocks ≈ 7 days on ETH Sepolia but
// only hours on Arb Sepolia (sub-second blocks).
async function recoverSettleTx(publicClientSource, route, epochId) {
  try {
    const { window, chunk } =
      route.srcChainId === 421614 ? { window: 600_000n, chunk: 45_000n } : { window: 50_000n, chunk: 9_500n };
    const tip = await publicClientSource.getBlockNumber();
    const from = tip > window ? tip - window : 0n;
    const query = async (fromBlock, toBlock) => {
      const logs = await publicClientSource.getContractEvents({
        address: route.batcher, abi: BATCHER_ABI, eventName: "EpochSettled",
        args: { epochId }, fromBlock, toBlock,
      });
      return logs[logs.length - 1]?.transactionHash ?? null;
    };
    try { return await query(from, "latest"); } catch { /* wide range rejected — chunk */ }
    for (let hi = tip; hi > from; ) {
      const lo = hi - chunk + 1n > from ? hi - chunk + 1n : from;
      const h = await query(lo, hi);
      if (h) return h;
      if (lo <= from) break;
      hi = lo - 1n;
    }
  } catch { /* fall through to null */ }
  return null;
}

async function runKeeperBackHalf({ keeper, route, epochId, total, step, waitSrc, waitDst, SRC, DST, SRC_DOMAIN, publicClientSource }) {
  const eid = epochId.toString();
  const dir = route.key;

  step("close", "active", "keeper closing the epoch — no signature needed");
  const c = await keeper("close", { direction: dir, epochId: eid });
  if (c?.hash) await waitSrc(c.hash);
  step("close", "done", "epoch closed by the keeper", c?.hash, SRC);

  step("settle", "active", "keeper settling + bridging via CCTP…");
  const s = await keeper("settle", { direction: dir, epochId: eid });
  if (s?.hash) await waitSrc(s.hash);
  let settleTxHash = s?.hash;
  if (!settleTxHash && publicClientSource) {
    // Already-settled epoch whose burn tx the keeper couldn't recover from its
    // own RPCs — retry the log lookup through the app's RPC transport.
    step("settle", "active", "recovering the burn tx from logs (app RPC)…");
    settleTxHash = await recoverSettleTx(publicClientSource, route, BigInt(eid));
  }
  if (!settleTxHash) {
    // Fail fast instead of polling Iris with no tx hash.
    throw new Error("epoch already settled but the burn tx could not be recovered — retry shortly (or set a private RPC for the keeper)");
  }
  step("settle", "done", `settled + burned by the keeper · A=${s?.aggregate ?? total.toString()}`, settleTxHash, SRC);

  step("relay-attest", "active", "keeper polling Circle Iris for the attestation…");
  let att = { status: "pending" };
  const t0 = Date.now();
  while (Date.now() - t0 < 300_000) {
    att = await keeper("attest", { direction: dir, domain: SRC_DOMAIN, txHash: settleTxHash });
    if (att?.status === "complete") break;
    step("relay-attest", "active", `keeper waiting for attestation… (${Math.round((Date.now() - t0) / 1000)}s)`);
    await sleep(3000);
  }
  if (att?.status !== "complete") throw new Error("Iris attestation timeout (keeper)");
  step("relay-attest", "done", "attestation received");

  step("switch-arb-relay", "done", "handled by the keeper — no network switch needed");
  step("relay", "active", "keeper relaying the mint + running the integrity check…");
  const rc = await keeper("relaycheck", { direction: dir, epochId: eid, message: att.message, attestation: att.attestation });
  step("relay", "done", "mint relayed by the keeper", rc?.relayHash, DST);
  step("check", "done", "integrity check computed on-chain (Sum == A)", rc?.checkHash, DST);

  step("finalize", "active", "keeper revealing the check result + finalizing…");
  const f = await keeper("finalize", { direction: dir, epochId: eid });
  if (f?.checkFailed) throw new Error(`integrity check failed (Sum != A): revealed ${f.value} (expected 1)`);
  if (f?.hash) await waitDst(f.hash);
  step("finalize", "done", "confidential distribution complete (keeper)", f?.hash, DST);

  // Report the TRUE public aggregate A revealed at settle (user amount + the
  // fillers), not just the user's own total — the recap shows the real A.
  let aggregate = total;
  try { if (s?.aggregate != null) aggregate = BigInt(s.aggregate); } catch { /* keep total */ }
  return { settleTxHash, aggregate };
}

/**
 * Resume a stuck/in-flight bridge from the Track tab: state-aware, keeper-driven,
 * requires NO wallet signature (every remaining step is permissionless). Reads the
 * epoch state on both legs and continues from wherever it stopped:
 *   src Open(3+)/Closed/Settled -> close/settle -> Iris -> relay+check -> finalize
 *   dst Received/CheckPending   -> check/finalize only
 * Throws with an actionable message when resume is impossible (batch not full,
 * keeper down, or the epoch is already terminal).
 */
export async function resumeConfidentialBridge({ keeper, route, epochId, publicClientSource, publicClientDest, onStep }) {
  const step = (key, status, detail, txHash, chainId) => onStep?.(key, status, detail, txHash, chainId);
  if (typeof keeper !== "function" || !(await keeperAvailable(keeper))) {
    throw new Error("keeper unreachable — resume runs through the keeper; try again in a moment");
  }
  const eid = BigInt(epochId);
  const waitSrc = (hash) => publicClientSource.waitForTransactionReceipt({ hash });
  const waitDst = (hash) => publicClientDest.waitForTransactionReceipt({ hash });

  // Destination first: if the mint already landed, only check/finalize remain.
  let dstState = 0;
  try {
    const di = await publicClientDest.readContract({
      address: route.distributor, abi: DISTRIBUTOR_ABI, functionName: "epochInfo", args: [eid],
    });
    dstState = Number(di[0]);
  } catch { /* treat as not yet relayed */ }
  if (dstState === 4 || dstState === 6) return { alreadyComplete: true };
  // State 5 (FallbackAttribution) can't be resumed to a confidential distribution
  // — the integrity check already failed and the refund lane owns this epoch.
  if (dstState === 5) {
    throw new Error("this epoch failed its integrity check and is in the refund lane — a recipient can reveal their own claim (requestClaimReveal); it cannot be resumed to distribution");
  }
  // Only Received(2) or CheckPending(3) are resumable on the destination.
  if (dstState === 2 || dstState === 3) {
    step("resume", "active", "mint already relayed — running check + finalize…");
    if (dstState === 2) await keeper("relaycheck", { direction: route.key, epochId: eid.toString(), message: null, attestation: null });
    const f = await keeper("finalize", { direction: route.key, epochId: eid.toString() });
    if (f?.checkFailed) throw new Error(`integrity check failed (Sum != A): revealed ${f.value}`);
    if (f?.hash) await waitDst(f.hash);
    step("resume", "done", "confidential distribution complete");
    return { settleTxHash: null, aggregate: null };
  }

  // Source leg: make sure the batch can actually advance.
  const info = await publicClientSource.readContract({
    address: route.batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [eid],
  });
  const srcState = Number(info[0]);
  if (srcState === 3) return { alreadyComplete: true }; // refunded (terminal)
  if (srcState === 0 && Number(info[1]) < 3) {
    throw new Error(
      `batch not full (${Number(info[1])}/3 deposits) — bridge again to fill it, or withdraw your deposit while the epoch is open`
    );
  }
  return runKeeperBackHalf({
    keeper, route, epochId: eid, total: 0n, step, waitSrc, waitDst,
    SRC: route.srcChainId, DST: route.dstChainId, SRC_DOMAIN: route.srcDomain,
    publicClientSource,
  });
}

/**
 * Run the full confidential cross-chain bridge in the direction described by `route`.
 *
 * @param {object}   o
 * @param {(chainId:number)=>Promise<import('viem').WalletClient>} o.getWalletClient
 *        returns a FRESH wallet client bound to `chainId` (call after each switch).
 * @param {(a:{chainId:number})=>Promise<any>} o.switchChainAsync  switch the wallet.
 * @param {import('viem').PublicClient} o.publicClientSource  source-chain reader.
 * @param {import('viem').PublicClient} o.publicClientDest    destination-chain reader.
 * @param {Array<{recipient:`0x${string}`, amount:bigint}>} o.transfers  length 3.
 * @param {object} o.route  direction: {srcChainId,dstChainId,srcDomain,dstDomain,
 *        batcher,distributor,cusdc,destCusdc,usdc}.
 * @param {(key:string,status:'pending'|'active'|'done'|'error',detail?:string,txHash?:string,chainId?:number)=>void} o.onStep
 * @returns {Promise<{epochId:bigint, aggregate:bigint, settleTxHash:string, revealedBalance?:bigint}>}
 */
export async function runConfidentialBridge({
  getWalletClient,
  switchChainAsync,
  publicClientSource,
  publicClientDest,
  transfers,
  route,
  onStep,
  keeper,
  poolMode = false,
}) {
  const step = (key, status, detail, txHash, chainId) =>
    onStep?.(key, status, detail, txHash, chainId);

  // Direction comes entirely from `route`; the rest of this function is
  // direction-agnostic (same names the body already uses).
  const {
    srcChainId: SRC,
    dstChainId: DST,
    srcDomain: SRC_DOMAIN,
    dstDomain: DST_DOMAIN,
    batcher: BATCHER_ADDRESS,
    distributor: DISTRIBUTOR_ADDRESS,
    cusdc: CUSDC_ADDRESS,
    destCusdc: DEST_CUSDC_ADDRESS,
    usdc: USDC_ADDRESS,
  } = route || {};

  // ---- preflight ---------------------------------------------------------
  if (!BATCHER_ADDRESS || !CUSDC_ADDRESS || !USDC_ADDRESS) {
    throw new Error("Source-leg addresses (batcher / cUSDC / USDC) are not configured.");
  }
  if (!DISTRIBUTOR_ADDRESS || !DEST_CUSDC_ADDRESS) {
    throw new Error("Destination-leg addresses (distributor / dest cUSDC) are not configured.");
  }
  if (!Array.isArray(transfers) || transfers.length !== 3) {
    throw new Error("Exactly 3 transfers are required (k-anonymity floor is 3).");
  }
  for (const t of transfers) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(t.recipient || "")) {
      throw new Error(`Invalid recipient address: ${t.recipient}`);
    }
    if (typeof t.amount !== "bigint" || t.amount <= 0n) {
      throw new Error("Every transfer amount must be a positive USDC amount.");
    }
  }

  const waitSrc = (hash) => publicClientSource.waitForTransactionReceipt({ hash });
  const waitDst = (hash) => publicClientDest.waitForTransactionReceipt({ hash });

  // If a keeper endpoint is reachable, it runs the 5 permissionless steps so the
  // user signs nothing after their deposits. Otherwise the user signs them
  // client-side (the proven path). Decided up front so `closeEpoch` is placed on
  // the right side of the hand-off.
  const useKeeper = typeof keeper === "function" ? await keeperAvailable(keeper) : false;

  // ---- step 1: read current epoch on the SOURCE --------------------------
  step("epoch", "active", "reading current epoch on ETH Sepolia");
  const epochId = await publicClientSource.readContract({
    address: BATCHER_ADDRESS,
    abi: BATCHER_ABI,
    functionName: "currentEpoch",
  });
  step("epoch", "done", `epoch #${epochId.toString()}`);

  // ---- keeper fillers: triggered the moment the bridge starts -------------
  // The keeper contributes the 2 batch fillers from ITS OWN cUSDC (they cycle
  // back to the operator on the destination), so the user only signs THEIR OWN
  // transfer: 1 preRegister + 1 deposit. If the keeper can't fill (offline,
  // liquidity exhausted), we fall back to the classic self-filler mode — the
  // user provides all 3 transfers, exactly the proven flow.
  //
  // POOL MODE (real k=3): no fillers at all — the user deposits ONLY their own
  // transfer and the batch waits for two more independent depositors. Individual
  // amounts are then hidden among three unknowns; strongest privacy this design
  // offers, at the cost of waiting for co-depositors.
  let effective = transfers;
  if (poolMode) {
    effective = [transfers[0]];
    step("prereg-1", "done", "slot reserved for a co-depositor");
    step("prereg-2", "done", "slot reserved for a co-depositor");
    step("deposit-1", "done", "slot reserved for a co-depositor");
    step("deposit-2", "done", "slot reserved for a co-depositor");
  } else if (useKeeper) {
    step("prereg-1", "active", "keeper adding the 2 batch fillers…");
    const f = await keeper("fill", { direction: route.key, epochId: epochId.toString() })
      .catch((e) => ({ error: errMsg(e) }));
    const filled =
      !!f?.preHashes ||
      f?.reason === "already filled" ||
      f?.reason === "epoch already has co-depositors";
    if (filled) {
      effective = [transfers[0]];
      step("prereg-1", "done", "filler pre-registered by the keeper");
      step("prereg-2", "done", "filler pre-registered by the keeper");
      step("deposit-1", "done", "filler deposited by the keeper");
      step("deposit-2", "done", "filler deposited by the keeper");
    } else {
      step("prereg-1", "active", "keeper can't fill — you provide the fillers (classic mode)");
    }
  }
  const total = effective.reduce((a, t) => a + t.amount, 0n);

  // ---- step 2: switch to Arb, pre-register each dst claim ----------------
  // Store each enc.handle as dstHandle_i — it MUST be reused verbatim in the
  // ETH deposit for transfer i (committed-list binding).
  step("switch-arb-pre", "active", "approve the network switch to Arbitrum Sepolia in your wallet");
  await switchChainAsync({ chainId: DST });
  step("switch-arb-pre", "done", "on Arbitrum Sepolia");

  const dstHandles = [];
  try {
    // Encrypt all destination claims off-chain first (no signature), then
    // pre-register them in ONE batched confirmation (or sequentially if the
    // wallet can't batch). Encryption uses the RPC-pinned Nox client — the
    // wallet is only needed for the on-chain writes below.
    const wallet = await getWalletClient(DST);
    const addr = wallet.account?.address ?? wallet.account;
    const handleClient = await noxClientFor(DST, addr, wallet);
    // Encrypt all destination claims off-chain (no signature), then pre-register
    // them all in ONE on-chain tx via preRegisterMany — one wallet confirmation
    // for every transfer, regardless of wallet batching support.
    const recipients = [];
    const handles = [];
    const proofs = [];
    for (let i = 0; i < effective.length; i++) {
      step(`prereg-${i}`, "active", `encrypting transfer ${i + 1}/${effective.length} → ${short(effective[i].recipient)} locally`);
      const enc = await encryptWithRetry(handleClient, effective[i].amount, DISTRIBUTOR_ADDRESS);
      dstHandles[i] = enc.handle;
      recipients.push(effective[i].recipient);
      handles.push(enc.handle);
      proofs.push(enc.handleProof);
    }
    const calls = [{
      address: DISTRIBUTOR_ADDRESS, abi: DISTRIBUTOR_ABI, functionName: "preRegisterMany",
      args: [epochId, recipients, handles, proofs],
      key: "prereg-0", label: `pre-register ${effective.length} transfer${effective.length > 1 ? "s" : ""}`,
    }];
    step("prereg-0", "active", `confirm pre-registration (${effective.length} in one tx)`);
    await runCalls(wallet, waitDst, publicClientDest, DST, calls, step);
    // Mirror the single "done" onto the per-transfer tracker rows.
    for (let i = 1; i < effective.length; i++) step(`prereg-${i}`, "done", "pre-registered (batched)");
  } catch (e) {
    step("prereg-0", "error", errMsg(e));
    throw e;
  }

  // ---- step 3: switch to ETH, fund + deposit each -----------------------
  step("switch-eth", "active", "approve the network switch to Ethereum Sepolia in your wallet");
  await switchChainAsync({ chainId: SRC });
  step("switch-eth", "done", "on Ethereum Sepolia");

  // Source leg built as ONE call list: funding (as needed) + 3 deposits + close.
  // Encrypt off-chain first (no signature), then run it as a single batched
  // confirmation, or sequentially (identical calls, identical order) as fallback.
  let me;
  try {
    const wallet = await getWalletClient(SRC);
    me = wallet.account?.address ?? wallet.account;
    const sourceCalls = [];

    // --- funding: decide approve/wrap/setOperator (append only if needed) ---
    step("fund", "active", "checking confidential cUSDC balance");
    let confBal = 0n;
    let confBalKnown = true; // false only when the read/decrypt itself failed
    try {
      const balHandle = await publicClientSource.readContract({
        address: CUSDC_ADDRESS, abi: CUSDC_ABI, functionName: "confidentialBalanceOf", args: [me],
      });
      if (balHandle && balHandle !== ZERO_BYTES32) {
        // decrypt() signs (private reveal), so it must use the real wallet client
        // — not the RPC-pinned read-only one. Bounded retry so a transient gateway
        // blip doesn't spuriously mark the balance unknown and over-wrap.
        const hc = await createViemHandleClient(wallet);
        let dec, lastErr;
        for (let i = 0; i < 3 && dec === undefined; i++) {
          try { dec = await hc.decrypt(balHandle); } catch (e) { lastErr = e; await sleep(1200 * (i + 1)); }
        }
        if (dec === undefined) throw lastErr;
        confBal = BigInt(dec.value);
      }
    } catch {
      confBal = 0n; // cannot read/decrypt -> assume underfunded (wrap headroom, funds are the user's)
      confBalKnown = false;
    }

    if (confBal < total) {
      const shortfall = total - confBal;
      const usdcBal = await publicClientSource.readContract({
        address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [me],
      });
      if (confBalKnown && usdcBal < shortfall) {
        throw new Error(
          `Not enough USDC on ${route?.srcLabel || "the source chain"}: ` +
            `need ${fmtUsdc(shortfall)} USDC, have ${fmtUsdc(usdcBal)} USDC.`
        );
      }
      // Wrap this bridge's shortfall + headroom for the next, capped by the plain
      // USDC actually held (so wrap can never revert; later bridges skip the wrap).
      const target = shortfall + WRAP_HEADROOM;
      const wrapAmt = usdcBal < target ? usdcBal : target;
      if (wrapAmt > 0n) {
        // Max allowance to our OWN Sourcify-verified wrapper (it can only pull
        // USDC on an explicit wrap()) — standard first-party pattern; one-time.
        const allowance = await publicClientSource.readContract({
          address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "allowance", args: [me, CUSDC_ADDRESS],
        });
        if (allowance < wrapAmt) {
          sourceCalls.push({ address: USDC_ADDRESS, abi: ERC20_ABI, functionName: "approve", args: [CUSDC_ADDRESS, MAX_UINT256], key: "fund", label: "one-time USDC approval (max)" });
        }
        sourceCalls.push({ address: CUSDC_ADDRESS, abi: CUSDC_ABI, functionName: "wrap", args: [me, wrapAmt], key: "fund", label: `wrap ${fmtUsdc(wrapAmt)} USDC → cUSDC` });
      }
    }
    const isOp = await publicClientSource.readContract({
      address: CUSDC_ADDRESS, abi: CUSDC_ABI, functionName: "isOperator", args: [me, BATCHER_ADDRESS],
    });
    if (!isOp) {
      sourceCalls.push({ address: CUSDC_ADDRESS, abi: CUSDC_ABI, functionName: "setOperator", args: [BATCHER_ADDRESS, FAR_FUTURE_EXPIRY], key: "fund", label: "authorize the batcher (setOperator)" });
    }
    if (sourceCalls.length === 0) step("fund", "done", "already funded — no funding transactions needed");

    // --- deposits: encrypt off-chain, reuse the exact dstHandles[i], then
    // deposit them all in ONE tx via depositMany. RPC-pinned Nox client so
    // encryption never depends on the wallet's RPC. ---
    const depHc = await noxClientFor(SRC, me, wallet);
    const depRecipients = [];
    const depHandles = [];
    const depProofs = [];
    for (let i = 0; i < effective.length; i++) {
      step(`deposit-${i}`, "active", `encrypting deposit ${i + 1}/${effective.length} → ${short(effective[i].recipient)} locally`);
      const enc = await encryptWithRetry(depHc, effective[i].amount, BATCHER_ADDRESS);
      depRecipients.push(effective[i].recipient);
      depHandles.push(enc.handle);
      depProofs.push(enc.handleProof);
    }
    sourceCalls.push({
      address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "depositMany",
      args: [depRecipients, depHandles, depProofs, dstHandles.slice(0, effective.length)],
      key: "deposit-0", label: `deposit ${effective.length} transfer${effective.length > 1 ? "s" : ""}`,
    });

    // --- close the epoch (last in the batch: minDepositors is met by the deposits
    // above). Skipped when a keeper drives the back half (it closes) AND in pool
    // mode (the batch is NOT full yet — closing now would revert). ---
    if (!useKeeper && !poolMode) {
      sourceCalls.push({ address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "closeEpoch", args: [], key: "close", label: "close epoch" });
    }

    step("fund", "active", `confirm the source leg — fund + deposit${useKeeper ? "" : " + close"}`);
    await runCalls(wallet, waitSrc, publicClientSource, SRC, sourceCalls, step);
    for (let i = 1; i < effective.length; i++) step(`deposit-${i}`, "done", "deposited (batched)");
  } catch (e) {
    step("fund", "error", errMsg(e));
    throw e;
  }

  // ---- back half: settle -> Iris -> relay+check -> finalize --------------
  // Keeper-driven when available (user signs nothing more), else client-side.
  let settleTxHash;
  let aggregate = total;
  // Wait for the batch to fill before anything closes it:
  //  - keeper mode: the fillers were submitted without receipt waits (seconds);
  //  - pool mode: we are waiting for REAL co-depositors (can take a while —
  //    generous window, live progress, funds withdrawable while Open).
  if (useKeeper || poolMode) {
    const windowMs = poolMode ? 45 * 60_000 : 240_000;
    try {
      const t0 = Date.now();
      for (;;) {
        const info = await publicClientSource.readContract({
          address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId],
        });
        if (Number(info[1]) >= 3 || Number(info[0]) !== 0) break; // full, or already closed by a concurrent flow
        if (Date.now() - t0 > windowMs) {
          throw new Error(
            poolMode
              ? "no co-depositors joined within the window — your deposit stays in the open batch (withdrawable, or Resume from Track once the batch fills)"
              : "the batch never reached 3 deposits — your funds are safe (a deposit can be withdrawn while the epoch is open); please retry in a moment"
          );
        }
        step(
          "close", "active",
          poolMode
            ? `waiting for co-depositors… (${Number(info[1])}/3 in the batch)`
            : `waiting for the fillers to land… (${Number(info[1])}/3 deposits)`
        );
        await sleep(poolMode ? 6000 : 4000);
      }
    } catch (e) {
      step("close", "error", errMsg(e));
      throw e;
    }
  }
  if (useKeeper) {
    const kr = await runKeeperBackHalf({ keeper, route, epochId, total, step, waitSrc, waitDst, SRC, DST, SRC_DOMAIN, publicClientSource });
    settleTxHash = kr.settleTxHash;
    aggregate = kr.aggregate;
  } else {
  // ---- step 5: settle (dual-proof) -> CCTP burn --------------------------
  step("settle", "active", "reading epoch handles + revealing aggregate");
  try {
    const wallet = await getWalletClient(SRC);
    // Pool mode without a keeper: the batch just filled — close it now (it was
    // deliberately left out of the user's source batch).
    if (poolMode) {
      const st = await publicClientSource.readContract({
        address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId],
      });
      if (Number(st[0]) === 0) {
        step("close", "active", "batch full — confirm closeEpoch in wallet");
        try {
          const ch = await writeResilient(
            wallet, publicClientSource,
            { address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "closeEpoch", args: [], account: wallet.account, chain: wallet.chain },
            (n) => step("close", "active", `close · ${n}`)
          );
          await waitSrc(ch);
          step("close", "done", "epoch closed", ch, SRC);
        } catch (ce) {
          // TOCTOU: a co-depositor may have closed it between our read and write
          // (closeEpoch reverts NotOpen). If it's now Closed/Settled, that's fine
          // — proceed. Otherwise it's a real failure.
          const st2 = await publicClientSource.readContract({
            address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId],
          });
          if (Number(st2[0]) === 0) throw ce; // still Open -> genuine failure
          step("close", "done", "already closed by a co-depositor");
        }
      } else {
        step("close", "done", "already closed by a co-depositor");
      }
    }
    // publicDecrypt polls do an on-chain read per attempt — RPC-pinned client.
    const handleClient = await noxClientFor(SRC, me, wallet);

    const [encSum, unwrapReqId] = await publicClientSource.readContract({
      address: BATCHER_ADDRESS,
      abi: BATCHER_ABI,
      functionName: "epochHandles",
      args: [epochId],
    });

    step("settle", "active", "revealing A + unwrap request (KMS)…");
    const [sumRes, unwrapRes] = await Promise.all([
      publicDecryptWithRetry(handleClient, encSum, (d) => step("settle", "active", d)),
      publicDecryptWithRetry(handleClient, unwrapReqId),
    ]);
    step("settle", "active", `revealed A=${sumRes.value.toString()} — computing CCTP fee`);

    // Fee is a fraction of the REAL aggregate A (revealed), not the user's own
    // amount — in pool mode `total` is only this depositor's share.
    aggregate = sumRes.value;
    const maxFee = await computeMaxFee(sumRes.value, SRC_DOMAIN, DST_DOMAIN);

    step("settle", "active", "confirm settleEpoch (burns + bridges) in wallet");
    settleTxHash = await writeResilient(
      wallet, publicClientSource,
      {
        address: BATCHER_ADDRESS,
        abi: BATCHER_ABI,
        functionName: "settleEpoch",
        args: [sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee],
        account: wallet.account,
        chain: wallet.chain,
      },
      (n) => step("settle", "active", `burn · ${n}`)
    );
    step("settle", "active", "confirming burn", settleTxHash, SRC);
    await waitSrc(settleTxHash);
    step("settle", "done", `settled + burned · A=${sumRes.value.toString()}`, settleTxHash, SRC);
  } catch (e) {
    step("settle", "error", errMsg(e));
    throw e;
  }

  // ---- step 6: poll Iris for the burn attestation ------------------------
  let message, attestation;
  step("relay-attest", "active", "polling Circle Iris for the burn attestation…");
  try {
    const res = await fetchAttestation(SRC_DOMAIN, settleTxHash, (d) =>
      step("relay-attest", "active", d)
    );
    message = res.message;
    attestation = res.attestation;
    step("relay-attest", "done", "attestation received");
  } catch (e) {
    step("relay-attest", "error", errMsg(e));
    throw e;
  }

  // ---- step 7: switch to Arb, relay the mint -----------------------------
  step("switch-arb-relay", "active", "approve the network switch to Arbitrum Sepolia in your wallet");
  await switchChainAsync({ chainId: DST });
  step("switch-arb-relay", "done", "on Arbitrum Sepolia");

  // relayReceive + checkEpoch as ONE batch: relay mints A and ingests the claims,
  // then checkEpoch computes Sum == A in the same atomic tx (no off-chain step
  // between them). Falls back to two sequential txs.
  try {
    const wallet = await getWalletClient(DST);
    const calls = [
      { address: DISTRIBUTOR_ADDRESS, abi: DISTRIBUTOR_ABI, functionName: "relayReceive", args: [message, attestation], key: "relay", label: "relay mint (relayReceive)" },
      { address: DISTRIBUTOR_ADDRESS, abi: DISTRIBUTOR_ABI, functionName: "checkEpoch", args: [epochId], key: "check", label: "integrity check (Sum == A)" },
    ];
    step("relay", "active", "confirm relay + integrity check (one signature if your wallet supports batching)");
    await runCalls(wallet, waitDst, publicClientDest, DST, calls, step);
  } catch (e) {
    step("relay", "error", errMsg(e));
    throw e;
  }

  // ---- step 9: reveal the check result, finalize + distribute ------------
  step("finalize", "active", "revealing integrity result (KMS)…");
  try {
    const wallet = await getWalletClient(DST);
    // publicDecrypt polls do an on-chain read per attempt — RPC-pinned client.
    const handleClient = await noxClientFor(DST, me, wallet);

    const checkNum = await publicClientDest.readContract({
      address: DISTRIBUTOR_ADDRESS,
      abi: DISTRIBUTOR_ABI,
      functionName: "checkHandle",
      args: [epochId],
    });
    const checkRes = await publicDecryptWithRetry(handleClient, checkNum, (d) =>
      step("finalize", "active", d)
    );
    if (checkRes.value !== 1n) {
      throw new Error(`integrity check failed (Sum != A): revealed ${checkRes.value.toString()} (expected 1)`);
    }

    step("finalize", "active", "check == 1 (ok) · confirm finalizeEpoch in wallet");
    const hash = await writeResilient(
      wallet, publicClientDest,
      {
        address: DISTRIBUTOR_ADDRESS,
        abi: DISTRIBUTOR_ABI,
        functionName: "finalizeEpoch",
        args: [epochId, checkRes.decryptionProof],
        account: wallet.account,
        chain: wallet.chain,
      },
      (n) => step("finalize", "active", `distribution · ${n}`)
    );
    step("finalize", "active", "confirming distribution", hash, DST);
    await waitDst(hash);

    // Confirm the distributor reached Distributed (state 4).
    try {
      const di = await publicClientDest.readContract({
        address: DISTRIBUTOR_ADDRESS,
        abi: DISTRIBUTOR_ABI,
        functionName: "epochInfo",
        args: [epochId],
      });
      aggregate = BigInt(di[1] ?? total);
    } catch {
      /* best-effort */
    }
    step("finalize", "done", "confidential distribution complete on Arbitrum", hash, DST);
  } catch (e) {
    step("finalize", "error", errMsg(e));
    throw e;
  }
  } // end client-side back half

  // ---- step 10: decrypt the recipient's Arb cUSDC balance (proof) --------
  let revealedBalance;
  step("done", "active", "confirming confidential credit on Arbitrum");
  try {
    let wallet = await getWalletClient(DST);
    const meDst = wallet.account?.address ?? wallet.account;
    // Only self-transfers can be locally decrypted by the connected wallet.
    const selfCredited = effective.some(
      (t) => t.recipient?.toLowerCase() === String(meDst).toLowerCase()
    );
    // In keeper mode the wallet never left the source chain; a self-recipient
    // must switch to the destination to decrypt their own balance (a network
    // switch, not a signature).
    if (useKeeper && selfCredited) {
      await switchChainAsync({ chainId: DST });
      wallet = await getWalletClient(DST);
    }
    if (selfCredited) {
      const balHandle = await publicClientDest.readContract({
        address: DEST_CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "confidentialBalanceOf",
        args: [meDst],
      });
      if (balHandle && balHandle !== ZERO_BYTES32) {
        const handleClient = await createViemHandleClient(wallet);
        const dec = await handleClient.decrypt(balHandle);
        revealedBalance = BigInt(dec.value);
        step("done", "done", `confidential cUSDC balance on Arbitrum = ${revealedBalance.toString()} base units`);
      } else {
        step("done", "done", "distributed — balance handle not yet readable");
      }
    } else {
      step("done", "done", "distributed — recipients differ from your address; each recipient decrypts their own balance");
    }
  } catch (e) {
    // Best-effort: distribution already succeeded; balance decrypt is a nicety.
    step("done", "done", `distributed (balance decrypt skipped: ${errMsg(e)})`);
  }

  return { epochId, aggregate, settleTxHash, revealedBalance };
}

// ---------------------------------------------------------------------------
function short(a) {
  if (!a) return "";
  const s = String(a);
  return s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`;
}
function errMsg(e) {
  const raw = e?.shortMessage || e?.message || String(e) || "step failed";
  // A rate-limit here is the wallet's OWN RPC throttling (it broadcasts through
  // it), not the app's. Turn the cryptic provider error into a concrete fix.
  if (/rate.?limit|too many requests|429|limit exceeded/i.test(raw)) {
    return (
      "Your wallet's RPC for this network is rate-limited (it broadcasts through its own RPC, not the app's). " +
      "Point it at a reliable endpoint and retry — Rabby: More → Modify RPC URL for this network; MetaMask: Settings → Networks. " +
      "Sepolia: https://ethereum-sepolia-rpc.publicnode.com · Arbitrum Sepolia: https://arbitrum-sepolia-rpc.publicnode.com"
    );
  }
  return raw.slice(0, 240);
}
/** Format USDC base units (6 decimals) as a human-readable decimal string. */
function fmtUsdc(v) {
  const s = v.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/0+$/, "").replace(/\.$/, "");
}
