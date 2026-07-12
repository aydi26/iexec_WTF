/**
 * Phase 0c/0d — keyless infra probes (docs/PLAN.md).
 * Probes Nox gateway + both subgraphs + status page, pins CCTP on-chain getters
 * on BOTH chains via public RPCs, and reads live Iris testnet fees.
 * No private keys required. Results: stdout table + docs/day0/probe-<ts>.json.
 */
import { JsonRpcProvider, Contract } from "ethers";
import { writeFileSync, mkdirSync } from "node:fs";
import { config as dotenv } from "dotenv";
dotenv();

const ETH_RPC = process.env.ETH_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const ARB_RPC = process.env.ARB_SEPOLIA_RPC_URL ?? "https://arbitrum-sepolia-rpc.publicnode.com";

// §5-pinned endpoints/addresses (README, corrected 2026-07-12)
const GATEWAY = "https://gateway-testnets.noxprotocol.dev";
const STATUS_PAGE = "https://status.noxprotocol.io";
const SUBGRAPH_ETH =
  "https://thegraph.ethereum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/9CsccKwvgYFo72zZeU4k4wj2NEBLdWhVE3EUandgmzgo";
const SUBGRAPH_ARB =
  "https://thegraph.arbitrum-sepolia-testnet.noxprotocol.io/api/subgraphs/id/BjQAX2HpmsSAzURJimKDhjZZnkSJtaczA8RPumggrStb";
const IRIS = "https://iris-api-sandbox.circle.com";

const MESSAGE_TRANSMITTER_V2 = "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275"; // both chains
const TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA"; // both chains
const NOX_COMPUTE: Record<string, string> = {
  ethSepolia: "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF",
  arbSepolia: "0xd464B198f06756a1d00be223634b85E0a731c229",
};

const TRANSMITTER_ABI = [
  "function maxMessageBodySize() view returns (uint256)",
  "function localDomain() view returns (uint32)",
  "function version() view returns (uint32)",
];

type Result = { probe: string; ok: boolean; value: string; ms: number };
const results: Result[] = [];

async function probe(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const value = await fn();
    results.push({ probe: name, ok: true, value, ms: Date.now() - t0 });
  } catch (e: any) {
    results.push({ probe: name, ok: false, value: String(e?.message ?? e).slice(0, 200), ms: Date.now() - t0 });
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), ...init });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function subgraphHead(url: string): Promise<{ block: number; errors: boolean }> {
  const body = JSON.stringify({ query: "{ _meta { block { number } hasIndexingErrors } }" });
  const json = await fetchJson(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 150)}`);
  const meta = json.data?._meta;
  if (!meta?.block?.number) throw new Error(`unexpected shape: ${JSON.stringify(json).slice(0, 150)}`);
  return { block: Number(meta.block.number), errors: Boolean(meta.hasIndexingErrors) };
}

async function main() {
  const eth = new JsonRpcProvider(ETH_RPC);
  const arb = new JsonRpcProvider(ARB_RPC);

  // ---- Nox infra (0c) ----
  await probe("nox.gateway", async () => {
    const j = await fetchJson(GATEWAY);
    return typeof j === "string" ? j.slice(0, 120) : JSON.stringify(j).slice(0, 160);
  });
  await probe("nox.statusPage", async () => {
    const t = await fetchJson(STATUS_PAGE);
    const s = typeof t === "string" ? t : JSON.stringify(t);
    const operational = /operational/i.test(s);
    return `HTTP 200, mentions "operational": ${operational}`;
  });

  const [ethHead, arbHead] = await Promise.all([eth.getBlockNumber(), arb.getBlockNumber()]);
  await probe("nox.subgraph.ethSepolia", async () => {
    const { block, errors } = await subgraphHead(SUBGRAPH_ETH);
    return `indexed=${block} chainHead=${ethHead} lag=${ethHead - block} blocks (~${(ethHead - block) * 12}s) indexingErrors=${errors}`;
  });
  await probe("nox.subgraph.arbSepolia", async () => {
    const { block, errors } = await subgraphHead(SUBGRAPH_ARB);
    return `indexed=${block} chainHead=${arbHead} lag=${arbHead - block} blocks indexingErrors=${errors}`;
  });

  // NoxCompute + CCTP bytecode presence
  for (const [chain, provider] of [["ethSepolia", eth], ["arbSepolia", arb]] as const) {
    await probe(`nox.compute.code.${chain}`, async () => {
      const code = await provider.getCode(NOX_COMPUTE[chain]);
      if (code === "0x") throw new Error("no code at NoxCompute address");
      return `code ${Math.floor((code.length - 2) / 2)} bytes (proxy)`;
    });
    await probe(`cctp.tokenMessenger.code.${chain}`, async () => {
      const code = await provider.getCode(TOKEN_MESSENGER_V2);
      if (code === "0x") throw new Error("no code at TokenMessengerV2 address");
      return `code ${Math.floor((code.length - 2) / 2)} bytes`;
    });
  }

  // ---- CCTP on-chain getters, BOTH chains (0d — send-side ETH Sepolia value binds hookData) ----
  for (const [chain, provider, expectedDomain] of [
    ["ethSepolia", eth, 0],
    ["arbSepolia", arb, 3],
  ] as const) {
    await probe(`cctp.transmitter.${chain}`, async () => {
      const c = new Contract(MESSAGE_TRANSMITTER_V2, TRANSMITTER_ABI, provider);
      const [maxBody, domain, version] = await Promise.all([
        c.maxMessageBodySize(),
        c.localDomain(),
        c.version(),
      ]);
      const domainOk = Number(domain) === expectedDomain;
      return `maxMessageBodySize=${maxBody} localDomain=${domain} (expected ${expectedDomain}: ${domainOk}) version=${version}`;
    });
  }

  // ---- Iris sandbox (0d) ----
  await probe("iris.fees.eth->arb (0->3)", async () => {
    const j = await fetchJson(`${IRIS}/v2/burn/USDC/fees/0/3`);
    return JSON.stringify(j).slice(0, 240);
  });
  await probe("iris.fees.arb->eth (3->0)", async () => {
    const j = await fetchJson(`${IRIS}/v2/burn/USDC/fees/3/0`);
    return JSON.stringify(j).slice(0, 240);
  });
  await probe("iris.fastBurn.allowance", async () => {
    const j = await fetchJson(`${IRIS}/v2/fastBurn/USDC/allowance`);
    return JSON.stringify(j).slice(0, 160);
  });

  // ---- report ----
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("\n=== Day-0 keyless probes — " + new Date().toISOString() + " ===\n");
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${pad(r.probe, 36)} ${String(r.ms).padStart(6)}ms  ${r.value}`);
  }
  const failures = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failures}/${results.length} probes passed`);

  mkdirSync("docs/day0", { recursive: true });
  const file = `docs/day0/probe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
  console.log(`saved: ${file}`);
  process.exit(failures > 0 ? 1 : 0);
}

main();
