// Header faucet button — a small dropdown linking to the testnet faucets a user
// needs to bridge: USDC (Circle) on the source chain, plus gas on both chains.
// There is no separate cUSD faucet: the widget wraps plain USDC automatically.
import { useState, useRef, useEffect } from "react";
import "./FaucetButton.css";

const FAUCETS = [
  { label: "USDC · Circle faucet", sub: "20 USDC / 2h per chain", url: "https://faucet.circle.com" },
  { label: "ETH gas · Ethereum Sepolia", sub: "for source-side transactions", url: "https://sepoliafaucet.com" },
  { label: "ETH gas · Arbitrum Sepolia", sub: "for destination-side transactions", url: "https://faucet.quicknode.com/arbitrum/sepolia" },
];

const DropIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />
  </svg>
);

export default function FaucetButton() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Close on any outside click (same behavior as the header menu).
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="faucet-wrapper" ref={wrapRef}>
      <button
        className={`faucet-btn ${open ? "active" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Get testnet funds"
      >
        <DropIcon />
        Faucet
      </button>

      {open && (
        <div className="faucet-menu">
          <div className="faucet-menu-title">Get testnet funds</div>
          {FAUCETS.map((f) => (
            <a
              key={f.url}
              className="faucet-item"
              href={f.url}
              target="_blank"
              rel="noreferrer"
              onClick={() => setOpen(false)}
            >
              <span className="faucet-item-label">{f.label}</span>
              <span className="faucet-item-sub">{f.sub}</span>
            </a>
          ))}
          <div className="faucet-menu-note">
            The widget wraps USDC into confidential cUSD automatically.
          </div>
        </div>
      )}
    </div>
  );
}
