// ============================================================================
// Auditor — grant a viewer (auditor) on a specific epoch deposit entry, via
// batcher.grantAuditor(epochId, index, auditorAddr). Grants are add-only: Nox
// has no removeViewer, so an auditor once added cannot be revoked.
// ============================================================================
import { useState } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import {
  CHAIN_IDS,
  BATCHER_ADDRESS,
  BATCHER_ABI,
} from "../../config/contracts";
import { isHex } from "./format";
import { ChainGuard, TxStatus, useTxAction } from "./shared";

export default function AuditorView() {
  const { address } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: CHAIN_IDS.SOURCE });

  const [epochId, setEpochId] = useState("");
  const [index, setIndex] = useState("");
  const [auditor, setAuditor] = useState("");
  const [error, setError] = useState(null);

  const tx = useTxAction(CHAIN_IDS.SOURCE);
  const ready = !!BATCHER_ADDRESS;

  const valid =
    /^\d+$/.test(epochId.trim()) &&
    /^\d+$/.test(index.trim()) &&
    isHex(auditor.trim(), 20);

  async function grant() {
    if (!walletClient || !publicClient) return;
    setError(null);
    if (!valid) {
      setError("Provide a numeric epoch, numeric deposit index, and a 20-byte auditor address.");
      return;
    }
    try {
      await tx.run(
        () =>
          walletClient.writeContract({
            address: BATCHER_ADDRESS,
            abi: BATCHER_ABI,
            functionName: "grantAuditor",
            args: [BigInt(epochId.trim()), BigInt(index.trim()), auditor.trim()],
            account: address,
          }),
        { wait: (hash) => publicClient.waitForTransactionReceipt({ hash }) }
      );
    } catch {
      /* surfaced via tx state */
    }
  }

  return (
    <div>
      <div className="mf-view-title">Grant auditor</div>
      <div className="mf-view-desc">
        Add an auditor as a viewer on one of your epoch deposit entries. The
        auditor will be able to decrypt that entry's confidential amount.
      </div>

      <ChainGuard requiredChainId={CHAIN_IDS.SOURCE} chainName="ETH Sepolia" />

      {!ready && <div className="mf-note todo">Batcher address not configured.</div>}

      {ready && (
        <>
          <div className="mf-field">
            <label className="mf-field-label">Epoch index</label>
            <input
              className="mf-input mono"
              placeholder="0"
              value={epochId}
              onChange={(e) => setEpochId(e.target.value)}
            />
          </div>
          <div className="mf-field">
            <label className="mf-field-label">Deposit index (within epoch)</label>
            <input
              className="mf-input mono"
              placeholder="0"
              value={index}
              onChange={(e) => setIndex(e.target.value)}
            />
          </div>
          <div className="mf-field">
            <label className="mf-field-label">Auditor address</label>
            <input
              className="mf-input mono"
              placeholder="0x…"
              value={auditor}
              onChange={(e) => setAuditor(e.target.value)}
            />
          </div>

          <div className="mf-note todo">
            Grants are <strong>add-only</strong> — Nox has no removeViewer, so an
            auditor cannot be revoked once added.
          </div>

          <button
            className="mf-btn primary"
            disabled={tx.isPending || tx.isConfirming || !valid}
            onClick={grant}
          >
            {tx.isPending || tx.isConfirming ? (
              <>
                <span className="mf-spinner" /> Granting…
              </>
            ) : (
              "Grant auditor"
            )}
          </button>

          <TxStatus label="Grant auditor" {...tx} />
          {error && <div className="mf-error">{error}</div>}
          {tx.isSuccess && (
            <div className="mf-success">Auditor granted for epoch {epochId}, index {index}.</div>
          )}
        </>
      )}
    </div>
  );
}
