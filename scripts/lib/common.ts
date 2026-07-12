/** Shared helpers: providers, wallet, Nox handle client, artifact + deployment IO. */
import { JsonRpcProvider, Wallet, ContractFactory, Contract, Interface } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config as dotenv } from "dotenv";
dotenv();

export const CHAINS = {
  eth: { key: "eth", name: "ethSepolia", chainId: 11155111, rpc: process.env.ETH_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com" },
  arb: { key: "arb", name: "arbSepolia", chainId: 421614, rpc: process.env.ARB_SEPOLIA_RPC_URL || "https://arbitrum-sepolia-rpc.publicnode.com" },
} as const;
export type ChainKey = keyof typeof CHAINS;

// §5-pinned testnet addresses (README, corrected 2026-07-12)
export const ADDR = {
  USDC: { 11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", 421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  TOKEN_MESSENGER_V2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  MESSAGE_TRANSMITTER_V2: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  DOMAIN: { 11155111: 0, 421614: 3 },
} as const;

export const USDC_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

export function chainFromArg(def: ChainKey = "eth"): (typeof CHAINS)[ChainKey] {
  const a = process.argv.slice(2);
  const k = (a[a.indexOf("--chain") + 1] as ChainKey) ?? def;
  return CHAINS[k] ?? CHAINS[def];
}

export function connect(c: (typeof CHAINS)[ChainKey]) {
  const provider = new JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  return { provider, wallet };
}

export async function handleClient(wallet: Wallet) {
  return createEthersHandleClient(wallet);
}

export function artifact(name: string) {
  // resolve by contract name across the artifacts tree
  const paths = [
    `artifacts/contracts/${name}.sol/${name}.json`,
    `artifacts/contracts/test/${name}.sol/${name}.json`,
  ];
  for (const p of paths) if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  throw new Error(`artifact not found for ${name}`);
}

export async function deploy(name: string, wallet: Wallet, args: unknown[] = []) {
  const a = artifact(name);
  const f = new ContractFactory(a.abi, a.bytecode, wallet);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return { address: await c.getAddress(), contract: new Contract(await c.getAddress(), a.abi, wallet), iface: new Interface(a.abi) };
}

export function deployments(chainId: number): Record<string, string> {
  const f = `deployments/${chainId}.json`;
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
}
export function saveDeployment(chainId: number, key: string, address: string) {
  mkdirSync("deployments", { recursive: true });
  const f = `deployments/${chainId}.json`;
  const d = deployments(chainId);
  d[key] = address;
  writeFileSync(f, JSON.stringify(d, null, 2));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll SDK publicDecrypt until the KMS proof is available. */
export async function publicDecryptWithRetry(
  handle: any,
  hnd: string,
  timeoutMs = 180_000
): Promise<{ value: bigint; decryptionProof: string }> {
  const t0 = Date.now();
  let delay = 1500;
  for (;;) {
    try {
      const r = await handle.publicDecrypt(hnd as `0x${string}`);
      return { value: BigInt(r.value as any), decryptionProof: r.decryptionProof };
    } catch (e) {
      if (Date.now() - t0 > timeoutMs) throw e;
      await sleep(delay);
      delay = Math.min(delay * 1.4, 8000);
    }
  }
}
