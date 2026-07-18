/**
 * Keyless on-chain source verification via the Sourcify V2 API (explorers show a
 * Sourcify match; no API key needed). Uploads the Hardhat standard-JSON input.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { sleep } from "./lib/common.js";

const TARGETS = [
  { chainId: 11155111, address: "0x47d150572dFCEB75C27b6dDf5EADc4D6fa33e41C", path: "contracts/NoxusCUSDC.sol", name: "NoxusCUSDC" },
  { chainId: 11155111, address: "0x814a70961395218365DA5892F5de768a9Ed84E37", path: "contracts/NoxusBatcher.sol", name: "NoxusBatcher" },
  { chainId: 421614, address: "0xD74A1F2bF0285Dc64F7855D0233E774772Ab0209", path: "contracts/NoxusCUSDC.sol", name: "NoxusCUSDC" },
  { chainId: 421614, address: "0x410195cF6137661B066d4264515C6dc9b860ECFA", path: "contracts/NoxusDistributor.sol", name: "NoxusDistributor" },
  // reverse directional pair (Arb -> ETH)
  { chainId: 11155111, address: "0x073A213Be93EC6B5aD830e466DA95603450bbfb0", path: "contracts/NoxusDistributor.sol", name: "NoxusDistributor" },
  { chainId: 421614, address: "0x47Cd125B48970D899bD9C7434187a8C5c5214d30", path: "contracts/NoxusBatcher.sol", name: "NoxusBatcher" },
];
const SERVER = "https://sourcify.dev/server";

function findBuildInfo(path: string, name: string) {
  const dir = "artifacts/build-info/";
  // newest compile first — that is the deployed bytecode
  const files = readdirSync(dir)
    .filter((x) => x.endsWith(".json"))
    .map((f) => ({ f, t: statSync(dir + f).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const { f } of files) {
    const bi = JSON.parse(readFileSync(dir + f, "utf8"));
    if (bi.output?.contracts?.[path]?.[name] && bi.input?.sources?.[path]) return bi;
  }
  throw new Error(`no build-info with ${path}:${name}`);
}

async function verifyOne(t: (typeof TARGETS)[number]) {
  // already verified?
  try {
    const chk = await fetch(`${SERVER}/v2/contract/${t.chainId}/${t.address}`, { signal: AbortSignal.timeout(15000) });
    if (chk.ok) { const j = await chk.json(); if (j?.match && j.match !== "null") return `already ${j.match}`; }
  } catch {}

  const bi = findBuildInfo(t.path, t.name);
  const body = {
    stdJsonInput: bi.input,
    compilerVersion: bi.solcLongVersion,
    contractIdentifier: `${t.path}:${t.name}`,
  };
  const res = await fetch(`${SERVER}/v2/verify/${t.chainId}/${t.address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const txt = await res.text();
  if (res.status === 429) return "rate-limited (retry later)";
  let j: any; try { j = JSON.parse(txt); } catch { return `HTTP ${res.status}: ${txt.slice(0, 120)}`; }
  const vid = j.verificationId;
  if (!vid) return `${res.status}: ${JSON.stringify(j).slice(0, 160)}`;
  // poll job
  for (let i = 0; i < 30; i++) {
    await sleep(2500);
    const jr = await fetch(`${SERVER}/v2/verify/${vid}`, { signal: AbortSignal.timeout(15000) });
    const jj = await jr.json();
    if (jj.isJobCompleted) {
      if (jj.error) return `error: ${jj.error.customCode ?? JSON.stringify(jj.error).slice(0, 120)}`;
      return `verified: ${jj.contract?.match ?? "ok"}`;
    }
  }
  return "still pending (check later)";
}

async function main() {
  for (const t of TARGETS) {
    process.stdout.write(`${t.name} @ ${t.chainId} ${t.address.slice(0, 10)} ... `);
    try { console.log(await verifyOne(t)); } catch (e: any) { console.log(`FAIL ${String(e?.message).slice(0, 120)}`); }
  }
}
main();
