// ============================================================================
// Noxus container — the "/" route. Reuses the Noxus shell's card/glass
// styling (mf-shell mirrors the bridge-widget card language) and hosts the five
// Noxus views behind a tab bar.
// ============================================================================
import { useState } from "react";
import BridgeFlow from "./noxus/BridgeFlow";
import DepositView from "./noxus/DepositView";
import EpochDashboard from "./noxus/EpochDashboard";
import DecryptView from "./noxus/DecryptView";
import AuditorView from "./noxus/AuditorView";
import KeeperView from "./noxus/KeeperView";
import "./Noxus.css";

const TABS = [
  { key: "bridge", label: "Bridge", el: BridgeFlow },
  { key: "deposit", label: "Deposit", el: DepositView },
  { key: "epochs", label: "Epochs", el: EpochDashboard },
  { key: "decrypt", label: "Decrypt", el: DecryptView },
  { key: "auditor", label: "Auditor", el: AuditorView },
  { key: "keeper", label: "Keeper", el: KeeperView },
];

export default function Noxus() {
  const [tab, setTab] = useState("bridge");
  const Active = TABS.find((t) => t.key === tab)?.el ?? BridgeFlow;

  return (
    <div className="mf-shell">
      <div className="mf-header">
        <div className="mf-brand">
          <span className="mf-title">Noxus</span>
          <span className="mf-subtitle" style={{ margin: 0 }}>
            confidential USDC settlement
          </span>
        </div>
        <div className="mf-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`mf-tab ${tab === t.key ? "active" : ""}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mf-body">
        <Active />
      </div>
    </div>
  );
}
