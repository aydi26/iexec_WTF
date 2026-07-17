// ============================================================================
// Confidential bridge — the full in-browser cross-chain flow.
//   deposit -> batch -> CCTP burn -> Iris relay -> integrity check ->
//   confidential distribution, all driven from the wallet (no scripts).
//
// PRESENTATION ONLY: this view is re-skinned to mirror the base UI
// BridgeWidget aesthetic (From -> To route card + swap pill, a big amount
// input card, a collapsible k=3 batch section, a horizontal step tracker,
// and a success/status panel), recolored to the Noxus yellow accent. The
// confidential orchestration is delegated UNCHANGED to runConfidentialBridge
// in ../../lib/bridge.js.
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
import arbitrumSvg from "../../assets svg/1225_Arbitrum_Logomark_FullColor_ClearSpace.svg";
import "./BridgeFlow.css";

// The step tracker groups. `keys` are the stable onStep keys the runner emits.
// `short` is the compact label shown on the horizontal phase rail.
const STEP_GROUPS = [
  { title: "Read epoch", short: "Epoch", keys: ["epoch"] },
  {
    title: "Pre-register on Arbitrum ×3",
    short: "Pre-register",
    keys: ["switch-arb-pre", "prereg-0", "prereg-1", "prereg-2"],
  },
  {
    title: "Fund + deposit on Ethereum ×3",
    short: "Deposit",
    keys: ["switch-eth", "fund", "deposit-0", "deposit-1", "deposit-2"],
  },
  { title: "Close epoch", short: "Close", keys: ["close"] },
  { title: "Settle + CCTP burn", short: "Settle + burn", keys: ["settle"] },
  { title: "CCTP relay", short: "CCTP relay", keys: ["relay-attest", "switch-arb-relay", "relay"] },
  { title: "Integrity check", short: "Integrity", keys: ["check"] },
  { title: "Finalize + distribute", short: "Distribute", keys: ["finalize"] },
  { title: "Done — decrypted balance", short: "Done", keys: ["done"] },
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

// Row scaffold: row 1 = your transfer, rows 2-3 = editable batch fillers.
// `recipient` is left blank by default so the connected address can be used as
// both placeholder and fallback (derived at render time — no effect needed).
const DEFAULT_ROWS = [
  { recipient: "", amount: "0.02", label: "Your transfer" },
  { recipient: "", amount: "0.03", label: "Batch filler (editable)" },
  { recipient: "", amount: "0.05", label: "Batch filler (editable)" },
];

// Small chevron used by the collapsible batch section.
function Chevron() {
  return (
    <svg className="bf-batch-chev" width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Down-arrow used in the swap pill between the From and To cards.
function SwapArrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// A From/To chain card: dual token+chain badge, title, subtitle.
function ChainCard({ label, title, sub, chain }) {
  return (
    <div className="bf-card">
      <div className="bf-card-label">{label}</div>
      <div className="bf-card-head">
        <span className="bf-badge">
          <span className="bf-badge-token cusd">$</span>
          {chain === "arb" ? (
            <span className="bf-badge-chain">
              <img src={arbitrumSvg} alt="Arbitrum" />
            </span>
          ) : (
            <span className="bf-badge-chain eth">Ξ</span>
          )}
        </span>
        <div>
          <div className="bf-card-title">{title}</div>
          <div className="bf-card-sub">{sub}</div>
        </div>
      </div>
    </div>
  );
}

// One phase node on the horizontal rail.
function RailNode({ status, label }) {
  const glyph =
    status === "done" ? "✓" :
    status === "error" ? "!" :
    status === "active" ? <span className="bf-rail-spinner" /> :
    "";
  return (
    <div className={`bf-rail-node ${status}`}>
      <span className="bf-rail-dot">{glyph}</span>
      <span className="bf-rail-label">{label}</span>
    </div>
  );
}

export default function BridgeFlow() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const publicClientSource = usePublicClient({ chainId: CHAIN_IDS.SOURCE });
  const publicClientDest = usePublicClient({ chainId: CHAIN_IDS.DEST });
  const { switchChainAsync } = useSwitchChain();

  const [rows, setRows] = useState(DEFAULT_ROWS);
  const [batchOpen, setBatchOpen] = useState(false);
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
    if (!rowsValid) return setError("Each transfer needs a valid 0x address and a positive USDC amount.");

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

  // Main row (row 0) is the user's transfer; rows 1-2 are batch fillers.
  const mainRow = rows[0];
  const mainBad = (mainRow.recipient || "").trim() !== "" && !isHex(mainRow.recipient.trim(), 20);

  const ctaLabel = !isConnected
    ? "Connect wallet to bridge"
    : !configReady
    ? "Bridge unavailable"
    : running
    ? "Bridging confidentially…"
    : "Bridge confidentially";

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

      {/* ---- From -> To route card ---- */}
      <div className="bf-route">
        <ChainCard
          label="From"
          title="cUSD"
          sub="on Ethereum Sepolia"
          chain="eth"
        />
        <div className="bf-swap-wrap">
          <span className="bf-swap-pill">
            <SwapArrow />
          </span>
        </div>
        <ChainCard
          label="To"
          title="cUSD"
          sub="on Arbitrum Sepolia"
          chain="arb"
        />
      </div>

      {/* ---- big amount input card (your transfer) ---- */}
      <div className="bf-send-card">
        <div className="bf-send-head">
          <span className="bf-send-label">Your transfer</span>
          <span className="bf-send-asset">
            <LockIcon size={13} /> cUSD · confidential USDC
          </span>
        </div>
        <div className="bf-send-body">
          <input
            className="bf-send-input"
            inputMode="decimal"
            placeholder="0"
            value={mainRow.amount}
            disabled={running}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d*\.?\d*$/.test(v)) updateRow(0, { amount: v });
            }}
          />
        </div>
        <div className="bf-send-helper">
          <span className="bf-send-units">
            {parsed[0] != null ? `${parsed[0].toString()} base units` : "USDC · 6 decimals"}
          </span>
        </div>

        <div className="bf-recipient">
          <div className="bf-recipient-label">
            Destination address {(!mainRow.recipient || !mainRow.recipient.trim()) && "(defaults to your address)"}
          </div>
          <input
            className={`bf-recipient-input ${mainBad ? "bad" : ""}`}
            placeholder={address || "0x… destination"}
            value={mainRow.recipient}
            disabled={running}
            onChange={(e) => updateRow(0, { recipient: e.target.value })}
          />
        </div>
      </div>

      {/* ---- collapsible batch (k=3) section ---- */}
      <div className={`bf-batch ${batchOpen ? "open" : ""}`}>
        <button
          type="button"
          className="bf-batch-head"
          onClick={() => setBatchOpen((o) => !o)}
        >
          <span className="bf-batch-head-left">
            <span className="bf-batch-tag">Batch · k=3</span>
            <span className="bf-batch-title">
              2 batch filler transfers
            </span>
          </span>
          <Chevron />
        </button>
        {batchOpen && (
          <div className="bf-batch-body">
            <div className="bf-batch-note">
              Amounts are hidden. A batch bundles 3 confidential transfers to
              preserve k-anonymity. These two fillers default to small amounts
              paid to yourself — edit them freely.
            </div>
            {rows.slice(1).map((r, idx) => {
              const i = idx + 1;
              const typed = (r.recipient || "").trim();
              const bad = typed !== "" && !isHex(typed, 20);
              return (
                <div className="bf-filler" key={i}>
                  <div className="bf-filler-fields">
                    <span className="bf-filler-label">Filler {i} · recipient</span>
                    <input
                      className={`bf-filler-addr ${bad ? "bad" : ""}`}
                      placeholder={address || "0x… (defaults to you)"}
                      value={r.recipient}
                      disabled={running}
                      onChange={(e) => updateRow(i, { recipient: e.target.value })}
                    />
                  </div>
                  <input
                    className="bf-filler-amt"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={r.amount}
                    disabled={running}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (/^\d*\.?\d*$/.test(v)) updateRow(i, { amount: v });
                    }}
                  />
                </div>
              );
            })}
            <div className="bf-batch-total">
              <span className="k">Batch total (3 transfers)</span>
              <span className="v">{total != null ? `${formatUsdc(total)} USDC` : "—"}</span>
            </div>
          </div>
        )}
      </div>

      <div className="mf-enc-note">
        <LockIcon size={16} />
        <span>
          Every amount is encrypted <strong>in your browser</strong> via iExec
          Nox before it is sent. Only the public aggregate A is ever revealed —
          per-transfer amounts stay hidden end-to-end.
        </span>
      </div>

      {/* ---- primary CTA ---- */}
      <button
        className="bf-cta"
        disabled={running || !isConnected || !configReady || !rowsValid}
        onClick={run}
      >
        {running && <span className="mf-spinner" />}
        {ctaLabel}
      </button>

      {!isConnected && (
        <div className="mf-note todo" style={{ marginTop: 10 }}>
          Connect your wallet to run the bridge. The flow switches your wallet
          between Ethereum Sepolia and Arbitrum Sepolia several times — approve
          each switch when prompted.
        </div>
      )}

      {error && <div className="mf-error">{error}</div>}

      {/* ---- horizontal phase rail: upcoming-route preview when idle, live
              progress once running ---- */}
      <div className="bf-progress-title">
        {started ? "Bridging cUSD confidentially" : "Confidential route"}
      </div>
      <div className="bf-rail">
        {STEP_GROUPS.map((g) => (
          <RailNode key={g.title} status={groupStatus(g.keys)} label={g.short} />
        ))}
      </div>

      {/* ---- detailed step tracker (revealed once a run starts) ---- */}
      {started && (
        <div className="bf-steps">
          {STEP_GROUPS.map((g) => {
            const gStatus = groupStatus(g.keys);
            const gGlyph =
              gStatus === "done" ? "✓" :
              gStatus === "error" ? "!" :
              gStatus === "active" ? <span className="bf-rail-spinner" /> :
              "·";
            return (
              <div key={g.title} className={`bf-phase ${gStatus}`}>
                <div className="bf-phase-head">
                  <span className="bf-phase-icon">{gGlyph}</span>
                  <span className="bf-phase-title">{g.title}</span>
                </div>
                {g.keys
                  .filter((k) => steps[k])
                  .map((k) => {
                    const s = steps[k];
                    const meta = STEP_META[k] || {};
                    return (
                      <div key={k} className={`bf-substep ${s.status}`}>
                        <div className="bf-substep-line">
                          <span className="glyph">
                            {s.status === "done" ? "✓" : s.status === "error" ? "✕" : "•"}
                          </span>
                          <span className="txt">{meta.label || k}</span>
                        </div>
                        {s.detail && <div className="bf-substep-detail">{s.detail}</div>}
                        {s.txHash && (
                          <div className="bf-substep-tx">
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

      {/* ---- success / status panel ---- */}
      {result && (
        <div className="bf-result">
          <div className="bf-result-icon">✓</div>
          <div className="bf-result-title">Confidential bridge complete</div>
          <div className="bf-result-sub">
            Epoch #{result.epochId?.toString()} settled on Arbitrum Sepolia.
          </div>
          {result.revealedBalance != null && (
            <div className="bf-result-reveal">
              {formatUsdc(result.revealedBalance)} cUSD
              <small>your Arbitrum balance, decrypted locally</small>
            </div>
          )}
          <div className="bf-result-details">
            {result.aggregate != null && (
              <div className="bf-result-row">
                <span className="label">Public aggregate A</span>
                <span className="value">{formatUsdc(result.aggregate)} USDC</span>
              </div>
            )}
            {result.settleTxHash && (
              <div className="bf-result-row">
                <span className="label">Settle / burn tx</span>
                <span className="value">
                  <a
                    href={txUrl(CHAIN_IDS.SOURCE, result.settleTxHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shorten(result.settleTxHash, 8, 6)} ↗
                  </a>
                </span>
              </div>
            )}
          </div>
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
