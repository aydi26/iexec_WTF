// ============================================================================
// Confidential bridge — the full in-browser cross-chain flow.
//   deposit -> batch -> CCTP burn -> Iris relay -> integrity check ->
//   confidential distribution, all driven from the wallet (no scripts).
//
// Chain switching: the flow crosses ETH Sepolia <-> Arb Sepolia several times.
// We NEVER reuse a stale wallet client — `getWalletClient(config, { chainId })`
// from wagmi/actions always returns a fresh client bound to the requested chain
// (and the Nox handle client is recreated from it). switchChainAsync drives the
// wallet's network prompt; we surface a clear "approve the switch" note first.
// ============================================================================
import { useState, useCallback, useRef } from "react";
import { useAccount, useConfig, usePublicClient, useSwitchChain } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import {
  CHAIN_IDS,
  DISTRIBUTOR_ADDRESS,
  DEST_CUSDC_ADDRESS,
  BATCHER_ADDRESS,
  txUrl,
} from "../../config/contracts";
import { parseUsdc, formatUsdc, isHex } from "./format";
import { runConfidentialBridge } from "../../lib/bridge";
import { LockIcon, shorten } from "./shared";

// The step tracker groups. `keys` are the stable onStep keys the runner emits.
const STEP_GROUPS = [
  { title: "Read epoch", keys: ["epoch"] },
  {
    title: "Pre-register on Arbitrum ×3",
    keys: ["switch-arb-pre", "prereg-0", "prereg-1", "prereg-2"],
  },
  {
    title: "Fund + deposit on Ethereum ×3",
    keys: ["switch-eth", "fund", "deposit-0", "deposit-1", "deposit-2"],
  },
  { title: "Close epoch", keys: ["close"] },
  { title: "Settle + CCTP burn", keys: ["settle"] },
  { title: "CCTP relay", keys: ["relay-attest", "switch-arb-relay", "relay"] },
  { title: "Integrity check", keys: ["check"] },
  { title: "Finalize + distribute", keys: ["finalize"] },
  { title: "Done — decrypted balance", keys: ["done"] },
];

// Human labels + which chain each step's tx-hash link points to.
const STEP_META = {
  epoch: { label: "Read current epoch", chainId: CHAIN_IDS.SOURCE },
  "switch-arb-pre": { label: "Switch → Arbitrum Sepolia", chainId: CHAIN_IDS.DEST },
  "prereg-0": { label: "Pre-register transfer 1", chainId: CHAIN_IDS.DEST },
  "prereg-1": { label: "Pre-register transfer 2", chainId: CHAIN_IDS.DEST },
  "prereg-2": { label: "Pre-register transfer 3", chainId: CHAIN_IDS.DEST },
  "switch-eth": { label: "Switch → Ethereum Sepolia", chainId: CHAIN_IDS.SOURCE },
  fund: { label: "Fund cUSDC + authorize batcher", chainId: CHAIN_IDS.SOURCE },
  "deposit-0": { label: "Deposit transfer 1 (encrypted)", chainId: CHAIN_IDS.SOURCE },
  "deposit-1": { label: "Deposit transfer 2 (encrypted)", chainId: CHAIN_IDS.SOURCE },
  "deposit-2": { label: "Deposit transfer 3 (encrypted)", chainId: CHAIN_IDS.SOURCE },
  close: { label: "Close epoch", chainId: CHAIN_IDS.SOURCE },
  settle: { label: "Settle + CCTP fast-burn", chainId: CHAIN_IDS.SOURCE },
  "relay-attest": { label: "Poll Circle Iris attestation", chainId: CHAIN_IDS.SOURCE },
  "switch-arb-relay": { label: "Switch → Arbitrum Sepolia", chainId: CHAIN_IDS.DEST },
  relay: { label: "Relay mint (relayReceive)", chainId: CHAIN_IDS.DEST },
  check: { label: "Integrity check (Sum == A)", chainId: CHAIN_IDS.DEST },
  finalize: { label: "Finalize + confidential distribute", chainId: CHAIN_IDS.DEST },
  done: { label: "Decrypt recipient balance", chainId: CHAIN_IDS.DEST },
};

const ALL_KEYS = STEP_GROUPS.flatMap((g) => g.keys);

// Row scaffold: row 1 = your transfer, rows 2-3 = editable batch fillers.
// `recipient` is left blank by default so the connected address can be used as
// both placeholder and fallback (derived at render time — no effect needed).
const DEFAULT_ROWS = [
  { recipient: "", amount: "0.02", label: "Your transfer" },
  { recipient: "", amount: "0.03", label: "Batch filler (editable)" },
  { recipient: "", amount: "0.05", label: "Batch filler (editable)" },
];

