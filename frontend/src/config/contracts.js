// ============================================================================
// Manifold — deployed addresses + ABIs
// ----------------------------------------------------------------------------
// Confidential cross-chain USDC settlement over Circle CCTP V2 + iExec Nox.
//   Source leg:      ETH Sepolia  (11155111) — ManifoldBatcher + ManifoldCUSDC
//   Destination leg: Arb Sepolia  (421614)   — ManifoldDistributor + ManifoldCUSDC
//
// Addresses are read from the repo's deployments/<chainId>.json (copied into
// src/deployments during the build). We read *defensively*: the 421614 file and
// the ManifoldDistributor may not exist yet, so everything falls back gracefully
// with a clearly-marked TODO for the contracts team to wire.
// ============================================================================

import { sepolia, arbitrumSepolia } from "viem/chains";

import ManifoldBatcherAbi from "../abis/ManifoldBatcher.json";
import ManifoldCUSDCAbi from "../abis/ManifoldCUSDC.json";
// TODO(contracts): ManifoldDistributor ABI does not exist yet. This is a
// clearly-marked placeholder. Replace src/abis/ManifoldDistributor.placeholder.json
// with the real compiled ABI (artifacts/contracts/ManifoldDistributor.sol/…json)
// once the destination-leg contract is deployed, and re-point this import.
import ManifoldDistributorAbi from "../abis/ManifoldDistributor.placeholder.json";

// Deployment manifests copied from repo root /deployments.
import sepoliaDeployment from "../deployments/11155111.json";

// TODO(contracts): 421614.json (Arb Sepolia destination) does not exist yet.
// import.meta.glob resolves to an empty map when the file is absent, so the build
// never breaks. When the Distributor is deployed, drop src/deployments/421614.json
// in and this picks it up automatically.
const destModules = import.meta.glob("../deployments/421614.json", { eager: true });
const arbSepoliaDeployment =
  destModules["../deployments/421614.json"]?.default || {};

export const CHAIN_IDS = {
  SOURCE: sepolia.id, // 11155111 — ETH Sepolia (deposit / batching leg)
  DEST: arbitrumSepolia.id, // 421614   — Arb Sepolia (distribute leg)
};

export const CHAINS = { sepolia, arbitrumSepolia };

// ---------------------------------------------------------------------------
// Address resolution (defensive)
// ---------------------------------------------------------------------------
const pick = (obj, ...keys) => {
  for (const k of keys) {
    if (obj && obj[k]) return obj[k];
  }
  return undefined;
};

export const ADDRESSES = {
  [CHAIN_IDS.SOURCE]: {
    ManifoldBatcher: pick(sepoliaDeployment, "ManifoldBatcher"),
    ManifoldCUSDC: pick(sepoliaDeployment, "ManifoldCUSDC"),
  },
  [CHAIN_IDS.DEST]: {
    // TODO(contracts): populate from deployments/421614.json once it exists.
    ManifoldDistributor: pick(arbSepoliaDeployment, "ManifoldDistributor"),
    ManifoldCUSDC: pick(arbSepoliaDeployment, "ManifoldCUSDC"),
  },
};

// Convenience source-leg exports (most views run on ETH Sepolia).
export const BATCHER_ADDRESS = ADDRESSES[CHAIN_IDS.SOURCE].ManifoldBatcher;
export const CUSDC_ADDRESS = ADDRESSES[CHAIN_IDS.SOURCE].ManifoldCUSDC;
export const DISTRIBUTOR_ADDRESS =
  ADDRESSES[CHAIN_IDS.DEST].ManifoldDistributor; // may be undefined (TODO)

export const CUSDC_DECIMALS = 6; // amounts entered/displayed in USDC (6 decimals)

// setOperator far-future expiry (max uint48).
export const FAR_FUTURE_EXPIRY = 281474976710655n; // 2^48 - 1

// ---------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------
export const BATCHER_ABI = ManifoldBatcherAbi;
export const CUSDC_ABI = ManifoldCUSDCAbi;
// TODO(contracts): placeholder — see import note above.
export const DISTRIBUTOR_ABI = ManifoldDistributorAbi;

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
export const EXPLORERS = {
  [CHAIN_IDS.SOURCE]: "https://sepolia.etherscan.io",
  [CHAIN_IDS.DEST]: "https://sepolia.arbiscan.io",
};

export const txUrl = (chainId, hash) =>
  `${EXPLORERS[chainId] || EXPLORERS[CHAIN_IDS.SOURCE]}/tx/${hash}`;

export const addressUrl = (chainId, addr) =>
  `${EXPLORERS[chainId] || EXPLORERS[CHAIN_IDS.SOURCE]}/address/${addr}`;

// Epoch state enum (matches ManifoldBatcher.epochInfo() -> state uint8).
export const EPOCH_STATE = {
  0: "Open",
  1: "Closed",
  2: "Settled",
  3: "Refunded",
};
