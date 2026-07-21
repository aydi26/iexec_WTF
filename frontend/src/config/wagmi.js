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
export const RPC_URLS = {
  [sepolia.id]: [
    "https://ethereum-sepolia-rpc.publicnode.com",
    "https://sepolia.drpc.org",
    "https://1rpc.io/sepolia",
    "https://rpc.sepolia.org",
  ],
  [arbitrumSepolia.id]: [
    "https://sepolia-rollup.arbitrum.io/rpc",
    "https://arbitrum-sepolia-rpc.publicnode.com",
    "https://arbitrum-sepolia.drpc.org",
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
