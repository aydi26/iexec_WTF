// ============================================================================
// wagmi dual-chain config — Noxus
//   Source leg:      ETH Sepolia  (11155111)
//   Destination leg: Arb Sepolia  (421614)
// injected() connector + multiInjectedProviderDiscovery for EIP-6963 wallets.
// Chain-switch prompts live in <ConnectButton /> and per-view guards.
// ============================================================================

import { createConfig, http } from "wagmi";
import { sepolia, arbitrumSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [sepolia, arbitrumSepolia],
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
  transports: {
    [sepolia.id]: http("https://ethereum-sepolia-rpc.publicnode.com"),
    [arbitrumSepolia.id]: http("https://sepolia-rollup.arbitrum.io/rpc"),
  },
});
