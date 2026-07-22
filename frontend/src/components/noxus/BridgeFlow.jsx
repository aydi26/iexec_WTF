// ============================================================================
// Confidential bridge widget — the ONLY view of the app. Exchange-style widget
// (From/To cards, swap pill, Send card, recipient) with a Bridge tab (the form)
// and a Track tab (the live step tracker + final "bilan"). The user enters one
// amount + one destination; everything else — wrap, pre-register, deposit,
// batch, CCTP bridge, TEE integrity check, distribution — runs in the
// background. A k=3 batch is met with two automatic fillers — normally
// contributed by the operator's keeper from its own funds (self-filler
// fallback: the user provides them and they cycle back). Orchestration is
// delegated UNCHANGED to runConfidentialBridge.
//
// BIDIRECTIONAL: the swap pill flips the route (ETH->Arb <-> Arb->ETH); both
// directional pairs are deployed, so the same widget bridges either way.
// ============================================================================
import { useState, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useAccount, useConfig, usePublicClient, useSwitchChain } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import {
  CHAIN_IDS,
  BATCHER_ABI,
  DISTRIBUTOR_ABI,
  ROUTES,
  buildRoute,
  BIDIRECTIONAL_READY,
  txUrl,
} from "../../config/contracts";
import { parseUsdc, formatUsdc, isHex } from "./format";
import { runConfidentialBridge, resumeConfidentialBridge } from "../../lib/bridge";
import { shorten } from "./shared";
import usdcSvg from "../../assets/usdc.svg";
import arbitrumSvg from "../../assets svg/1225_Arbitrum_Logomark_FullColor_ClearSpace.svg";
import "./BridgeFlow.css";

// Two automatic background fillers lift the batch to the k=3 floor. In keeper
// mode the operator contributes them (bridge.js "fill"); these are the
// SELF-FILLER FALLBACK amounts (returned to the sender on the destination),
// RANDOMIZED per bridge (0.20–0.70 cUSD each) so a fixed public constant never
// lets an observer recover the real amount as A − constant. Same range as the
// keeper's private draw in api/keeper.mjs.
const drawFillerUnits = () => 200_000n + BigInt(Math.floor(Math.random() * 51)) * 10_000n;
const MAX_AMOUNT_UNITS = 1_000_000n; // hard cap: max 1 USDC per bridge (testnet)

const STEP_GROUPS = [
  { title: "Read epoch", short: "Epoch", keys: ["epoch"] },
  { title: "Pre-register (destination)", short: "Pre-register", keys: ["switch-arb-pre", "prereg-0", "prereg-1", "prereg-2"] },
  { title: "Wrap + deposit (source)", short: "Deposit", keys: ["switch-eth", "fund", "deposit-0", "deposit-1", "deposit-2"] },
  { title: "Close epoch", short: "Close", keys: ["close"] },
  { title: "Settle + CCTP burn", short: "Settle + burn", keys: ["settle"] },
  { title: "CCTP relay", short: "CCTP relay", keys: ["relay-attest", "switch-arb-relay", "relay"] },
  { title: "Integrity check (TEE)", short: "Integrity", keys: ["check"] },
  { title: "Confidential distribution", short: "Distribute", keys: ["finalize"] },
  { title: "Done", short: "Done", keys: ["done"] },
];

const STEP_META = {
  epoch: { label: "Read current epoch" },
  "switch-arb-pre": { label: "Switch to the destination chain" },
  "prereg-0": { label: "Pre-register your transfer" },
  "prereg-1": { label: "Pre-register filler 1" },
  "prereg-2": { label: "Pre-register filler 2" },
  "switch-eth": { label: "Switch to the source chain" },
  fund: { label: "Wrap USDC → cUSDC + authorize batcher" },
  "deposit-0": { label: "Deposit your transfer (encrypted)" },
  "deposit-1": { label: "Deposit filler 1 (encrypted)" },
  "deposit-2": { label: "Deposit filler 2 (encrypted)" },
  close: { label: "Close epoch" },
  settle: { label: "Settle + CCTP fast-burn" },
  "relay-attest": { label: "Poll Circle Iris attestation" },
  "switch-arb-relay": { label: "Switch to the destination chain" },
  relay: { label: "Relay mint (relayReceive)" },
  check: { label: "Integrity check (Sum == A)" },
  finalize: { label: "Confidential distribution" },
  done: { label: "Decrypt recipient balance" },
};

