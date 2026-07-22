// ============================================================================
// Noxus — deployed addresses + ABIs
// ----------------------------------------------------------------------------
// Confidential cross-chain USDC settlement over Circle CCTP V2 + iExec Nox.
//   Source leg:      ETH Sepolia  (11155111) — NoxusBatcher + NoxusCUSDC
//   Destination leg: Arb Sepolia  (421614)   — NoxusDistributor + NoxusCUSDC
//
// Addresses are read from the repo's deployments/<chainId>.json (copied into
// src/deployments during the build). Both legs are deployed, wired, and
// Sourcify-verified; we still read the destination manifest defensively via glob.
// ============================================================================

import { sepolia, arbitrumSepolia } from "viem/chains";

import NoxusBatcherAbi from "../abis/NoxusBatcher.json";
import NoxusCUSDCAbi from "../abis/NoxusCUSDC.json";
import NoxusDistributorAbi from "../abis/NoxusDistributor.json";

// Deployment manifests copied from repo root /deployments.
import sepoliaDeployment from "../deployments/11155111.json";

// Destination (Arb Sepolia) manifest, read via glob so a missing file never
// breaks the build.
const destModules = import.meta.glob("../deployments/421614.json", { eager: true });
const arbSepoliaDeployment =
  destModules["../deployments/421614.json"]?.default || {};

export const CHAIN_IDS = {
  SOURCE: sepolia.id, // 11155111 — ETH Sepolia (deposit / batching leg)
  DEST: arbitrumSepolia.id, // 421614   — Arb Sepolia (distribute leg)
};


// ---------------------------------------------------------------------------
// Address resolution (defensive)
// ---------------------------------------------------------------------------
const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k]) return obj[k];
  }
  return undefined;
};

// Both chains now host BOTH a Batcher and a Distributor, so the bridge runs in
// either direction (ETH->Arb and Arb->ETH).
const ADDRESSES = {
  [CHAIN_IDS.SOURCE]: {
    NoxusBatcher: pick(sepoliaDeployment, "NoxusBatcher"),
    NoxusDistributor: pick(sepoliaDeployment, "NoxusDistributor"),
    NoxusCUSDC: pick(sepoliaDeployment, "NoxusCUSDC"),
  },
  [CHAIN_IDS.DEST]: {
    NoxusBatcher: pick(arbSepoliaDeployment, "NoxusBatcher"),
    NoxusDistributor: pick(arbSepoliaDeployment, "NoxusDistributor"),
    NoxusCUSDC: pick(arbSepoliaDeployment, "NoxusCUSDC"),
  },
};

export const CUSDC_DECIMALS = 6; // amounts entered/displayed in USDC (6 decimals)

// setOperator far-future expiry (max uint48).
export const FAR_FUTURE_EXPIRY = 281474976710655n; // 2^48 - 1

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------
export const BATCHER_ABI = NoxusBatcherAbi;
export const CUSDC_ABI = NoxusCUSDCAbi;
export const DISTRIBUTOR_ABI = NoxusDistributorAbi;

// Minimal ERC-20 ABI (approve/allowance/balanceOf on the underlying USDC).
export const ERC20_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
];

// ---------------------------------------------------------------------------
// Explorers
// ---------------------------------------------------------------------------
const EXPLORERS = {
  [CHAIN_IDS.SOURCE]: "https://sepolia.etherscan.io",
  [CHAIN_IDS.DEST]: "https://sepolia.arbiscan.io",
};

export const txUrl = (chainId, hash) =>
  `${EXPLORERS[chainId] || EXPLORERS[CHAIN_IDS.SOURCE]}/tx/${hash}`;

// ---------------------------------------------------------------------------
// Multi-chain / bidirectional routing
// ---------------------------------------------------------------------------
// Underlying USDC + CCTP domain + display metadata per chain.
const USDC_BY_CHAIN = {
  [CHAIN_IDS.SOURCE]: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // ETH Sepolia
  [CHAIN_IDS.DEST]: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Arb Sepolia
};
const CCTP_DOMAIN = {
  [CHAIN_IDS.SOURCE]: 0, // Ethereum
  [CHAIN_IDS.DEST]: 3, // Arbitrum
};
const CHAIN_LABEL = {
  [CHAIN_IDS.SOURCE]: "Ethereum Sepolia",
  [CHAIN_IDS.DEST]: "Arbitrum Sepolia",
};
const CHAIN_SHORT = {
  [CHAIN_IDS.SOURCE]: "eth",
  [CHAIN_IDS.DEST]: "arb",
};

// The available bridge directions. The Batcher sits on the source chain, the
// Distributor on the destination chain.
export const ROUTES = [
  { key: "eth-arb", srcChainId: CHAIN_IDS.SOURCE, dstChainId: CHAIN_IDS.DEST },
  { key: "arb-eth", srcChainId: CHAIN_IDS.DEST, dstChainId: CHAIN_IDS.SOURCE },
];

// Build the full descriptor runConfidentialBridge consumes for a given direction.
export function buildRoute(routeKey) {
  const r = ROUTES.find((x) => x.key === routeKey) || ROUTES[0];
  const s = r.srcChainId;
  const d = r.dstChainId;
  return {
    key: r.key,
    srcChainId: s,
    dstChainId: d,
    srcDomain: CCTP_DOMAIN[s],
    dstDomain: CCTP_DOMAIN[d],
    batcher: ADDRESSES[s]?.NoxusBatcher,
    distributor: ADDRESSES[d]?.NoxusDistributor,
    cusdc: ADDRESSES[s]?.NoxusCUSDC,
    destCusdc: ADDRESSES[d]?.NoxusCUSDC,
    usdc: USDC_BY_CHAIN[s],
    srcLabel: CHAIN_LABEL[s],
    dstLabel: CHAIN_LABEL[d],
    srcShort: CHAIN_SHORT[s],
    dstShort: CHAIN_SHORT[d],
  };
}

// True when both directional pairs are wired (enables the swap toggle).
export const BIDIRECTIONAL_READY =
  !!ADDRESSES[CHAIN_IDS.SOURCE].NoxusBatcher &&
  !!ADDRESSES[CHAIN_IDS.SOURCE].NoxusDistributor &&
  !!ADDRESSES[CHAIN_IDS.DEST].NoxusBatcher &&
  !!ADDRESSES[CHAIN_IDS.DEST].NoxusDistributor;
