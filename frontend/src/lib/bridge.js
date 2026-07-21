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

/** Live fast fee (bps) for src->dst from Iris, with a safety multiple. */
async function computeMaxFee(amount, srcDomain, dstDomain) {
  try {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, {
      signal: AbortSignal.timeout(15000),
    });
    const arr = await r.json();
    const fast = arr.find((x) => x.finalityThreshold <= 1000) ?? arr[0];
    const bps = BigInt(Math.ceil((fast?.minimumFee ?? 1) * 100));
    // maxFee = ceil(amount * bps / 1e6) * 3 (margin), min 1  [bps*100/1e6 = bps/1e4]
    const fee = (amount * bps + 999_999n) / 1_000_000n;
    return fee * 3n > 0n ? fee * 3n : 1n;
  } catch (e) {
    if (isCorsLikeError(e)) {
      // Fall back to a safe on-chain fee estimate (10 bps) so a CORS-blocked
      // fee lookup does not abort the whole flow. The relay leg (which also
      // needs Iris) will surface the CORS guidance if it is truly blocked.
      return amount / 1000n > 0n ? amount / 1000n : 1n;
    }
    return amount / 1000n > 0n ? amount / 1000n : 1n; // fallback 10 bps
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
function noxClientFor(chainId, address) {
  const key = `${chainId}:${String(address).toLowerCase()}`;
  if (!noxClientCache.has(key)) {
    const account = toAccount({
      address,
      async signMessage() { throw new Error("read-only Nox client cannot sign"); },
      async signTransaction() { throw new Error("read-only Nox client cannot sign"); },
      async signTypedData() { throw new Error("read-only Nox client cannot sign"); },
    });
    const client = createWalletClient({
      account,
      chain: CHAIN_DEF[chainId],
      transport: fallback(RPC_URLS[chainId].map((u) => http(u))),
    });
    // Cache the promise; evict on failure so a transient error doesn't poison
    // every later call with the same rejected promise.
    const p = createViemHandleClient(client).catch((e) => {
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

// writeContract with a bounded retry on transient RPC / rate-limit errors. The
// nonce guard makes retrying safe: if the account nonce advanced after the error,
// a tx already went out, so we STOP (surface the error) rather than risk a
// double-send. User-rejections and real reverts are never retried.
async function writeResilient(wallet, pub, params, onNote) {
  const addr = params.account?.address ?? params.account;
  for (let attempt = 0; ; attempt++) {
    let nonceBefore = null;
    try {
      if (pub && addr) nonceBefore = await pub.getTransactionCount({ address: addr, blockTag: "pending" });
    } catch { /* best-effort */ }
    try {
      return await wallet.writeContract(params);
    } catch (e) {
      if (isUserReject(e) || !isTransientRpc(e) || attempt >= 3) throw e;
      // Did a tx land despite the RPC error? If so, don't re-send.
      if (pub && addr && nonceBefore != null) {
        await sleep(2500);
        let after = null;
        try { after = await pub.getTransactionCount({ address: addr, blockTag: "latest" }); } catch { /* ignore */ }
        if (after != null && after > nonceBefore) throw e;
      }
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
  if (!id) throw new Error("Batched transaction submitted but no bundle id was returned — please retry.");
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

async function runKeeperBackHalf({ keeper, route, epochId, total, step, waitSrc, waitDst, SRC, DST, SRC_DOMAIN }) {
  const eid = epochId.toString();
  const dir = route.key;

  step("close", "active", "keeper closing the epoch — no signature needed");
  const c = await keeper("close", { direction: dir, epochId: eid });
  if (c?.hash) await waitSrc(c.hash);
  step("close", "done", "epoch closed by the keeper", c?.hash, SRC);

  step("settle", "active", "keeper settling + bridging via CCTP…");
  const s = await keeper("settle", { direction: dir, epochId: eid });
  if (s?.hash) await waitSrc(s.hash);
  const settleTxHash = s?.hash;
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

  return { settleTxHash, aggregate: total };
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

  const total = transfers.reduce((a, t) => a + t.amount, 0n);

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
  step("epoch", "done", `epoch #${epochId.toString()} · A total ${total.toString()} base units`);

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
    const handleClient = await noxClientFor(DST, addr);
    const calls = [];
    for (let i = 0; i < transfers.length; i++) {
      step(`prereg-${i}`, "active", `pre-register transfer ${i + 1}/3 → ${short(transfers[i].recipient)} · encrypting locally`);
      const enc = await encryptWithRetry(handleClient, transfers[i].amount, DISTRIBUTOR_ADDRESS);
      dstHandles[i] = enc.handle;
      calls.push({
        address: DISTRIBUTOR_ADDRESS, abi: DISTRIBUTOR_ABI, functionName: "preRegister",
        args: [epochId, transfers[i].recipient, enc.handle, enc.handleProof],
        key: `prereg-${i}`, label: `pre-register → ${short(transfers[i].recipient)}`,
      });
    }
    step("prereg-0", "active", "confirm the pre-registrations (one signature if your wallet supports batching)");
    await runCalls(wallet, waitDst, publicClientDest, DST, calls, step);
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
        const hc = await createViemHandleClient(wallet);
        const dec = await hc.decrypt(balHandle);
        confBal = BigInt(dec.value);
      }
    } catch {
      confBal = 0n; // cannot read/decrypt -> assume underfunded
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

    // --- deposits: encrypt off-chain, reuse the exact dstHandles[i] ---
    // RPC-pinned Nox client: encryption must never depend on the wallet's RPC.
    const depHc = await noxClientFor(SRC, me);
    for (let i = 0; i < transfers.length; i++) {
      step(`deposit-${i}`, "active", `deposit transfer ${i + 1}/3 → ${short(transfers[i].recipient)} · encrypting locally`);
      const enc = await encryptWithRetry(depHc, transfers[i].amount, BATCHER_ADDRESS);
      sourceCalls.push({ address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "deposit", args: [transfers[i].recipient, enc.handle, enc.handleProof, dstHandles[i]], key: `deposit-${i}`, label: `deposit → ${short(transfers[i].recipient)}` });
    }

    // --- close the epoch (last in the batch: minDepositors is met by the deposits
    // above). Skipped here when a keeper is driving the back half — it closes. ---
    if (!useKeeper) {
      sourceCalls.push({ address: BATCHER_ADDRESS, abi: BATCHER_ABI, functionName: "closeEpoch", args: [], key: "close", label: "close epoch" });
    }

    step("fund", "active", `confirm the source leg — wrap + deposits${useKeeper ? "" : " + close"} (one signature if your wallet supports batching)`);
    await runCalls(wallet, waitSrc, publicClientSource, SRC, sourceCalls, step);
  } catch (e) {
    step("fund", "error", errMsg(e));
    throw e;
  }

  // ---- back half: settle -> Iris -> relay+check -> finalize --------------
  // Keeper-driven when available (user signs nothing more), else client-side.
  let settleTxHash;
  let aggregate = total;
  if (useKeeper) {
    const kr = await runKeeperBackHalf({ keeper, route, epochId, total, step, waitSrc, waitDst, SRC, DST, SRC_DOMAIN });
    settleTxHash = kr.settleTxHash;
    aggregate = kr.aggregate;
  } else {
  // ---- step 5: settle (dual-proof) -> CCTP burn --------------------------
  step("settle", "active", "reading epoch handles + revealing aggregate");
  try {
    const wallet = await getWalletClient(SRC);
    // publicDecrypt polls do an on-chain read per attempt — RPC-pinned client.
    const handleClient = await noxClientFor(SRC, me);

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

    const maxFee = await computeMaxFee(total, SRC_DOMAIN, DST_DOMAIN);

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
    const handleClient = await noxClientFor(DST, me);

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
    const selfCredited = transfers.some(
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
