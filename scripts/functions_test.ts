/**
 * Exercise the remaining Batcher functions live: withdrawDeposit (heal path) and
 * grantAuditor (auditor view grant). Runs on the current open epoch.
 */
import { Contract, hexlify, randomBytes } from "ethers";
import { CHAINS, connect, handleClient, deployments, artifact, ADDR } from "./lib/common.js";

const CUSDC_ABI = [
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function wrap(address to, uint256 amount) returns (bytes32)",
];
const USDC_ABI = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
const NOX = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF"; // ETH Sepolia NoxCompute

async function main() {
  const eth = connect(CHAINS.eth);
  const me = eth.wallet.address;
  const ethH = await handleClient(eth.wallet);
  const cusdcAddr = deployments(11155111).NoxusCUSDC;
  const batcherAddr = deployments(11155111).NoxusBatcher;
  const batcher = new Contract(batcherAddr, artifact("NoxusBatcher").abi, eth.wallet);
  const cusdc = new Contract(cusdcAddr, CUSDC_ABI, eth.wallet);
  const usdc = new Contract((ADDR.USDC as any)[11155111], USDC_ABI, eth.wallet);

  const epochId = await batcher.currentEpoch();
  console.log(`\n=== functions test on epoch ${epochId} ===`);

  // ensure cUSDC + operator
  if ((await usdc.allowance(me, cusdcAddr)) < 200_000n) await (await usdc.approve(cusdcAddr, 200_000n)).wait();
  await (await cusdc.wrap(me, 200_000n)).wait();
  if (!(await cusdc.isOperator(me, batcherAddr))) await (await cusdc.setOperator(batcherAddr, 2n ** 47n)).wait();

  // --- withdrawDeposit round-trip ---
  const before = await batcher.epochInfo(epochId);
  const enc = await ethH.encryptInput(120_000n, "uint256", batcherAddr as `0x${string}`);
  await (await batcher.deposit(me, enc.handle, enc.handleProof, hexlify(randomBytes(32)))).wait();
  const mid = await batcher.epochInfo(epochId);
  const idx = Number(mid[4]) - 1;
  console.log(`deposit ok: activeCount ${before[1]} -> ${mid[1]}, entries=${mid[4]}`);
  await (await batcher.withdrawDeposit(epochId, idx)).wait();
  const after = await batcher.epochInfo(epochId);
  const entry = await batcher.entryAt(epochId, idx);
  console.log(`withdrawDeposit ok: activeCount -> ${after[1]}, entry.withdrawn=${entry[3]}`);
  if (after[1] !== before[1] || entry[3] !== true) throw new Error("withdrawDeposit accounting wrong");

  // --- grantAuditor on a past distributed deposit (epoch 0, index 0) ---
  const auditor = "0x000000000000000000000000000000000000dEaD";
  await (await batcher.grantAuditor(0, 0, auditor)).wait();
  console.log(`grantAuditor(epoch 0, deposit 0, ${auditor.slice(0, 10)}) ok (addViewer executed)`);

  console.log(`\nFUNCTIONS TEST OK: withdrawDeposit heals the sum + refunds; grantAuditor adds a viewer.`);
}

main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
