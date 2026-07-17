// ============================================================================
// Confidential bridge — the ONLY view of the app. The user enters one amount +
// one destination; everything else runs in the background:
//   wrap -> pre-register -> deposit (encrypted) -> batch -> CCTP burn ->
//   Iris relay -> integrity check -> confidential distribution.
// The k-anonymity floor is 3, so two small filler transfers back to the sender
// are added AUTOMATICALLY (not shown as inputs). The full flow is documented on
// the Resources page. Orchestration is delegated UNCHANGED to
// runConfidentialBridge in ../../lib/bridge.js.
//
// Three UI states: (1) form, (2) live step tracker while running, (3) a final
// "bilan" summary once the bridge completes.
// ============================================================================
import { useState, useCallback, useRef } from "react";
import { Link } from "react-router-dom";
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
import usdcSvg from "../../assets/usdc.svg";
import "./BridgeFlow.css";

// Two automatic background fillers (paid to the sender) that make the batch
// reach the k-anonymity floor of 3. Never shown as inputs.
const FILLER_UNITS = [20_000n, 30_000n]; // 0.02 + 0.03 cUSD, returned to you

// The step tracker groups. `keys` are the stable onStep keys the runner emits.
const STEP_GROUPS = [
  { title: "Read epoch", short: "Epoch", keys: ["epoch"] },
  {
    title: "Pre-register on Arbitrum",
    short: "Pre-register",
    keys: ["switch-arb-pre", "prereg-0", "prereg-1", "prereg-2"],
  },
  {
    title: "Wrap + deposit on Ethereum",
    short: "Deposit",
    keys: ["switch-eth", "fund", "deposit-0", "deposit-1", "deposit-2"],
  },
  { title: "Close epoch", short: "Close", keys: ["close"] },
  { title: "Settle + CCTP burn", short: "Settle + burn", keys: ["settle"] },
  { title: "CCTP relay", short: "CCTP relay", keys: ["relay-attest", "switch-arb-relay", "relay"] },
  { title: "Integrity check (TEE)", short: "Integrity", keys: ["check"] },
  { title: "Confidential distribution", short: "Distribute", keys: ["finalize"] },
  { title: "Done", short: "Done", keys: ["done"] },
];

// Human labels + which chain each step's tx-hash link points to.
const STEP_META = {
  epoch: { label: "Read current epoch", chainId: CHAIN_IDS.SOURCE },
  "switch-arb-pre": { label: "Switch → Arbitrum Sepolia", chainId: CHAIN_IDS.DEST },
  "prereg-0": { label: "Pre-register your transfer", chainId: CHAIN_IDS.DEST },
  "prereg-1": { label: "Pre-register filler 1", chainId: CHAIN_IDS.DEST },
  "prereg-2": { label: "Pre-register filler 2", chainId: CHAIN_IDS.DEST },
  "switch-eth": { label: "Switch → Ethereum Sepolia", chainId: CHAIN_IDS.SOURCE },
  fund: { label: "Wrap USDC → cUSDC + authorize batcher", chainId: CHAIN_IDS.SOURCE },
  "deposit-0": { label: "Deposit your transfer (encrypted)", chainId: CHAIN_IDS.SOURCE },
  "deposit-1": { label: "Deposit filler 1 (encrypted)", chainId: CHAIN_IDS.SOURCE },
  "deposit-2": { label: "Deposit filler 2 (encrypted)", chainId: CHAIN_IDS.SOURCE },
  close: { label: "Close epoch", chainId: CHAIN_IDS.SOURCE },
  settle: { label: "Settle + CCTP fast-burn", chainId: CHAIN_IDS.SOURCE },
  "relay-attest": { label: "Poll Circle Iris attestation", chainId: CHAIN_IDS.SOURCE },
  "switch-arb-relay": { label: "Switch → Arbitrum Sepolia", chainId: CHAIN_IDS.DEST },
  relay: { label: "Relay mint (relayReceive)", chainId: CHAIN_IDS.DEST },
  check: { label: "Integrity check (Sum == A)", chainId: CHAIN_IDS.DEST },
  finalize: { label: "Confidential distribution", chainId: CHAIN_IDS.DEST },
  done: { label: "Decrypt recipient balance", chainId: CHAIN_IDS.DEST },
};

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
          <span className="bf-badge-token cusd">
            <img src={usdcSvg} alt="USDC" />
          </span>
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

