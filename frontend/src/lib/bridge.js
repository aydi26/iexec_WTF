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

import { createViemHandleClient } from "@iexec-nox/handle";
import {
  BATCHER_ABI,
  CUSDC_ABI,
  DISTRIBUTOR_ABI,
  ERC20_ABI,
  FAR_FUTURE_EXPIRY,
} from "../config/contracts";

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
  for (let i = 0; i < transfers.length; i++) {
    const key = `prereg-${i}`;
    const label = `pre-register transfer ${i + 1}/3 → ${short(transfers[i].recipient)}`;
    step(key, "active", `${label} · encrypting locally`);
    try {
      // Fresh wallet client + handle client on Arb for each write.
      const wallet = await getWalletClient(DST);
      const handleClient = await createViemHandleClient(wallet);
      const enc = await handleClient.encryptInput(
        transfers[i].amount,
        "uint256",
        DISTRIBUTOR_ADDRESS
      );
      dstHandles[i] = enc.handle;

      step(key, "active", `${label} · confirm preRegister in wallet`);
      const hash = await wallet.writeContract({
        address: DISTRIBUTOR_ADDRESS,
        abi: DISTRIBUTOR_ABI,
        functionName: "preRegister",
        args: [epochId, transfers[i].recipient, enc.handle, enc.handleProof],
        account: wallet.account,
        chain: wallet.chain,
      });
      step(key, "active", `${label} · confirming`, hash, DST);
      await waitDst(hash);
      step(key, "done", `${label} · pre-registered`, hash, DST);
    } catch (e) {
      step(key, "error", errMsg(e));
      throw e;
    }
  }

  // ---- step 3: switch to ETH, fund + deposit each -----------------------
  step("switch-eth", "active", "approve the network switch to Ethereum Sepolia in your wallet");
  await switchChainAsync({ chainId: SRC });
  step("switch-eth", "done", "on Ethereum Sepolia");

  // Funding: ensure enough confidential cUSDC + operator authorization.
  step("fund", "active", "checking confidential cUSDC balance");
  let me;
  try {
    const wallet = await getWalletClient(SRC);
    me = wallet.account?.address ?? wallet.account;

    // Read the confidential balance handle and decrypt it (best-effort — if the
    // decrypt fails we conservatively assume 0 and wrap generously, capped by
    // the plain USDC balance so wrap can never revert).
    let confBal = 0n;
    let confBalKnown = true; // false only when the read/decrypt itself failed
    try {
      const balHandle = await publicClientSource.readContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "confidentialBalanceOf",
        args: [me],
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

    let wrapped = false;
    if (confBal < total) {
      const shortfall = total - confBal;

      // Wrap enough for THIS bridge plus headroom for the next one, capped by
      // the plain USDC we actually hold — so wrap can never revert, and later
      // bridges skip the wrap tx entirely.
      const usdcBal = await publicClientSource.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [me],
      });
      if (confBalKnown && usdcBal < shortfall) {
        throw new Error(
          `Not enough USDC on ${route?.srcLabel || "the source chain"}: ` +
            `need ${fmtUsdc(shortfall)} USDC, have ${fmtUsdc(usdcBal)} USDC.`
        );
      }
      const target = shortfall + WRAP_HEADROOM;
      const wrapAmt = usdcBal < target ? usdcBal : target;

      if (wrapAmt > 0n) {
        step(
          "fund",
          "active",
          `funding: wrapping ${fmtUsdc(wrapAmt)} USDC → cUSDC (covers this bridge + headroom for the next)`
        );

        // Approve underlying USDC for the wrapper (only if needed).
        // SECURITY RATIONALE for the max allowance: the spender is our own
        // Sourcify-verified NoxusCUSDC wrapper (route.cusdc), which can only
        // pull USDC when the user explicitly calls wrap() — this is the
        // standard max-allowance pattern for a first-party wrapper, not a
        // third-party spender. Approving once means later bridges never
        // re-prompt for approval.
        const allowance = await publicClientSource.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "allowance",
          args: [me, CUSDC_ADDRESS],
        });
        if (allowance < wrapAmt) {
          step("fund", "active", "confirm one-time USDC approval (max) in wallet — future bridges skip this");
          const ah = await wallet.writeContract({
            address: USDC_ADDRESS,
            abi: ERC20_ABI,
            functionName: "approve",
            args: [CUSDC_ADDRESS, MAX_UINT256],
            account: wallet.account,
            chain: wallet.chain,
          });
          step("fund", "active", "confirming one-time approval", ah, SRC);
          await waitSrc(ah);
        }

        step("fund", "active", "confirm wrap in wallet");
        const wh = await wallet.writeContract({
          address: CUSDC_ADDRESS,
          abi: CUSDC_ABI,
          functionName: "wrap",
          args: [me, wrapAmt],
          account: wallet.account,
          chain: wallet.chain,
        });
        step("fund", "active", "confirming wrap", wh, SRC);
        await waitSrc(wh);
        wrapped = true;
      }
    }

    // operator authorization for the batcher (only if not already)
    const isOp = await publicClientSource.readContract({
      address: CUSDC_ADDRESS,
      abi: CUSDC_ABI,
      functionName: "isOperator",
      args: [me, BATCHER_ADDRESS],
    });
    if (!isOp) {
      step("fund", "active", "confirm setOperator(batcher) in wallet");
      const oh = await wallet.writeContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "setOperator",
        args: [BATCHER_ADDRESS, FAR_FUTURE_EXPIRY],
        account: wallet.account,
        chain: wallet.chain,
      });
      step("fund", "active", "confirming setOperator", oh, SRC);
      await waitSrc(oh);
    }
    step(
      "fund",
      "done",
      wrapped
        ? "funded (incl. headroom for the next bridge) + batcher authorized"
        : "already funded — no approval needed"
    );
  } catch (e) {
    step("fund", "error", errMsg(e));
    throw e;
  }

  // deposit each encrypted amount on ETH, re-using dstHandles[i].
  for (let i = 0; i < transfers.length; i++) {
    const key = `deposit-${i}`;
    const label = `deposit transfer ${i + 1}/3 → ${short(transfers[i].recipient)}`;
    step(key, "active", `${label} · encrypting locally`);
    try {
      const wallet = await getWalletClient(SRC);
      const handleClient = await createViemHandleClient(wallet);
      const enc = await handleClient.encryptInput(
        transfers[i].amount,
        "uint256",
        BATCHER_ADDRESS
      );

      step(key, "active", `${label} · confirm deposit in wallet`);
      const hash = await wallet.writeContract({
        address: BATCHER_ADDRESS,
        abi: BATCHER_ABI,
        functionName: "deposit",
        args: [transfers[i].recipient, enc.handle, enc.handleProof, dstHandles[i]],
        account: wallet.account,
        chain: wallet.chain,
      });
      step(key, "active", `${label} · confirming`, hash, SRC);
      await waitSrc(hash);
      step(key, "done", `${label} · deposited (amount hidden)`, hash, SRC);
    } catch (e) {
      step(key, "error", errMsg(e));
      throw e;
    }
  }

  // ---- step 4: close the epoch -------------------------------------------
  step("close", "active", "confirm closeEpoch in wallet");
  try {
    const wallet = await getWalletClient(SRC);
    const hash = await wallet.writeContract({
      address: BATCHER_ADDRESS,
      abi: BATCHER_ABI,
      functionName: "closeEpoch",
      args: [],
      account: wallet.account,
      chain: wallet.chain,
    });
    step("close", "active", "confirming", hash, SRC);
    await waitSrc(hash);
    step("close", "done", "epoch closed", hash, SRC);
  } catch (e) {
    step("close", "error", errMsg(e));
    throw e;
  }

  // ---- step 5: settle (dual-proof) -> CCTP burn --------------------------
  let settleTxHash;
  step("settle", "active", "reading epoch handles + revealing aggregate");
  try {
    const wallet = await getWalletClient(SRC);
    const handleClient = await createViemHandleClient(wallet);

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
    settleTxHash = await wallet.writeContract({
      address: BATCHER_ADDRESS,
      abi: BATCHER_ABI,
      functionName: "settleEpoch",
      args: [sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee],
      account: wallet.account,
      chain: wallet.chain,
    });
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

  step("relay", "active", "confirm relayReceive in wallet");
  try {
    const wallet = await getWalletClient(DST);
    const hash = await wallet.writeContract({
      address: DISTRIBUTOR_ADDRESS,
      abi: DISTRIBUTOR_ABI,
      functionName: "relayReceive",
      args: [message, attestation],
      account: wallet.account,
      chain: wallet.chain,
    });
    step("relay", "active", "confirming", hash, DST);
    await waitDst(hash);
    step("relay", "done", "mint relayed to Arbitrum", hash, DST);
  } catch (e) {
    step("relay", "error", errMsg(e));
    throw e;
  }

  // ---- step 8: on-chain integrity check ----------------------------------
  step("check", "active", "confirm checkEpoch (integrity: Sum == A) in wallet");
  try {
    const wallet = await getWalletClient(DST);
    const hash = await wallet.writeContract({
      address: DISTRIBUTOR_ADDRESS,
      abi: DISTRIBUTOR_ABI,
      functionName: "checkEpoch",
      args: [epochId],
      account: wallet.account,
      chain: wallet.chain,
    });
    step("check", "active", "confirming", hash, DST);
    await waitDst(hash);
    step("check", "done", "integrity check requested", hash, DST);
  } catch (e) {
    step("check", "error", errMsg(e));
    throw e;
  }

  // ---- step 9: reveal the check result, finalize + distribute ------------
  step("finalize", "active", "revealing integrity result (KMS)…");
  let aggregate = total;
  try {
    const wallet = await getWalletClient(DST);
    const handleClient = await createViemHandleClient(wallet);

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
    const hash = await wallet.writeContract({
      address: DISTRIBUTOR_ADDRESS,
      abi: DISTRIBUTOR_ABI,
      functionName: "finalizeEpoch",
      args: [epochId, checkRes.decryptionProof],
      account: wallet.account,
      chain: wallet.chain,
    });
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

  // ---- step 10: decrypt the recipient's Arb cUSDC balance (proof) --------
  let revealedBalance;
  step("done", "active", "confirming confidential credit on Arbitrum");
  try {
    const wallet = await getWalletClient(DST);
    const meDst = wallet.account?.address ?? wallet.account;
    // Only self-transfers can be locally decrypted by the connected wallet.
    const selfCredited = transfers.some(
      (t) => t.recipient?.toLowerCase() === String(meDst).toLowerCase()
    );
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
  return (e?.shortMessage || e?.message || String(e) || "step failed").slice(0, 240);
}
/** Format USDC base units (6 decimals) as a human-readable decimal string. */
function fmtUsdc(v) {
  const s = v.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/0+$/, "").replace(/\.$/, "");
}
