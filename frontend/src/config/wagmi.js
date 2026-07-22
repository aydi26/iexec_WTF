// ============================================================================
// wagmi dual-chain config — Noxus
//   Source leg:      ETH Sepolia  (11155111)
//   Destination leg: Arb Sepolia  (421614)
// injected() connector + multiInjectedProviderDiscovery for EIP-6963 wallets.
// Chain-switch prompts live in <ConnectButton /> and per-view guards.
// ============================================================================

import { createConfig, http, fallback } from "wagmi";
import { sepolia, arbitrumSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

// Each chain gets a fallback() of several independent public RPCs. viem rotates
// to the next endpoint on rate-limit / 5xx / network errors and retries, so a
// single provider throttling (e.g. the Tenderly gateway some wallets default to)
// never blocks the app's reads or receipt polling. These transports drive the
// app's OWN reads — a wallet still broadcasts through ITS configured RPC, which
// is why the widget also surfaces guidance to switch a rate-limited wallet RPC.
// RPC_URLS is exported so bridge.js can pin the Nox SDK's on-chain reads to the
// same resilient pool (never the wallet's RPC).
// CORS-safe endpoints. A private Alchemy Sepolia URL (if provided via the
// VITE_ALCHEMY_SEPOLIA build env — the value lives only in .env / Vercel env,
// never in source) is preferred for its high rate limits. IMPORTANT: the app
// deliberately does NOT put publicnode first — many wallets (Rabby/MetaMask)
// default to publicnode, and the app + the wallet share one IP's rate budget;
// leading with Alchemy/drpc for the app's OWN reads leaves the wallet's
// publicnode budget for its txs. (viem fallback still rotates on any 429.)
const ALCHEMY_SEPOLIA = import.meta.env.VITE_ALCHEMY_SEPOLIA;
export const RPC_URLS = {
  [sepolia.id]: [
    ...(ALCHEMY_SEPOLIA ? [ALCHEMY_SEPOLIA] : []),
    "https://sepolia.drpc.org",
    "https://rpc.ankr.com/eth_sepolia",
    "https://ethereum-sepolia-rpc.publicnode.com",
  ],
  [arbitrumSepolia.id]: [
    "https://arbitrum-sepolia.drpc.org",
    "https://sepolia-rollup.arbitrum.io/rpc",
    "https://arbitrum-sepolia-rpc.publicnode.com",
  ],
};

export const config = createConfig({
  chains: [sepolia, arbitrumSepolia],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: {
    [sepolia.id]: fallback([...RPC_URLS[sepolia.id].map((u) => http(u)), http()]),
    [arbitrumSepolia.id]: fallback([...RPC_URLS[arbitrumSepolia.id].map((u) => http(u)), http()]),
  },
});