// ---- inline glyphs ---------------------------------------------------------
const UsdcBadge = ({ chain, small }) => (
  <div className={`bridge-badge ${small ? "small" : ""}`}>
    <div className="bridge-badge-token">
      <img src={usdcSvg} alt="USDC" />
    </div>
    <div className="bridge-badge-chain">
      {chain === "arb" ? <img src={arbitrumSvg} alt="Arbitrum" /> : <EthGlyph />}
    </div>
  </div>
);

const EthGlyph = () => (
  <svg viewBox="0 0 24 24" width="100%" height="100%">
    <circle cx="12" cy="12" r="12" fill="#627eea" />
    <path d="M12 3.2v6.3l5.3 2.4z" fill="#fff" fillOpacity="0.6" />
    <path d="M12 3.2 6.7 11.9 12 9.5z" fill="#fff" />
    <path d="M12 16.1v4.7l5.3-7.4z" fill="#fff" fillOpacity="0.6" />
    <path d="M12 20.8v-4.7l-5.3-2.7z" fill="#fff" />
    <path d="m12 15.1 5.3-3.2L12 9.5z" fill="#fff" fillOpacity="0.2" />
    <path d="M6.7 11.9 12 15.1V9.5z" fill="#fff" fillOpacity="0.6" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="bridge-settings-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
    <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6" />
  </svg>
);

const WalletIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M18 4H6C3.79 4 2 5.79 2 8v8c0 2.21 1.79 4 4 4h12c2.21 0 4-1.79 4-4V8c0-2.21-1.79-4-4-4m-1.86 9.77c-.24.2-.57.28-.88.2L4.15 11.25C4.45 10.52 5.16 10 6 10h12c.67 0 1.26.34 1.63.84zM6 6h12c1.1 0 2 .9 2 2v.55c-.59-.34-1.27-.55-2-.55H6c-.73 0-1.41.21-2 .55V8c0-1.1.9-2 2-2" />
  </svg>
);

const SwapArrow = () => (
  <svg viewBox="0 0 24 24" fill="currentColor">
    <path d="m20 12-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8z" />
  </svg>
);

function RailNode({ status, label }) {
  const glyph =
    status === "done" ? "✓" : status === "error" ? "!" :
    status === "active" ? <span className="bf-rail-spinner" /> : "";
  // Label only under the node the user cares about (active or errored); the
  // others stay as bare dots with a tooltip — kills the 9-label clutter.
  const showLabel = status === "active" || status === "error";
  return (
    <div className={`bf-rail-node ${status}`} title={label}>
      <span className="bf-rail-dot">{glyph}</span>
      {showLabel && <span className="bf-rail-label">{label}</span>}
    </div>
  );
}

const fmtElapsed = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

// Talk to the serverless keeper (/api/keeper). Runs the permissionless back half
// so the user signs nothing after their deposits. On a deploy without the
// function (or offline), the ping fails and bridge.js falls back to the user
// signing those steps client-side — never a blocked bridge.
async function callKeeper(phase, body) {
  const r = await fetch("/api/keeper", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phase, ...body }),
  });
  if (!r.ok) throw new Error(`keeper ${phase} failed (${r.status})`);
  return r.json();
}

