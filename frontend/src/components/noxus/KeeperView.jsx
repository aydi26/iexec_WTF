// ============================================================================
// Keeper panel — operator actions on the batcher, with a tx hash + explorer link
// shown for every action.
//   closeEpoch()  : always driveable from the UI (no off-chain inputs).
//   settleEpoch() : needs off-chain KMS proofs (proofA, proofT). We expose it as
//                   a documented button that fires only when both proofs are
//                   pasted in; otherwise it's clearly marked "run via keeper
//                   script". maxFee is entered in USDC base units.
// ============================================================================
import { useState, useEffect, useCallback } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import {
  CHAIN_IDS,
  BATCHER_ADDRESS,
  BATCHER_ABI,
  EPOCH_STATE,
} from "../../config/contracts";
import { parseUsdc, isHexBytes } from "./format";
import { ChainGuard, TxStatus, useTxAction, epochStateBadge } from "./shared";

export default function KeeperView() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: CHAIN_IDS.SOURCE });

  const [current, setCurrent] = useState(null);
  const [state, setState] = useState(null);

  const [proofA, setProofA] = useState("");
  const [proofT, setProofT] = useState("");
  const [maxFee, setMaxFee] = useState(""); // in USDC (converted to base units)
  const [settleError, setSettleError] = useState(null);

  const closeTx = useTxAction(CHAIN_IDS.SOURCE);
  const settleTx = useTxAction(CHAIN_IDS.SOURCE);
  const ready = !!BATCHER_ADDRESS;

  const refreshEpoch = useCallback(async () => {
    if (!ready || !publicClient) return;
    try {
      const cur = await publicClient.readContract({
        address: BATCHER_ADDRESS,
        abi: BATCHER_ABI,
        functionName: "currentEpoch",
      });
      setCurrent(cur);
      const info = await publicClient.readContract({
        address: BATCHER_ADDRESS,
        abi: BATCHER_ABI,
        functionName: "epochInfo",
        args: [cur],
      });
      setState(Number(info[0]));
    } catch {
      /* ignore read errors here */
    }
  }, [ready, publicClient]);

  useEffect(() => {
    refreshEpoch();
  }, [refreshEpoch, closeTx.isSuccess, settleTx.isSuccess]);

  const wait = (hash) => publicClient.waitForTransactionReceipt({ hash });

  async function closeEpoch() {
    if (!walletClient) return;
    try {
      await closeTx.run(
        () =>
          walletClient.writeContract({
            address: BATCHER_ADDRESS,
            abi: BATCHER_ABI,
            functionName: "closeEpoch",
            args: [],
            account: address,
          }),
        { wait }
      );
      refreshEpoch();
    } catch {
      /* surfaced via tx state */
    }
  }

  const proofsProvided = proofA.trim() !== "" && proofT.trim() !== "";
  const settleValid =
    proofsProvided &&
    isHexBytes(proofA) &&
    isHexBytes(proofT) &&
    parseUsdc(maxFee || "0") != null;

  async function settleEpoch() {
    if (!walletClient) return;
    setSettleError(null);
    if (!proofsProvided) {
      setSettleError("Paste both KMS proofs (proofA, proofT) to settle from the UI, or run the keeper script.");
      return;
    }
    if (!isHexBytes(proofA) || !isHexBytes(proofT)) {
      setSettleError("Proofs must be 0x-prefixed hex bytes.");
      return;
    }
    const feeUnits = parseUsdc(maxFee || "0");
    if (feeUnits == null) {
      setSettleError("maxFee must be a valid USDC amount.");
      return;
    }
    try {
      await settleTx.run(
        () =>
          walletClient.writeContract({
            address: BATCHER_ADDRESS,
            abi: BATCHER_ABI,
            functionName: "settleEpoch",
            args: [proofA.trim(), proofT.trim(), feeUnits],
            account: address,
          }),
        { wait }
      );
      refreshEpoch();
    } catch {
      /* surfaced via tx state */
    }
  }

  return (
    <div>
      <div className="mf-view-title">Keeper panel</div>
      <div className="mf-view-desc">
        Operator actions on the current epoch. Every action shows its tx hash with
        an explorer link. These run on ETH Sepolia.
      </div>

      <ChainGuard requiredChainId={CHAIN_IDS.SOURCE} chainName="ETH Sepolia" />

      {!ready && <div className="mf-note todo">Batcher address not configured.</div>}

      {ready && (
        <>
          <div className="mf-card">
            <div className="mf-row" style={{ padding: 0 }}>
              <span className="k">Current epoch</span>
              <span className="v">
                {current != null ? `#${current.toString()}` : "…"}
              </span>
            </div>
            {state != null && (
              <div className="mf-row">
                <span className="k">State</span>
                <span className="v">{epochStateBadge(state)}</span>
              </div>
            )}
          </div>

          {/* ---- Close epoch ---- */}
          <div className="mf-card">
            <span className="mf-label">Close epoch</span>
            <div className="mf-view-desc" style={{ marginBottom: 10 }}>
              Stops accepting deposits into the current epoch and moves it to
              <em> Closed</em>. Required before settlement.
            </div>
            <button
              className="mf-btn warn"
              disabled={closeTx.isPending || closeTx.isConfirming}
              onClick={closeEpoch}
            >
              {closeTx.isPending || closeTx.isConfirming ? (
                <>
                  <span className="mf-spinner" /> Closing…
                </>
              ) : (
                "closeEpoch()"
              )}
            </button>
            <TxStatus label="closeEpoch" {...closeTx} />
          </div>

          {/* ---- Settle epoch ---- */}
          <div className="mf-card">
            <span className="mf-label">Settle epoch</span>
            <div className="mf-view-desc" style={{ marginBottom: 10 }}>
              Settlement requires off-chain KMS decryption proofs for the aggregate
              (<code>proofA</code>) and the transfer set (<code>proofT</code>).
              These are produced by the keeper's off-chain pipeline. Paste them
              below to settle directly, or run the documented keeper script.
            </div>

            <div className="mf-note todo">
              Typically run via the keeper script (produces proofA/proofT from the
              KMS, then calls <code>settleEpoch</code>). The button below is a live
              path for when you already hold the proofs.
            </div>

            <div className="mf-field">
              <label className="mf-field-label">proofA (aggregate decryption proof)</label>
              <input
                className="mf-input mono"
                placeholder="0x…"
                value={proofA}
                onChange={(e) => setProofA(e.target.value)}
              />
            </div>
            <div className="mf-field">
              <label className="mf-field-label">proofT (transfer-set proof)</label>
              <input
                className="mf-input mono"
                placeholder="0x…"
                value={proofT}
                onChange={(e) => setProofT(e.target.value)}
              />
            </div>
            <div className="mf-field">
              <label className="mf-field-label">maxFee (USDC)</label>
              <input
                className="mf-input mono"
                placeholder="0.00"
                value={maxFee}
                onChange={(e) => {
                  const v = e.target.value;
                  if (/^\d*\.?\d*$/.test(v)) setMaxFee(v);
                }}
              />
            </div>

            <button
              className="mf-btn primary"
              disabled={settleTx.isPending || settleTx.isConfirming || !settleValid}
              onClick={settleEpoch}
              title={
                proofsProvided
                  ? "settleEpoch(proofA, proofT, maxFee)"
                  : "Provide KMS proofs to enable"
              }
            >
              {settleTx.isPending || settleTx.isConfirming ? (
                <>
                  <span className="mf-spinner" /> Settling…
                </>
              ) : (
                "settleEpoch(proofA, proofT, maxFee)"
              )}
            </button>
            {settleError && <div className="mf-error">{settleError}</div>}
            <TxStatus label="settleEpoch" {...settleTx} />
          </div>

          <div className="mf-hint">
            State map: {Object.entries(EPOCH_STATE).map(([k, v]) => `${k}=${v}`).join("  ")}
          </div>
        </>
      )}
    </div>
  );
}
