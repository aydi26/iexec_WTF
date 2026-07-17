// ============================================================================
// Epoch dashboard — reads currentEpoch() + epochInfo(epochId) via a public
// client on ETH Sepolia. Auto-refreshes every ~12s. The aggregate A is the only
// public number and is 0 until the epoch settles, so we show "hidden until
// settle" in that case.
// ============================================================================
import { useState, useEffect, useCallback } from "react";
import { usePublicClient } from "wagmi";
import {
  CHAIN_IDS,
  BATCHER_ADDRESS,
  BATCHER_ABI,
  EPOCH_STATE,
  addressUrl,
} from "../../config/contracts";
import { formatUsdc } from "./format";
import { epochStateBadge, shorten } from "./shared";

const REFRESH_MS = 12000;

export default function EpochDashboard() {
  const publicClient = usePublicClient({ chainId: CHAIN_IDS.SOURCE });
  const [viewEpoch, setViewEpoch] = useState(null); // null = follow current
  const [current, setCurrent] = useState(null);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const ready = !!BATCHER_ADDRESS && !!publicClient;

  const load = useCallback(async () => {
    if (!ready) return;
    try {
      const cur = await publicClient.readContract({
        address: BATCHER_ADDRESS,
        abi: BATCHER_ABI,
        functionName: "currentEpoch",
      });
      setCurrent(cur);
      const epochId = viewEpoch != null ? viewEpoch : cur;
      const i = await publicClient.readContract({
        address: BATCHER_ADDRESS,
        abi: BATCHER_ABI,
        functionName: "epochInfo",
        args: [epochId],
      });
      // epochInfo -> [state, activeCount, aggregate, refunded, entryCount]
      setInfo({
        state: Number(i[0]),
        activeCount: Number(i[1]),
        aggregate: i[2],
        refunded: i[3],
        entryCount: Number(i[4]),
        epochId,
      });
      setError(null);
      setLastUpdated(Date.now());
    } catch (err) {
      setError(err?.shortMessage || err?.message?.slice(0, 180) || "Read failed");
    } finally {
      setLoading(false);
    }
  }, [ready, publicClient, viewEpoch]);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const settled = info && info.state === 2;
  const aggregateHidden = info && (info.aggregate === 0n || !settled);

  return (
    <div>
      <div className="mf-view-title">Epoch dashboard</div>
      <div className="mf-view-desc">
        Live state of the batcher's epochs on ETH Sepolia. Depositor count is
        public; the aggregate <strong>A</strong> stays hidden until the epoch is
        settled. Auto-refreshes every 12s.
      </div>

      {!BATCHER_ADDRESS && (
        <div className="mf-note todo">Batcher address not configured.</div>
      )}

      {ready && (
        <>
          <div className="mf-card">
            <div className="mf-row" style={{ padding: 0 }}>
              <span className="k">Current epoch</span>
              <span className="v">
                {current != null ? `#${current.toString()}` : "…"}
              </span>
            </div>
          </div>

          <div className="mf-field">
            <label className="mf-field-label">
              Inspect epoch (blank = follow current)
            </label>
            <input
              className="mf-input mono"
              placeholder={current != null ? `${current.toString()}` : "epoch id"}
              value={viewEpoch != null ? viewEpoch.toString() : ""}
              onChange={(e) => {
                const v = e.target.value.trim();
                if (v === "") return setViewEpoch(null);
                if (/^\d+$/.test(v)) setViewEpoch(BigInt(v));
              }}
            />
          </div>

          {loading && !info ? (
            <div className="mf-list-empty">Loading epoch…</div>
          ) : info ? (
            <div className="mf-card">
              <div className="mf-row">
                <span className="k">Epoch</span>
                <span className="v">#{info.epochId.toString()}</span>
              </div>
              <div className="mf-row">
                <span className="k">State</span>
                <span className="v">{epochStateBadge(info.state)}</span>
              </div>
              <div className="mf-row">
                <span className="k">Depositors (active)</span>
                <span className="v">{info.activeCount}</span>
              </div>
              <div className="mf-row">
                <span className="k">Total entries</span>
                <span className="v">{info.entryCount}</span>
              </div>
              <div className="mf-row">
                <span className="k">Aggregate A</span>
                <span className="v">
                  {aggregateHidden ? (
                    <span style={{ color: "#8a8a8e" }}>hidden until settle</span>
                  ) : (
                    `${formatUsdc(info.aggregate)} USDC`
                  )}
                </span>
              </div>
              <div className="mf-row">
                <span className="k">Refunded</span>
                <span className="v">{info.refunded ? "yes" : "no"}</span>
              </div>
            </div>
          ) : null}

          {error && <div className="mf-error">{error}</div>}

          <div className="mf-row" style={{ padding: "4px 0 0" }}>
            <span className="k">
              {lastUpdated
                ? `updated ${new Date(lastUpdated).toLocaleTimeString()}`
                : ""}
            </span>
            <span className="v">
              <button
                className="mf-btn ghost sm"
                style={{ padding: "3px 10px", fontSize: 11 }}
                onClick={load}
              >
                Refresh
              </button>
            </span>
          </div>

          <div className="mf-hint" style={{ marginTop: 8 }}>
            Batcher{" "}
            <a
              href={addressUrl(CHAIN_IDS.SOURCE, BATCHER_ADDRESS)}
              target="_blank"
              rel="noreferrer"
              style={{ color: "#F5D64B" }}
            >
              {shorten(BATCHER_ADDRESS, 8, 6)} ↗
            </a>{" "}
            · state map: {Object.entries(EPOCH_STATE).map(([k, v]) => `${k}=${v}`).join("  ")}
          </div>
        </>
      )}
    </div>
  );
}