export default function BridgeFlow() {
  const { address, isConnected } = useAccount();
  const config = useConfig();
  const publicClientEth = usePublicClient({ chainId: CHAIN_IDS.SOURCE });
  const publicClientArb = usePublicClient({ chainId: CHAIN_IDS.DEST });
  const { switchChainAsync } = useSwitchChain();
  const clientFor = (chainId) => (chainId === CHAIN_IDS.SOURCE ? publicClientEth : publicClientArb);

  const [view, setView] = useState("bridge"); // 'bridge' | 'track'
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recipientOpen, setRecipientOpen] = useState(true);
  const [direction, setDirection] = useState(ROUTES[0].key); // 'eth-arb' | 'arb-eth'

  const [amount, setAmount] = useState("0.05");
  const [destination, setDestination] = useState("");
  const [poolMode, setPoolMode] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [sent, setSent] = useState(null);
  const [elapsed, setElapsed] = useState(null);
  const [steps, setSteps] = useState({});
  const runningRef = useRef(false);
  const startRef = useRef(0);

  const [bridges, setBridges] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [resuming, setResuming] = useState({}); // row key -> live status text

  const route = buildRoute(direction);
  const configReady = !!route.batcher && !!route.distributor && !!route.destCusdc;
  const me = address || "";
  const destAddr = (destination || "").trim() || me;
  const amountUnits = parseUsdc(amount);
  const amountTooBig = amountUnits != null && amountUnits > MAX_AMOUNT_UNITS;
  const destBad = (destination || "").trim() !== "" && !isHex(destination.trim(), 20);
  const formValid =
    isConnected && configReady && amountUnits != null && amountUnits > 0n && !amountTooBig && isHex(destAddr, 20);

  const onStep = useCallback((key, status, detail, txHash, chainId) => {
    setSteps((s) => ({
      ...s,
      [key]: { status, detail, txHash: txHash ?? s[key]?.txHash, chainId: chainId ?? s[key]?.chainId },
    }));
  }, []);

  async function run() {
    if (running || runningRef.current) return;
    setError(null);
    setResult(null);
    setSteps({});
    setElapsed(null);
    if (!isConnected) return setError("Connect your wallet to bridge.");
    if (!configReady) return setError("Bridge addresses are not configured for this direction.");
    if (amountUnits == null || amountUnits <= 0n) return setError("Enter a positive amount.");
    if (amountUnits > MAX_AMOUNT_UNITS) return setError("Max 1 USDC per bridge (testnet cap).");
    if (!isHex(destAddr, 20)) return setError("Enter a valid 0x destination address.");

    setRunning(true);
    runningRef.current = true;
    startRef.current = Date.now();
    setSent({ amount: amountUnits, dest: destAddr, route });
    setView("track");
    try {
      const transfers = [
        { recipient: destAddr, amount: amountUnits },
        { recipient: me, amount: drawFillerUnits() },
        { recipient: me, amount: drawFillerUnits() },
      ];
      const res = await runConfidentialBridge({
        getWalletClient: (chainId) => getWalletClient(config, { chainId }),
        switchChainAsync,
        publicClientSource: clientFor(route.srcChainId),
        publicClientDest: clientFor(route.dstChainId),
        transfers,
        route,
        onStep,
        keeper: callKeeper,
        poolMode,
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
    setView("bridge");
  }

  function toggleDirection() {
    if (running) return;
    const i = ROUTES.findIndex((r) => r.key === direction);
    setDirection(ROUTES[(i + 1) % ROUTES.length].key);
  }

  const groupStatus = (keys) => {
    const sts = keys.map((k) => steps[k]?.status).filter(Boolean);
    if (sts.includes("error")) return "error";
    if (sts.includes("active")) return "active";
    if (sts.length && keys.every((k) => steps[k]?.status === "done")) return "done";
    if (sts.length) return "active";
    return "pending";
  };

  // Scan BOTH directions: for each route, list the epochs on its Batcher that are
  // started but not complete on its Distributor — every bridge in flight.
  const scanBridges = useCallback(async () => {
    setScanning(true);
    setScanError(null);
    try {
      const all = [];
      for (const rd of ROUTES) {
        const r = buildRoute(rd.key);
        const srcClient = clientFor(r.srcChainId);
        const dstClient = clientFor(r.dstChainId);
        if (!srcClient || !r.batcher) continue;
        const cur = await srcClient.readContract({ address: r.batcher, abi: BATCHER_ABI, functionName: "currentEpoch" });
        const ids = [];
        for (let i = 0n; i <= cur; i++) ids.push(i);
        const rows = await Promise.all(ids.map(async (id) => {
          const b = await srcClient.readContract({ address: r.batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [id] });
          let d = null;
          if (dstClient && r.distributor) {
            try { d = await dstClient.readContract({ address: r.distributor, abi: DISTRIBUTOR_ABI, functionName: "epochInfo", args: [id] }); } catch { d = null; }
          }
          return { id, b, d };
        }));
        const dir = `${r.srcShort.toUpperCase()} → ${r.dstShort.toUpperCase()}`;
        for (const { id, b, d } of rows) {
          const bState = Number(b[0]);
          const activeCount = Number(b[1]);
          const bAgg = b[2];
          const refunded = b[3];
          const entryCount = Number(b[4]);
          const dState = d ? Number(d[0]) : 0;
          const dAgg = d ? d[1] : 0n;
          const started = entryCount > 0 || dState !== 0;
          const complete = dState === 4 || dState === 6 || refunded === true;
          if (!started || complete) continue;
          let phase, agg = null;
          if (dState >= 1) {
            agg = dAgg;
            phase =
              dState === 1 ? `Pre-registered — awaiting CCTP relay on ${r.dstLabel}` :
              dState === 2 ? "Relayed — awaiting integrity check" :
              dState === 3 ? "Checked — awaiting finalize + distribution" :
              dState === 5 ? "Integrity failed — awaiting refund to source" :
              "In progress";
          } else {
            phase =
              bState === 0 ? `Collecting deposits (${activeCount}/3)` :
              bState === 1 ? "Closed — awaiting settle + CCTP burn" :
              bState === 2 ? `Bridged via CCTP — awaiting relay on ${r.dstLabel}` :
              "In progress";
            if (bState === 2) agg = bAgg;
          }
          all.push({ id: id.toString(), dir, phase, agg, key: `${rd.key}-${id}`, routeKey: rd.key });
        }
      }
      setBridges(all);
    } catch (e) {
      setScanError(e?.shortMessage || e?.message?.slice(0, 160) || "Scan failed");
    } finally {
      setScanning(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClientEth, publicClientArb]);

  useEffect(() => {
    if (view === "track") scanBridges();
  }, [view, result, scanBridges]);

  // Resume a stuck/in-flight epoch entirely through the keeper (no signature —
  // every remaining step is permissionless). Kills the "no in-app recovery" gap.
  async function resumeRow(b) {
    if (resuming[b.key] && !/failed|✓|—/.test(resuming[b.key])) return; // already running
    setResuming((s) => ({ ...s, [b.key]: "resuming…" }));
    try {
      const r = buildRoute(b.routeKey);
      const res = await resumeConfidentialBridge({
        keeper: callKeeper,
        route: r,
        epochId: b.id,
        publicClientSource: clientFor(r.srcChainId),
        publicClientDest: clientFor(r.dstChainId),
        onStep: (_k, _st, detail) =>
          setResuming((s) => ({ ...s, [b.key]: (detail || "resuming…").slice(0, 90) })),
      });
      setResuming((s) => ({ ...s, [b.key]: res?.alreadyComplete ? "already complete ✓" : "completed ✓" }));
      scanBridges();
    } catch (e) {
      setResuming((s) => ({ ...s, [b.key]: `failed: ${(e?.shortMessage || e?.message || "error").slice(0, 110)}` }));
    }
  }

  const started = Object.keys(steps).length > 0;
  // First group that is not fully done = the step in flight (for the caption).
  const firstOpenIdx = STEP_GROUPS.findIndex((g) => groupStatus(g.keys) !== "done");
  const currentGroupIdx = firstOpenIdx === -1 ? STEP_GROUPS.length - 1 : firstOpenIdx;
  const txOf = (k) => steps[k]?.txHash;
  const usd = (Number(amount) || 0).toFixed(2);
  const sentRoute = sent?.route || route;

  const ctaLabel = !isConnected
    ? "Connect wallet"
    : !configReady
    ? "Bridge unavailable"
    : running
    ? "Bridging confidentially…"
    : "Bridge confidentially";

  return (
    <div className="bridge-widget">
      <div className="bridge-header">
        <div className="bridge-header-left">
          <span className="bridge-title">Exchange</span>
          <div className="bridge-tabs">
            <button className={`bridge-tab ${view === "bridge" ? "active" : ""}`} onClick={() => setView("bridge")}>Bridge</button>
            <button className={`bridge-tab ${view === "track" ? "active" : ""}`} onClick={() => setView("track")}>Track</button>
          </div>
        </div>
        <button className={`bridge-settings-btn ${settingsOpen ? "active" : ""}`} title="About" onClick={() => setSettingsOpen((o) => !o)}>
          <SettingsIcon />
        </button>
      </div>

      {settingsOpen && (
        <div className="bridge-settings-panel">
          <div className="bridge-settings-row">Confidential batch · <strong>k = 3</strong></div>
          <p>
            Amounts are encrypted client-side with iExec Nox (ERC-7984) and never touch the
            blockchain in cleartext. Every transfer settles inside a batch of at least three:
            the operator&apos;s keeper normally contributes two randomized fillers from its own
            funds within seconds (if it can&apos;t, you provide them yourself). Only the batch
            aggregate, a single figure, is ever made public.{" "}
            <Link to="/resources" className="bf-doclink">How it works ↗</Link>
          </p>
          <label className="bridge-pool-toggle">
            <input
              type="checkbox"
              checked={poolMode}
              disabled={running}
              onChange={(e) => setPoolMode(e.target.checked)}
            />
            <span>
              <strong>Pool mode</strong> — wait for two <em>independent</em> depositors instead
              of operator fillers. Strongest privacy (your amount is hidden among three unknown
              amounts, even from the operator), but the batch settles only once two others join.
            </span>
          </label>
        </div>
      )}

      {/* ================= BRIDGE TAB ================= */}
      {view === "bridge" && (
        <div className="bridge-body">
          {!configReady && <div className="mf-note todo">Bridge addresses are not configured for this direction.</div>}

          <div className="bridge-card">
            <div className="bridge-card-content">
              <p className="bridge-card-label">From</p>
              <div className="bridge-card-header">
                <UsdcBadge chain={route.srcShort} />
                <div className="bridge-card-text">
                  <span className="bridge-card-title">USDC</span>
                  <span className="bridge-card-subtitle">on {route.srcLabel}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bridge-swap-wrapper">
            <button
              className="bridge-swap-pill"
              onClick={toggleDirection}
              disabled={running || !BIDIRECTIONAL_READY}
              title="Reverse direction"
            >
              <SwapArrow />
            </button>
          </div>

          <div className="bridge-card">
            <div className="bridge-card-content">
              <p className="bridge-card-label">To</p>
              <div className="bridge-card-header">
                <UsdcBadge chain={route.dstShort} />
                <div className="bridge-card-text">
                  <span className="bridge-card-title">USDC</span>
                  <span className="bridge-card-subtitle">on {route.dstLabel}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bridge-send-card">
            <div className="bridge-send-header">
              <p className="bridge-send-label">Send</p>
              <span className="bridge-send-label">confidential</span>
            </div>
            <div className="bridge-send-body">
              <UsdcBadge chain={route.srcShort} small />
              <div className="bridge-send-input-area">
                <input
                  className="bridge-send-input"
                  inputMode="decimal"
                  placeholder="0"
                  autoComplete="off"
                  value={amount}
                  disabled={running}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^\d*\.?\d*$/.test(v)) setAmount(v);
                  }}
                />
                <div className="bridge-send-helper">
                  <span className="bridge-send-usd">${usd}</span>
                  <span className="bridge-send-balance" style={amountTooBig ? { color: "#ff6b6b" } : undefined}>
                    {amountTooBig ? "max 1 USDC per bridge" : "cUSD · hidden on-chain"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="bridge-actions">
            <button className="bridge-btn primary" disabled={!formValid || running} onClick={run}>
              {running && <span className="mf-spinner" />} {ctaLabel}
            </button>
            <button className={`bridge-wallet-btn ${recipientOpen ? "active" : ""}`} title="Recipient address" onClick={() => setRecipientOpen((o) => !o)}>
              <WalletIcon />
            </button>
          </div>

          <div className={`bridge-recipient-area ${recipientOpen ? "open" : ""}`}>
            <div className="bridge-recipient-card">
              <div className="bridge-recipient-header">
                <WalletIcon size={16} />
                <span className="bridge-recipient-title">
                  Recipient on {route.dstLabel} {(!destination || !destination.trim()) && "· defaults to you"}
                </span>
              </div>
              <input
                className={`bridge-recipient-input ${destBad ? "bad" : ""}`}
                placeholder={address || "0x…"}
                value={destination}
                disabled={running}
                onChange={(e) => setDestination(e.target.value)}
              />
            </div>
          </div>

          {error && <div className="mf-error" style={{ marginTop: 12 }}>{error}</div>}
        </div>
      )}

      {/* ================= TRACK TAB ================= */}
      {view === "track" && (
        <div className="bridge-body">
          {result ? (
            <div className="bf-result">
              <div className="bf-result-icon">✓</div>
              <div className="bf-result-title">Bridged confidentially</div>
              <div className="bf-result-sub">
                {sent ? formatUsdc(sent.amount) : "—"} cUSD delivered to{" "}
                {sent ? shorten(sent.dest, 6, 4) : "—"} on {sentRoute.dstLabel}.
              </div>
              {sent && (
                <div className="bf-result-reveal">
                  {formatUsdc(sent.amount)} cUSD
                  <small>delivered confidentially</small>
                </div>
              )}
              <div className="bf-result-details">
                {[
                  ["Your transfer", `${sent ? formatUsdc(sent.amount) : "—"} cUSD`],
                  ["Destination", sent ? shorten(sent.dest, 8, 6) : "—"],
                  ["Route", `${sentRoute.srcLabel} → ${sentRoute.dstLabel}`],
                  ["Public aggregate A", result.aggregate != null ? `${formatUsdc(result.aggregate)} USDC` : "—"],
                  ["Epoch", `#${result.epochId?.toString()}`],
                  ["Elapsed", elapsed != null ? fmtElapsed(elapsed) : "—"],
                ].map(([k, v]) => (
                  <div className="bf-result-row" key={k}><span className="label">{k}</span><span className="value">{v}</span></div>
                ))}
              </div>
              {(() => {
                const links = [
                  ["Deposit (encrypted)", txOf("deposit-0"), sentRoute.srcChainId],
                  ["Settle + CCTP burn", result.settleTxHash, sentRoute.srcChainId],
                  ["Relay mint", txOf("relay"), sentRoute.dstChainId],
                  ["Confidential distribution", txOf("finalize"), sentRoute.dstChainId],
                ].filter(([, h]) => !!h);
                return links.length ? (
                  <div className="bf-result-details" style={{ marginTop: 10 }}>
                    {links.map(([k, h, cid]) => (
                      <div className="bf-result-row" key={k}>
                        <span className="label">{k}</span>
                        <span className="value"><a href={txUrl(cid, h)} target="_blank" rel="noreferrer">{shorten(h, 8, 6)} ↗</a></span>
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}
              <div className="bf-result-actions"><button className="bridge-btn primary" onClick={reset}>Bridge again</button></div>
            </div>
          ) : started ? (
            <>
              <div className="bf-progress-title">Bridging cUSD confidentially</div>
              <div className="bf-rail">
                {STEP_GROUPS.map((g) => <RailNode key={g.title} status={groupStatus(g.keys)} label={g.short} />)}
              </div>
              <div className="bf-progress-caption">
                Step {currentGroupIdx + 1} of {STEP_GROUPS.length} · {STEP_GROUPS[currentGroupIdx].title}
              </div>
              <div className="bf-steps">
                {STEP_GROUPS.map((g) => {
                  const gStatus = groupStatus(g.keys);
                  // Pending phases stay off-screen (the rail already conveys them);
                  // done phases collapse to one muted line; only the phase in
                  // flight (or in error) shows its substeps.
                  if (gStatus === "pending") return null;
                  if (gStatus === "done") {
                    return (
                      <div key={g.title} className="bf-phase-mini">
                        <span className="glyph">✓</span>
                        <span className="txt">{g.title}</span>
                      </div>
                    );
                  }
                  const gGlyph = gStatus === "error" ? "!" : <span className="bf-rail-spinner" />;
                  return (
                    <div key={g.title} className={`bf-phase ${gStatus}`}>
                      <div className="bf-phase-head"><span className="bf-phase-icon">{gGlyph}</span><span className="bf-phase-title">{g.title}</span></div>
                      {g.keys.filter((k) => steps[k]).map((k) => {
                        const s = steps[k];
                        const meta = STEP_META[k] || {};
                        return (
                          <div key={k} className={`bf-substep ${s.status}`}>
                            <div className="bf-substep-line">
                              <span className="glyph">{s.status === "done" ? "✓" : s.status === "error" ? "✕" : "•"}</span>
                              <span className="txt">{meta.label || k}</span>
                            </div>
                            {s.detail && (s.status === "active" || s.status === "error") && (
                              <div className="bf-substep-detail">{s.detail}</div>
                            )}
                            {s.txHash && s.chainId && (
                              <div className="bf-substep-tx">
                                <a href={txUrl(s.chainId, s.txHash)} target="_blank" rel="noreferrer">{shorten(s.txHash, 10, 8)} ↗</a>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              {running && (
                <div className="mf-note" style={{ marginTop: 10 }}>
                  KMS reveals take a few seconds; the CCTP relay can take 1–3 min — keep this tab open.
                </div>
              )}
            </>
          ) : null}

          {/* in-flight bridges (both directions): every started epoch not complete yet */}
          <div className="bf-board">
            <div className="bf-board-head">
              <span>Bridges in progress</span>
              <button className="bf-linkbtn" onClick={scanBridges} disabled={scanning}>
                {scanning ? "Scanning…" : "Refresh"}
              </button>
            </div>
            {scanError && <div className="mf-error">{scanError}</div>}
            {!scanning && !scanError && bridges.length === 0 && (
              <div className="bf-track-empty">No bridges in progress — every started epoch is complete.</div>
            )}
            {bridges.map((b) => (
              <div className="bf-board-row" key={b.key}>
                <div className="bf-board-left">
                  <span className="bf-board-epoch">{b.dir} · Epoch #{b.id}</span>
                  <span className="bf-board-phase">{resuming[b.key] || b.phase}</span>
                </div>
                <div className="bf-board-right">
                  {b.agg != null && b.agg > 0n && (
                    <span className="bf-board-agg">A = {formatUsdc(b.agg)} USDC</span>
                  )}
                  <button
                    className="bf-linkbtn"
                    onClick={() => resumeRow(b)}
                    disabled={!!resuming[b.key] && !/failed|✓/.test(resuming[b.key])}
                    title="Drive the remaining permissionless steps through the keeper (no signature needed)"
                  >
                    {resuming[b.key] && !/failed|✓/.test(resuming[b.key]) ? "Resuming…" : "Resume"}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
