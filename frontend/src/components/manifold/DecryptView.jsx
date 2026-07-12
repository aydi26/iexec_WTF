// ============================================================================
// Decrypt my balance — reads cusdc.confidentialBalanceOf(me) (an opaque handle)
// then asks Nox to decrypt it locally. Only the holder is permitted to decrypt,
// so the plaintext is revealed to you and nobody else.
// ============================================================================
import { useState } from "react";
import { useAccount, useWalletClient, usePublicClient } from "wagmi";
import {
  CHAIN_IDS,
  CUSDC_ADDRESS,
  CUSDC_ABI,
} from "../../config/contracts";
import { decryptHandle } from "../../lib/nox";
import { formatUsdc, ZERO_BYTES32 } from "./format";
import { ChainGuard, LockIcon, shorten } from "./shared";

export default function DecryptView() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient({ chainId: CHAIN_IDS.SOURCE });

  const [handle, setHandle] = useState(null);
  const [plain, setPlain] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const ready = !!CUSDC_ADDRESS && isConnected;

  async function reveal() {
    if (!walletClient || !publicClient || !address) return;
    setBusy(true);
    setError(null);
    setPlain(null);
    try {
      const h = await publicClient.readContract({
        address: CUSDC_ADDRESS,
        abi: CUSDC_ABI,
        functionName: "confidentialBalanceOf",
        args: [address],
      });
      setHandle(h);
      if (!h || h === ZERO_BYTES32) {
        setPlain(0n);
        return;
      }
      const value = await decryptHandle(walletClient, h);
      setPlain(typeof value === "bigint" ? value : BigInt(value));
    } catch (err) {
      setError(err?.shortMessage || err?.message?.slice(0, 220) || "Decrypt failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mf-view-title">Decrypt my balance</div>
      <div className="mf-view-desc">
        Your confidential cUSDC balance is stored on-chain as an encrypted handle.
        Only you can decrypt it — the reveal happens locally in your browser via
        iExec Nox.
      </div>

      <ChainGuard requiredChainId={CHAIN_IDS.SOURCE} chainName="ETH Sepolia" />

      {!CUSDC_ADDRESS && (
        <div className="mf-note todo">cUSDC address not configured.</div>
      )}

      {ready && (
        <>
          <div className="mf-enc-note">
            <LockIcon size={16} />
            <span>
              The chain only ever holds the ciphertext handle. Decryption is
              gated by Nox's ACL to your address.
            </span>
          </div>

          <button className="mf-btn primary" disabled={busy} onClick={reveal}>
            {busy ? (
              <>
                <span className="mf-spinner" /> Decrypting…
              </>
            ) : (
              "Reveal my balance"
            )}
          </button>

          {handle && (
            <div className="mf-card" style={{ marginTop: 12 }}>
              <span className="mf-label">Balance handle</span>
              <div className="mf-tx-hash">{shorten(handle, 14, 12)}</div>
            </div>
          )}

          {plain != null && (
            <div className="mf-reveal">
              {formatUsdc(plain)} cUSDC
              <small>decrypted locally — visible only to you</small>
            </div>
          )}

          {error && <div className="mf-error">{error}</div>}
        </>
      )}
    </div>
  );
}
