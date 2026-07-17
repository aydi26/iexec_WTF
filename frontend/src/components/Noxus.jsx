// ============================================================================
// Noxus container — the "/" route. The app is a SINGLE confidential bridge
// widget: everything (wrap, pre-register, deposit, batch, CCTP bridge, integrity
// check, distribution) runs in the background of BridgeFlow. The full technical
// flow is documented on the Resources page.
// ============================================================================
import BridgeFlow from "./noxus/BridgeFlow";
import "./Noxus.css";

export default function Noxus() {
  return (
    <div className="mf-shell">
      <div className="mf-body">
        <BridgeFlow />
      </div>
    </div>
  );
}