function StepIcon({ status }) {
  if (status === "done")
    return <span className="mf-step-num" style={{ background: "rgba(245,214,75,0.14)", color: "#F5D64B" }}>✓</span>;
  if (status === "active")
    return <span className="mf-step-num" style={{ background: "#F5D64B", color: "#000" }}><span className="mf-spinner" style={{ width: 11, height: 11 }} /></span>;
  if (status === "error")
    return <span className="mf-step-num" style={{ background: "rgba(255,68,68,0.14)", color: "#ff6b6b" }}>!</span>;
  return <span className="mf-step-num">·</span>;
}

export default function BridgeFlow() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const publicClientSource = usePublicClient({ chainId: CHAIN_IDS.SOURCE });
  const publicClientDest = usePublicClient({ chainId: CHAIN_IDS.DEST });
  const { switchChainAsync } = useSwitchChain();

  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [steps, setSteps] = useState({}); // key -> { status, detail, txHash, chainId }
  const runningRef = useRef(false);

  const configReady =
    !!BATCHER_ADDRESS && !!DISTRIBUTOR_ADDRESS && !!DEST_CUSDC_ADDRESS;

  // Effective recipient for a row: the typed value, else the connected address.
  const rowRecipient = (r) => (r.recipient || "").trim() || (address || "");

  const parsed = rows.map((r) => parseUsdc(r.amount));
  const total = parsed.every((u) => u != null && u > 0n)
    ? parsed.reduce((a, u) => a + u, 0n)
    : null;

  const rowsValid = rows.every((r, i) => {
    return isHex(rowRecipient(r), 20) && parsed[i] != null && parsed[i] > 0n;
  });

  const updateRow = (i, patch) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const onStep = useCallback((key, status, detail, txHash, chainId) => {
    setSteps((s) => ({
      ...s,
      [key]: {
        status,
        detail,
        txHash: txHash ?? s[key]?.txHash,
        chainId: chainId ?? s[key]?.chainId ?? STEP_META[key]?.chainId,
      },
    }));
  }, []);

  async function run() {
    if (running || runningRef.current) return;
    setError(null);
    setResult(null);
    setSteps({});
    if (!isConnected) return setError("Connect your wallet to bridge.");
    if (!configReady) return setError("Bridge addresses are not configured.");
    if (!rowsValid) return setError("Each row needs a valid 0x address and a positive USDC amount.");

    setRunning(true);
    runningRef.current = true;
    try {
      const transfers = rows.map((r, i) => ({
        recipient: rowRecipient(r),
        amount: parsed[i],
      }));
      const res = await runConfidentialBridge({
        // Always return a FRESH wallet client bound to the requested chain.
        getWalletClient: (chainId) => getWalletClient(config, { chainId }),
        switchChainAsync,
        publicClientSource,
        publicClientDest,
        transfers,
        onStep,
      });
      setResult(res);
    } catch (e) {
      setError(e?.shortMessage || e?.message?.slice(0, 260) || "Bridge failed");
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }

  // Roll up a group's status from its member steps.
  const groupStatus = (keys) => {
    const sts = keys.map((k) => steps[k]?.status).filter(Boolean);
    if (sts.includes("error")) return "error";
    if (sts.includes("active")) return "active";
    if (sts.length && keys.every((k) => steps[k]?.status === "done")) return "done";
    if (sts.length) return "active";
    return "pending";
  };

  const started = Object.keys(steps).length > 0;

  return (
    <div>
      <div className="mf-view-title">Confidential bridge</div>
      <div className="mf-view-desc">
        Bridge USDC cross-chain with amounts hidden. The k-anonymity floor is 3,
        so a batch bundles 3 confidential transfers.
      </div>

      {!configReady && (
        <div className="mf-note todo">
          Bridge addresses (batcher / distributor / dest cUSDC) are not fully
          configured — bridging is disabled.
        </div>
      )}

      {/* ---- transfer rows ---- */}
      <div className="mf-card">
        <span className="mf-label">Batch of 3 confidential transfers</span>
        {rows.map((r, i) => {
          // Only flag as bad when the user typed something invalid; a blank
          // field falls back to the connected address (shown as placeholder).
          const typed = (r.recipient || "").trim();
          const bad = typed !== "" && !isHex(typed, 20);
          return (
            <div
              key={i}
              style={{
                padding: "10px 0",
                borderTop: i === 0 ? "none" : "1px solid rgba(255,255,255,0.04)",
              }}
            >
              <div
                className="mf-field-label"
                style={{ marginBottom: 6, color: i === 0 ? "#F5D64B" : "#8a8a8e" }}
              >
                {i === 0 ? "Your transfer" : r.label}
              </div>
              <input
                className="mf-input mono"
                style={{ marginBottom: 6, borderColor: bad ? "rgba(255,68,68,0.4)" : undefined }}
                placeholder={address || "0x… destination"}
                value={r.recipient}
                disabled={running}
                onChange={(e) => updateRow(i, { recipient: e.target.value })}
              />
              <div className="mf-row" style={{ padding: 0, alignItems: "center" }}>
                <input
                  className="mf-input"
                  style={{ maxWidth: 140 }}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={r.amount}
                  disabled={running}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^\d*\.?\d*$/.test(v)) updateRow(i, { amount: v });
                  }}
                />
                <span className="k" style={{ fontSize: 12 }}>
                  {parsed[i] != null ? `${parsed[i].toString()} base units` : "USDC"}
                </span>
              </div>
            </div>
          );
        })}
        <div className="mf-row" style={{ paddingTop: 10 }}>
          <span className="k">Batch total</span>
          <span className="v">
            {total != null ? `${formatUsdc(total)} USDC` : "—"}
          </span>
        </div>
      </div>

      <div className="mf-enc-note">
        <LockIcon size={16} />
        <span>
          Every amount is encrypted <strong>in your browser</strong> via iExec
          Nox before it is sent. Only the public aggregate A is ever revealed —
          per-transfer amounts stay hidden end-to-end.
        </span>
      </div>

      <button
        className="mf-btn primary"
        disabled={running || !isConnected || !configReady || !rowsValid}
        onClick={run}
      >
        {running ? (
          <>
            <span className="mf-spinner" /> Bridging confidentially…
          </>
        ) : (
          "Bridge confidentially"
        )}
      </button>

      {!isConnected && (
        <div className="mf-note todo" style={{ marginTop: 10 }}>
          Connect your wallet to run the bridge. The flow switches your wallet
          between Ethereum Sepolia and Arbitrum Sepolia several times — approve
          each switch when prompted.
        </div>
      )}

      {error && <div className="mf-error">{error}</div>}

      {/* ---- step tracker ---- */}
      {started && (
        <div className="mf-steps" style={{ marginTop: 14 }}>
          {STEP_GROUPS.map((g) => {
            const gStatus = groupStatus(g.keys);
            return (
              <div key={g.title} style={{ marginBottom: 4 }}>
                <div className={`mf-step ${gStatus === "pending" ? "" : gStatus === "error" ? "failed" : gStatus}`}>
                  <StepIcon status={gStatus} />
                  <span className="mf-step-text" style={{ fontWeight: 600 }}>
                    {g.title}
                  </span>
                </div>
                {/* sub-steps that have started */}
                {g.keys
                  .filter((k) => steps[k])
                  .map((k) => {
                    const s = steps[k];
                    const meta = STEP_META[k] || {};
                    return (
                      <div
                        key={k}
                        style={{ padding: "2px 0 2px 34px", fontSize: 12 }}
                      >
                        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                          <span
                            style={{
                              color:
                                s.status === "done"
                                  ? "#F5D64B"
                                  : s.status === "error"
                                  ? "#ff6b6b"
                                  : s.status === "active"
                                  ? "#e5e5e7"
                                  : "#636366",
                            }}
                          >
                            {s.status === "done" ? "✓" : s.status === "error" ? "✕" : "•"} {meta.label || k}
                          </span>
                        </div>
                        {s.detail && (
                          <div className="mf-hint" style={{ marginTop: 1 }}>
                            {s.detail}
                          </div>
                        )}
                        {s.txHash && (
                          <div className="mf-tx-hash" style={{ marginTop: 2, fontSize: 11 }}>
                            <a
                              href={txUrl(s.chainId ?? meta.chainId, s.txHash)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {shorten(s.txHash, 10, 8)} ↗
                            </a>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- timing / relay notes ---- */}
      {running && (
        <div className="mf-note" style={{ marginTop: 10 }}>
          Two legs take time and cannot be sped up: the KMS reveals (settle +
          integrity check) take a few seconds each, and the CCTP relay waits for
          Circle's attestation (often 1–3 min on sandbox). Keep this tab open.
        </div>
      )}

      {result && (
        <div className="mf-success" style={{ marginTop: 10 }}>
          Confidential bridge complete for epoch #{result.epochId?.toString()}.
          {result.revealedBalance != null && (
            <>
              {" "}
              Your Arbitrum cUSDC balance decrypted locally ={" "}
              <strong>{formatUsdc(result.revealedBalance)} cUSDC</strong>.
            </>
          )}
          {result.settleTxHash && (
            <>
              {" "}
              <a
                href={txUrl(CHAIN_IDS.SOURCE, result.settleTxHash)}
                target="_blank"
                rel="noreferrer"
              >
                View settle/burn tx ↗
              </a>
            </>
          )}
        </div>
      )}

      <div className="mf-hint" style={{ marginTop: 10 }}>
        If Iris polling is blocked by CORS in the browser, the flow stops at the
        relay leg with a clear message — run the keeper script for that single
        leg, then re-run to finish the Arbitrum steps.
      </div>
    </div>
  );
}
