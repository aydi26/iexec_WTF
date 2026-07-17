// Shared UI primitives for the Noxus views.
import { useState, useCallback } from "react";
import { useAccount, useChainId, useConnect, useSwitchChain } from "wagmi";
import { EPOCH_STATE, txUrl } from "../../config/contracts";

/** Short-form an address / hash for display. */
export function shorten(v, head = 6, tail = 4) {
  if (!v) return "";
  const s = String(v);
  if (s.length <= head + tail + 2) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/** Small lock glyph reused in the "amount is hidden" callouts. */
export function LockIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z" />
    </svg>
  );
}

/**
 * Guards a view against not-connected / wrong-chain states.
 * Renders a prompt (connect / switch) and returns `blocked` so the caller can
 * short-circuit. Pass the chainId the view needs to operate on.
 */
export function ChainGuard({ requiredChainId, chainName }) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { connect, connectors } = useConnect();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected) {
    return (
      <div className="mf-guard">
        <span className="mf-guard-text">Connect your wallet to continue.</span>
        <button
          className="mf-btn primary sm"
          onClick={() => connect({ connector: connectors[0] })}
          disabled={!connectors[0]}
        >
          Connect Wallet
        </button>
      </div>
    );
  }

  if (requiredChainId && chainId !== requiredChainId) {
    return (
      <div className="mf-guard">
        <span className="mf-guard-text">
          This action runs on {chainName}. Switch network to continue.
        </span>
        <button
          className="mf-btn warn sm"
          onClick={() => switchChain({ chainId: requiredChainId })}
          disabled={isPending}
        >
          {isPending ? "Switching…" : `Switch to ${chainName}`}
        </button>
      </div>
    );
  }
  return null;
}

/** Returns true if connected AND on the required chain (no render). */
export function useChainReady(requiredChainId) {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  return isConnected && (!requiredChainId || chainId === requiredChainId);
}

/** A tx status line: pending spinner -> confirmed check, with explorer link. */
export function TxStatus({ label, hash, isPending, isConfirming, isSuccess, isError, error, chainId }) {
  if (!hash && !isPending && !error) return null;
  return (
    <div className="mf-tx">
      <div className="mf-row" style={{ padding: 0 }}>
        <span className="k">{label}</span>
        <span className="v">
          {isPending && (
            <span style={{ color: "#ffb900" }}>
              <span className="mf-spinner" /> awaiting signature…
            </span>
          )}
          {isConfirming && (
            <span style={{ color: "#ffb900" }}>
              <span className="mf-spinner" /> confirming…
            </span>
          )}
          {isSuccess && <span style={{ color: "#F5D64B" }}> confirmed</span>}
          {isError && <span style={{ color: "#ff6b6b" }}>reverted</span>}
        </span>
      </div>
      {hash && (
        <div className="mf-tx-hash" style={{ marginTop: 6 }}>
          <a href={txUrl(chainId, hash)} target="_blank" rel="noreferrer">
            {shorten(hash, 12, 10)} ↗
          </a>
        </div>
      )}
      {error && <div className="mf-error" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}

/**
 * Small state machine for a single on-chain action: hash + phase + error, plus a
 * `run(fn)` that executes an async write returning a tx hash and (optionally)
 * waits for the receipt. Views get consistent pending/confirming/success states
 * and a clickable explorer link for free (feed the returned object to <TxStatus/>).
 */
export function useTxAction(chainId) {
  const [state, setState] = useState({
    hash: undefined,
    isPending: false,
    isConfirming: false,
    isSuccess: false,
    isError: false,
    error: null,
  });

  const reset = useCallback(
    () =>
      setState({
        hash: undefined,
        isPending: false,
        isConfirming: false,
        isSuccess: false,
        isError: false,
        error: null,
      }),
    []
  );

  /**
   * @param {() => Promise<`0x${string}`>} send - fires the write, resolves to a tx hash.
   * @param {{ wait?: (hash) => Promise<any> }} [opts] - optional receipt waiter.
   */
  const run = useCallback(async (send, opts = {}) => {
    setState({
      hash: undefined,
      isPending: true,
      isConfirming: false,
      isSuccess: false,
      isError: false,
      error: null,
    });
    try {
      const hash = await send();
      setState((s) => ({ ...s, hash, isPending: false, isConfirming: !!opts.wait }));
      if (opts.wait) {
        const receipt = await opts.wait(hash);
        const reverted = receipt && receipt.status === "reverted";
        setState((s) => ({
          ...s,
          isConfirming: false,
          isSuccess: !reverted,
          isError: !!reverted,
          error: reverted ? "Transaction reverted on-chain." : null,
        }));
      }
      return hash;
    } catch (err) {
      const msg = err?.shortMessage || err?.message || "Transaction failed";
      setState((s) => ({
        ...s,
        isPending: false,
        isConfirming: false,
        isError: true,
        error: msg.slice(0, 220),
      }));
      throw err;
    }
  }, []);

  return { ...state, chainId, run, reset };
}

/** Epoch state -> label + badge class. */
export function epochStateBadge(stateNum) {
  const label = EPOCH_STATE[stateNum] ?? `state ${stateNum}`;
  const cls = String(label).toLowerCase();
  return (
    <span className={`mf-badge ${cls}`}>
      <span className="dot" />
      {label}
    </span>
  );
}
