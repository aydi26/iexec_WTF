// ============================================================================
// Confidential deposit (source leg — ETH Sepolia)
//   1. approve USDC -> CUSDC wrapper
//   2. cusdc.wrap(me, amount)
//   3. cusdc.setOperator(batcher, FAR_FUTURE_EXPIRY)   (skipped if already op)
//   4. encryptAmount(walletClient, amountUnits, BATCHER_ADDRESS)  [client-side]
//   5. batcher.deposit(recipient, handle, handleProof, dstHandle)
// The plaintext amount is encrypted in the browser (step 4) before it is ever
// submitted on-chain — emphasised in the UI.
// ============================================================================
import { useState, useEffect } from "react";
import {
  useAccount,
  useWalletClient,
  usePublicClient,
} from "wagmi";
import {
  CHAIN_IDS,
  BATCHER_ADDRESS,
  CUSDC_ADDRESS,
  USDC_ADDRESS,
  CUSDC_ABI,
  BATCHER_ABI,
  ERC20_ABI,
  FAR_FUTURE_EXPIRY,
  txUrl,
} from "../../config/contracts";
import { encryptAmount } from "../../lib/nox";
import { parseUsdc, formatUsdc, isHex, ZERO_BYTES32 } from "./format";
import { ChainGuard, LockIcon, TxStatus, useTxAction, shorten } from "./shared";

const STEP_LABELS = [
  "Approve USDC",
  "Wrap → cUSDC",
  "Authorize batcher",
  "Encrypt amount (client-side)",
  "Submit deposit",
];

