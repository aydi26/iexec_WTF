/**
 * Phase 0b — Nox latency GO/NO-GO bench (docs/PLAN.md §2 Phase 0b).
 * Deploys BenchHarness (cached per chain) and times the real Nox round-trip.
 * Metrics (median + p90 + success over N runs), per chain:
 *   1 encryptInput wall time (+ proof size)     2 fromExternal (ingest) tx confirm
 *   3 encrypted-op (addToSum) tx confirm         4 client-decrypt RTT (allow -> SDK decrypt)
 *   5 idle-handle reveal RTT (allowPublicDecryption -> SDK publicDecrypt)  [CRITICAL]
 *   7 production-shaped reveal RTT (3x fromExternal + fold + eq + reveal, one tx -> publicDecrypt) [CRITICAL]
 *
 * Usage: tsx scripts/bench_nox_latency.ts [--chain eth|arb|both] [--n 5]
 * No mocks — real testnet + real gateway/KMS. Needs DEPLOYER_PRIVATE_KEY funded.
 */
import { JsonRpcProvider, Wallet, ContractFactory, Contract } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { config as dotenv } from "dotenv";
dotenv();

const CHAINS = {
  eth: { name: "ethSepolia", chainId: 11155111, rpc: process.env.ETH_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com" },
  arb: { name: "arbSepolia", chainId: 421614, rpc: process.env.ARB_SEPOLIA_RPC_URL || "https://arbitrum-sepolia-rpc.publicnode.com" },
} as const;

const args = process.argv.slice(2);
const chainArg = (args[args.indexOf("--chain") + 1] as keyof typeof CHAINS | "both") ?? "both";
const N = Number(args[args.indexOf("--n") + 1] ?? 5) || 5;

const artifact = JSON.parse(
  readFileSync("artifacts/contracts/test/BenchHarness.sol/BenchHarness.json", "utf8")
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

function stats(xs: number[]) {
  const ok = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!ok.length) return { median: NaN, p90: NaN, n: 0 };
  const q = (p: number) => ok[Math.min(ok.length - 1, Math.floor(p * (ok.length - 1)))];
  return { median: q(0.5), p90: q(0.9), n: ok.length };
}

/** Poll an async decrypt op until it resolves or times out. Returns ms or Infinity. */
async function pollRTT(fn: () => Promise<unknown>, t0: number, timeoutMs = 180_000): Promise<number> {
  const deadline = t0 + timeoutMs;
  let delay = 1500;
  for (;;) {
    try {
      await fn();
      return now() - t0;
    } catch (e: any) {
      if (now() > deadline) return Infinity;
      await sleep(delay);
      delay = Math.min(delay * 1.4, 8000);
    }
  }
}

async function benchChain(key: keyof typeof CHAINS) {
  const c = CHAINS[key];
  console.log(`\n=== ${c.name} (chainId ${c.chainId}) — N=${N} ===`);
  const provider = new JsonRpcProvider(c.rpc, c.chainId, { staticNetwork: true });
  const wallet = new Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  const handle = await createEthersHandleClient(wallet);

  // deploy or reuse cached harness
  mkdirSync("docs/day0", { recursive: true });
  const cacheFile = `docs/day0/harness-${c.chainId}.json`;
  let addr: string;
  if (existsSync(cacheFile)) {
    addr = JSON.parse(readFileSync(cacheFile, "utf8")).address;
    console.log(`reusing harness ${addr}`);
  } else {
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const dep = await factory.deploy();
    await dep.waitForDeployment();
    addr = await dep.getAddress();
    writeFileSync(cacheFile, JSON.stringify({ address: addr, chainId: c.chainId }, null, 2));
    console.log(`deployed harness ${addr}`);
  }
  const harness = new Contract(addr, artifact.abi, wallet);

  const m: Record<string, number[]> = { encrypt: [], ingestTx: [], opTx: [], clientDecrypt: [], revealRTT: [], prodRTT: [] };
  let proofBytes = 0;

  for (let i = 0; i < N; i++) {
    const amount = BigInt(1_000_000 + i); // ~1 USDC-ish, distinct per run
    try {
      // metric 1 — encryptInput
      let t = now();
      const enc = await handle.encryptInput(amount, "uint256", addr as `0x${string}`);
      m.encrypt.push(now() - t);
      proofBytes = (enc.handleProof.length - 2) / 2;

      // metric 2 — fromExternal ingest tx
      t = now();
      const txI = await harness.ingest(enc.handle, enc.handleProof);
      await txI.wait();
      m.ingestTx.push(now() - t);

      // metric 4 — client decrypt of the ingested handle (allow granted in ingest)
      const lastHandle: string = await harness.last();
      t = now();
      m.clientDecrypt.push(await pollRTT(() => handle.decrypt(lastHandle as `0x${string}`), t, 120_000));

      // metric 3 — encrypted op tx (addToSum)
      const enc2 = await handle.encryptInput(amount, "uint256", addr as `0x${string}`);
      t = now();
      const txA = await harness.addToSum(enc2.handle, enc2.handleProof);
      await txA.wait();
      m.opTx.push(now() - t);

      // metric 5 — idle-handle reveal RTT (revealLast then publicDecrypt)
      const txR = await harness.revealLast();
      await txR.wait();
      t = now();
      m.revealRTT.push(await pollRTT(() => handle.publicDecrypt(lastHandle as `0x${string}`), t));

      // metric 7 — production-shaped chained op then publicDecrypt(chainRes)
      const a = await handle.encryptInput(2n, "uint256", addr as `0x${string}`);
      const b = await handle.encryptInput(3n, "uint256", addr as `0x${string}`);
      const d = await handle.encryptInput(5n, "uint256", addr as `0x${string}`);
      const txC = await harness.chained(a.handle, a.handleProof, b.handle, b.handleProof, d.handle, d.handleProof, 10n);
      await txC.wait();
      const chainHandle: string = await harness.chainRes();
      t = now();
      m.prodRTT.push(await pollRTT(() => handle.publicDecrypt(chainHandle as `0x${string}`), t));

      console.log(
        `run ${i + 1}/${N}: enc=${m.encrypt.at(-1)}ms ingest=${m.ingestTx.at(-1)}ms decrypt=${fmt(m.clientDecrypt.at(-1)!)} revealRTT=${fmt(m.revealRTT.at(-1)!)} prodRTT=${fmt(m.prodRTT.at(-1)!)}`
      );
    } catch (e: any) {
      console.log(`run ${i + 1}/${N}: ERROR ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
    }
  }

  const report: any = { chain: c.name, chainId: c.chainId, N, proofBytes, harness: addr, metrics: {} };
  for (const [k, v] of Object.entries(m)) report.metrics[k] = { ...stats(v), raw: v };
  console.log(`\n-- ${c.name} summary (proof=${proofBytes} B) --`);
  for (const [k, v] of Object.entries(m)) {
    const s = stats(v);
    console.log(`${k.padEnd(14)} median=${fmt(s.median)} p90=${fmt(s.p90)} ok=${s.n}/${v.length}`);
  }
  return report;
}

function fmt(ms: number) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : "TIMEOUT";
}

async function main() {
  const keys: (keyof typeof CHAINS)[] = chainArg === "both" ? ["eth", "arb"] : [chainArg as keyof typeof CHAINS];
  const reports = [];
  for (const k of keys) {
    try {
      reports.push(await benchChain(k));
    } catch (e: any) {
      console.log(`CHAIN ${k} FAILED: ${String(e?.message ?? e).slice(0, 200)}`);
    }
  }
  const file = `docs/day0/bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), reports }, null, 2));
  console.log(`\nsaved: ${file}`);

  // GO/NO-GO verdict on the critical metric (prodRTT), per docs/PLAN.md tiers
  console.log(`\n=== GO/NO-GO (production-shaped reveal RTT) ===`);
  for (const r of reports) {
    const p = r.metrics.prodRTT;
    const med = p.median / 1000, p90 = p.p90 / 1000, succ = p.n / r.N;
    let tier = "NO-GO";
    if (Number.isFinite(med) && Number.isFinite(p90) && succ >= 0.8) {
      if (med <= 15 && p90 <= 30) tier = "GO-LIVE";
      else if (med <= 90 && p90 <= 150) tier = "GO-WITH-CUTS";
    }
    console.log(`${r.chain}: median=${fmt(p.median)} p90=${fmt(p.p90)} success=${(succ * 100).toFixed(0)}%  => ${tier}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
