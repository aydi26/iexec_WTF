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
export const config = createConfig({
  chains: [sepolia, arbitrumSepolia],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: {
    [sepolia.id]: fallback([
      http("https://ethereum-sepolia-rpc.publicnode.com"),
      http("https://sepolia.drpc.org"),
      http("https://1rpc.io/sepolia"),
      http("https://rpc.sepolia.org"),
      http(), // viem default (chain-listed RPC) as a last resort
    ]),
    [arbitrumSepolia.id]: fallback([
      http("https://sepolia-rollup.arbitrum.io/rpc"),
      http("https://arbitrum-sepolia-rpc.publicnode.com"),
      http("https://arbitrum-sepolia.drpc.org"),
      http(),
    ]),
  },
});