export default function DepositView() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: CHAIN_IDS.SOURCE });

  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState(""); // dst recipient (defaults to me)
  const [dstHandle, setDstHandle] = useState(""); // optional Arb pre-registration handle
  const [phase, setPhase] = useState("idle"); // idle | running | done | failed
  const [stepIdx, setStepIdx] = useState(-1); // active step (0..4), -1 idle
  const [error, setError] = useState(null);
  const [depositHandle, setDepositHandle] = useState(null); // the encrypted handle we submitted
  const [usdcBalance, setUsdcBalance] = useState(null);

  // Per-step tx status objects (so each shows its own hash + explorer link).
  const approveTx = useTxAction(CHAIN_IDS.SOURCE);
  const wrapTx = useTxAction(CHAIN_IDS.SOURCE);
  const operatorTx = useTxAction(CHAIN_IDS.SOURCE);
  const depositTx = useTxAction(CHAIN_IDS.SOURCE);

  const units = parseUsdc(amount);
  const configReady = !!BATCHER_ADDRESS && !!CUSDC_ADDRESS && !!USDC_ADDRESS;

  // Read underlying USDC balance (display only).
  useEffect(() => {
    let stale = false;
    if (!address || !publicClient || !USDC_ADDRESS) return;
    publicClient
      .readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
      })
      .then((b) => !stale && setUsdcBalance(b))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [address, publicClient, phase]);

  const wait = (hash) => publicClient.waitForTransactionReceipt({ hash });

  const resetAll = () => {
    approveTx.reset();
    wrapTx.reset();
    operatorTx.reset();
    depositTx.reset();
    setError(null);
    setDepositHandle(null);
    setStepIdx(-1);
    setPhase("idle");
  };

  async function runDeposit() {
    if (!walletClient || !publicClient) return;
    if (!units || units <= 0n) {
      setError("Enter a valid USDC amount.");
      return;
    }
    const dstRecipient = recipient.trim() || address;
    if (!isHex(dstRecipient, 20)) {
      setError("Recipient must be a 20-byte address (0x…).");
      return;
    }
    const dstHandleArg = dstHandle.trim() || ZERO_BYTES32;
    if (!isHex(dstHandleArg, 32)) {
      setError("Destination handle must be empty or a 32-byte value (0x…).");
      return;
    }

    setError(null);
    setPhase("running");
    approveTx.reset();
    wrapTx.reset();
    operatorTx.reset();
    depositTx.reset();

    try {
      // 1. Approve underlying USDC for the cUSDC wrapper to pull.
      setStepIdx(0);
      const allowance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [address, CUSDC_ADDRESS],
      });
      if (allowance < units) {
        await approveTx.run(
          () =>
            walletClient.writeContract({
              address: USDC_ADDRESS,
              abi: ERC20_ABI,
              functionName: "approve",
              args: [CUSDC_ADDRESS, units],
              account: address,
            }),
          { wait }
        );
      }

      // 2. Wrap USDC into confidential cUSDC held by `me`.
      setStepIdx(1);
      await wrapTx.run(
        () =>
          walletClient.writeContract({
            address: CUSDC_ADDRESS,
            abi: CUSDC_ABI,
            functionName: "wrap",
            args: [address, units],
            account: address,
          }),
        { wait }
      );

      // 3. Authorize the batcher as operator (only if not already).
      setStepIdx(2);
      const alreadyOperator = await publicClient.readContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "isOperator",
        args: [address, BATCHER_ADDRESS],
      });
      if (!alreadyOperator) {
        await operatorTx.run(
          () =>
            walletClient.writeContract({
              address: CUSDC_ADDRESS,
              abi: CUSDC_ABI,
              functionName: "setOperator",
              args: [BATCHER_ADDRESS, FAR_FUTURE_EXPIRY],
              account: address,
            }),
          { wait }
        );
      }

      // 4. Encrypt the amount CLIENT-SIDE, bound to the batcher app contract.
      setStepIdx(3);
      const { handle, handleProof } = await encryptAmount(
        walletClient,
        units,
        BATCHER_ADDRESS
      );
      setDepositHandle(handle);

      // 5. Submit the confidential deposit.
      setStepIdx(4);
      await depositTx.run(
        () =>
          walletClient.writeContract({
            address: BATCHER_ADDRESS,
            abi: BATCHER_ABI,
            functionName: "deposit",
            args: [dstRecipient, handle, handleProof, dstHandleArg],
            account: address,
          }),
        { wait }
      );

      setPhase("done");
      setStepIdx(5);
    } catch (err) {
      setError(err?.shortMessage || err?.message?.slice(0, 220) || "Deposit failed");
      setPhase("failed");
    }
  }

  const guard = <ChainGuard requiredChainId={CHAIN_IDS.SOURCE} chainName="ETH Sepolia" />;
  const busy = phase === "running";

  const stepStatus = (i) => {
    if (phase === "failed" && i === stepIdx) return "failed";
    if (i < stepIdx) return "done";
    if (i === stepIdx && busy) return "active";
    if (phase === "done") return "done";
    return "";
  };

  return (
    <div>
      <div className="mf-view-title">Confidential deposit</div>
      <div className="mf-view-desc">
        Wrap USDC into confidential cUSDC and deposit it into the current epoch.
        Your amount is encrypted in <strong>your browser</strong> before it is
        ever sent on-chain — the network only sees an opaque handle.
      </div>

      {guard}

      {!configReady && (
        <div className="mf-note todo">
          Source-leg addresses are not configured (missing deployment). Deposit is
          disabled.
        </div>
      )}

      {isConnected && configReady && (
        <>
          <div className="mf-card">
            <span className="mf-label">Amount</span>
            <input
              className="mf-input-big"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value;
                if (/^\d*\.?\d*$/.test(v)) setAmount(v);
              }}
            />
            <div className="mf-row" style={{ padding: "6px 0 0" }}>
              <span className="k">USDC (6 decimals)</span>
              <span className="v">
                {usdcBalance != null ? (
                  <button
                    className="mf-btn ghost sm"
                    style={{ padding: "3px 10px", fontSize: 11 }}
                    disabled={busy}
                    onClick={() => setAmount(formatUsdc(usdcBalance))}
                  >
                    bal {formatUsdc(usdcBalance, 2)} · Max
                  </button>
                ) : (
                  "…"
                )}
              </span>
            </div>
            {units != null && (
              <div className="mf-hint">= {units.toString()} base units</div>
            )}
          </div>

          <div className="mf-field">
            <label className="mf-field-label">
              Destination recipient (Arb Sepolia) — defaults to your address
            </label>
            <input
              className="mf-input mono"
              placeholder={address || "0x…"}
              value={recipient}
              disabled={busy}
              onChange={(e) => setRecipient(e.target.value)}
            />
          </div>

          <div className="mf-field">
            <label className="mf-field-label">
              Destination handle (optional Arb pre-registration) — defaults to 0x00…00
            </label>
            <input
              className="mf-input mono"
              placeholder={ZERO_BYTES32}
              value={dstHandle}
              disabled={busy}
              onChange={(e) => setDstHandle(e.target.value)}
            />
          </div>

          <div className="mf-enc-note">
            <LockIcon size={16} />
            <span>
              Step 4 encrypts your amount locally via iExec Nox and binds it to the
              batcher app contract. Only the resulting handle + proof leave your
              browser — the plaintext never does.
            </span>
          </div>

          {(busy || phase === "done" || phase === "failed") && (
            <div className="mf-steps">
              {STEP_LABELS.map((label, i) => {
                const st = stepStatus(i);
                return (
                  <div key={i} className={`mf-step ${st}`}>
                    <div className="mf-step-num">
                      {st === "done" ? "✓" : st === "failed" ? "!" : i + 1}
                    </div>
                    <span className="mf-step-text">{label}</span>
                  </div>
                );
              })}
            </div>
          )}

          <TxStatus label="Approve" {...approveTx} />
          <TxStatus label="Wrap" {...wrapTx} />
          <TxStatus label="Authorize batcher" {...operatorTx} />
          <TxStatus label="Deposit" {...depositTx} />

          {depositHandle && (
            <div className="mf-card" style={{ marginTop: 10 }}>
              <span className="mf-label">Encrypted amount handle</span>
              <div className="mf-tx-hash">{shorten(depositHandle, 14, 12)}</div>
            </div>
          )}

          {error && <div className="mf-error">{error}</div>}
          {phase === "done" && (
            <div className="mf-success">
              Confidential deposit submitted. It joins the open epoch; the public
              aggregate stays hidden until the keeper settles.
              {depositTx.hash && (
                <>
                  {" "}
                  <a
                    href={txUrl(CHAIN_IDS.SOURCE, depositTx.hash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View deposit tx ↗
                  </a>
                </>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            {phase === "done" || phase === "failed" ? (
              <button className="mf-btn ghost" onClick={resetAll}>
                New deposit
              </button>
            ) : (
              <button
                className="mf-btn primary"
                disabled={busy || !units || units <= 0n}
                onClick={runDeposit}
              >
                {busy ? (
                  <>
                    <span className="mf-spinner" /> Depositing…
                  </>
                ) : (
                  "Encrypt & Deposit"
                )}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