const fmtElapsed = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export default function BridgeFlow() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const publicClientSource = usePublicClient({ chainId: CHAIN_IDS.SOURCE });
  const publicClientDest = usePublicClient({ chainId: CHAIN_IDS.DEST });
  const { switchChainAsync } = useSwitchChain();

  const [amount, setAmount] = useState("0.05");
  const [destination, setDestination] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [sent, setSent] = useState(null); // snapshot { amount, dest } for the bilan
  const [elapsed, setElapsed] = useState(null);
  const [steps, setSteps] = useState({}); // key -> { status, detail, txHash, chainId }
  const runningRef = useRef(false);
  const startRef = useRef(0);

  const configReady =
    !!BATCHER_ADDRESS && !!DISTRIBUTOR_ADDRESS && !!DEST_CUSDC_ADDRESS;

  const me = address || "";
  const destAddr = (destination || "").trim() || me;
  const amountUnits = parseUsdc(amount);
  const destBad = (destination || "").trim() !== "" && !isHex(destination.trim(), 20);
  const formValid =
    isConnected && configReady && amountUnits != null && amountUnits > 0n && isHex(destAddr, 20);

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
    setElapsed(null);
    if (!isConnected) return setError("Connect your wallet to bridge.");
    if (!configReady) return setError("Bridge addresses are not configured.");
    if (amountUnits == null || amountUnits <= 0n) return setError("Enter a positive amount.");
    if (!isHex(destAddr, 20)) return setError("Enter a valid 0x destination address.");

    setRunning(true);
    runningRef.current = true;
    startRef.current = Date.now();
    setSent({ amount: amountUnits, dest: destAddr });
    try {
      // Your transfer + two automatic fillers back to you = a k=3 batch.
      const transfers = [
        { recipient: destAddr, amount: amountUnits },
        { recipient: me, amount: FILLER_UNITS[0] },
        { recipient: me, amount: FILLER_UNITS[1] },
      ];
      const res = await runConfidentialBridge({
        getWalletClient: (chainId) => getWalletClient(config, { chainId }),
        switchChainAsync,
        publicClientSource,
        publicClientDest,
        transfers,
        onStep,
      });
      setElapsed(Date.now() - startRef.current);
      setResult(res);
    } catch (e) {
      setError(e?.shortMessage || e?.message?.slice(0, 260) || "Bridge failed");
    } finally {
      setRunning(false);
      runningRef.current = false;
    }
  }

  function reset() {
    setResult(null);
    setSteps({});
    setError(null);
    setSent(null);
    setElapsed(null);
    setAmount("0.05");
    setDestination("");
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
  const txOf = (k) => steps[k]?.txHash;

  const ctaLabel = !isConnected
    ? "Connect wallet to bridge"
    : !configReady
    ? "Bridge unavailable"
    : running
    ? "Bridging confidentially…"
    : "Bridge confidentially";

  // ---- FINAL BILAN (summary) ------------------------------------------------
  if (result) {
    const rows = [
      ["Your transfer", `${sent ? formatUsdc(sent.amount) : "—"} cUSD`],
      ["Destination", sent ? shorten(sent.dest, 8, 6) : "—"],
      ["Route", "Ethereum Sepolia → Arbitrum Sepolia"],
      ["Public aggregate A", result.aggregate != null ? `${formatUsdc(result.aggregate)} USDC` : "—"],
      ["Epoch", `#${result.epochId?.toString()}`],
      ["Elapsed", elapsed != null ? fmtElapsed(elapsed) : "—"],
    ];
    const txLinks = [
      ["Deposit (encrypted)", txOf("deposit-0"), CHAIN_IDS.SOURCE],
      ["Settle + CCTP burn", result.settleTxHash, CHAIN_IDS.SOURCE],
      ["Relay mint", txOf("relay"), CHAIN_IDS.DEST],
      ["Confidential distribution", txOf("finalize"), CHAIN_IDS.DEST],
    ].filter(([, h]) => !!h);

    return (
      <div>
        <div className="mf-view-title">Bridge complete</div>
        <div className="bf-result">
          <div className="bf-result-icon">✓</div>
          <div className="bf-result-title">Bridged confidentially</div>
          <div className="bf-result-sub">
            {sent ? formatUsdc(sent.amount) : "—"} cUSD delivered to{" "}
            {sent ? shorten(sent.dest, 6, 4) : "—"} on Arbitrum Sepolia.
          </div>

          {result.revealedBalance != null && (
            <div className="bf-result-reveal">
              {formatUsdc(result.revealedBalance)} cUSD
              <small>your Arbitrum balance, decrypted locally in your browser</small>
            </div>
          )}

          <div className="bf-result-details">
            {rows.map(([k, v]) => (
              <div className="bf-result-row" key={k}>
                <span className="label">{k}</span>
                <span className="value">{v}</span>
              </div>
            ))}
          </div>

          {txLinks.length > 0 && (
            <div className="bf-result-details" style={{ marginTop: 10 }}>
              {txLinks.map(([k, h, cid]) => (
                <div className="bf-result-row" key={k}>
                  <span className="label">{k}</span>
                  <span className="value">
                    <a href={txUrl(cid, h)} target="_blank" rel="noreferrer">
                      {shorten(h, 8, 6)} ↗
                    </a>
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="mf-enc-note" style={{ marginTop: 14 }}>
            <LockIcon size={16} />
            <span>
              Individual amounts never appeared on-chain — only the batch
              aggregate <strong>A</strong> was ever public. The two small fillers
              were returned to you.
            </span>
          </div>

          <div className="bf-result-actions">
            <button className="bf-cta" onClick={reset}>Bridge again</button>
          </div>
        </div>
      </div>
    );
  }

  // ---- FORM + LIVE STEPS ----------------------------------------------------
  return (
    <div>
      <div className="mf-view-title">Confidential bridge</div>
      <div className="mf-view-desc">
        Send USDC from Ethereum to Arbitrum with the amount hidden. Everything —
        wrapping, batching, the CCTP bridge and the TEE integrity check — happens
        in the background.{" "}
        <Link to="/resources" className="bf-doclink">How it works ↗</Link>
      </div>

      {!configReady && (
        <div className="mf-note todo">
          Bridge addresses are not fully configured — bridging is disabled.
        </div>
      )}

      {/* ---- From -> To route card ---- */}
      <div className="bf-route">
        <ChainCard label="From" title="cUSD" sub="on Ethereum Sepolia" chain="eth" />
        <div className="bf-swap-wrap">
          <span className="bf-swap-pill"><SwapArrow /></span>
        </div>
        <ChainCard label="To" title="cUSD" sub="on Arbitrum Sepolia" chain="arb" />
      </div>

      {/* ---- amount + destination ---- */}
      <div className="bf-send-card">
        <div className="bf-send-head">
          <span className="bf-send-label">Amount</span>
          <span className="bf-send-asset">
            <LockIcon size={13} /> cUSD · confidential USDC
          </span>
        </div>
        <div className="bf-send-body">
          <input
            className="bf-send-input"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            disabled={running}
            onChange={(e) => {
              const v = e.target.value;
              if (/^\d*\.?\d*$/.test(v)) setAmount(v);
            }}
          />
        </div>
        <div className="bf-send-helper">
          <span className="bf-send-units">
            {amountUnits != null ? `${amountUnits.toString()} base units` : "USDC · 6 decimals"}
          </span>
        </div>

        <div className="bf-recipient">
          <div className="bf-recipient-label">
            Destination address{" "}
            {(!destination || !destination.trim()) && "(defaults to your address)"}
          </div>
          <input
            className={`bf-recipient-input ${destBad ? "bad" : ""}`}
            placeholder={address || "0x… destination"}
            value={destination}
            disabled={running}
            onChange={(e) => setDestination(e.target.value)}
          />
        </div>
      </div>

      <div className="mf-enc-note">
        <LockIcon size={16} />
        <span>
          Your amount is encrypted <strong>in your browser</strong> via iExec Nox
          before it is sent. Privacy needs a crowd, so your transfer is bundled
          into a private <strong>k=3 batch</strong> — two small fillers are added
          automatically and returned to you.{" "}
          <Link to="/resources" className="bf-doclink">Details ↗</Link>
        </span>
      </div>

      {/* ---- primary CTA ---- */}
      <button className="bf-cta" disabled={running || !formValid} onClick={run}>
        {running && <span className="mf-spinner" />}
        {ctaLabel}
      </button>

      {!isConnected && (
        <div className="mf-note todo" style={{ marginTop: 10 }}>
          Connect your wallet on Ethereum Sepolia. The flow switches your wallet
          between Ethereum and Arbitrum Sepolia several times — approve each
          switch when prompted.
        </div>
      )}

      {error && <div className="mf-error">{error}</div>}

      {/* ---- horizontal phase rail ---- */}
      <div className="bf-progress-title">
        {started ? "Bridging cUSD confidentially" : "Confidential route"}
      </div>
      <div className="bf-rail">
        {STEP_GROUPS.map((g) => (
          <RailNode key={g.title} status={groupStatus(g.keys)} label={g.short} />
        ))}
      </div>

      {/* ---- detailed step tracker (once a run starts) ---- */}
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
                            <a href={txUrl(s.chainId ?? meta.chainId, s.txHash)} target="_blank" rel="noreferrer">
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

      {running && (
        <div className="mf-note" style={{ marginTop: 10 }}>
          Two legs take time and cannot be sped up: the KMS reveals (settle +
          integrity check) take a few seconds each, and the CCTP relay waits for
          Circle's attestation (often 1–3 min on sandbox). Keep this tab open.
        </div>
      )}
    </div>
  );
}
