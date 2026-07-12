/**
 * Phase 2 exit — live micro-epoch on ETH Sepolia (docs/PLAN.md Phase 2).
 * Deploys ManifoldBatcher, wraps a little USDC, runs 3 hidden-amount deposits
 * from one account, closes, and settles with the CCTP burn DISABLED (bridge not
 * yet wired). Asserts the revealed aggregate A equals the known sum.
 * Tiny amounts (0.10 + 0.15 + 0.20 = 0.45 USDC) to conserve faucet USDC.
 *
 * Usage: tsx scripts/01_batcher_micro_epoch.ts
 */
import { Contract, hexlify, randomBytes } from "ethers";
import {
  CHAINS, connect, handleClient, deploy, deployments, saveDeployment, artifact,
  ADDR, USDC_ABI, publicDecryptWithRetry,
} from "./lib/common.js";

const CUSDC_ABI = [
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
];

async function main() {
  const c = CHAINS.eth;
  const { wallet } = connect(c);
  const me = wallet.address;
  const handle = await handleClient(wallet);
  const usdcAddr = (ADDR.USDC as any)[c.chainId];
  const cusdcAddr = deployments(c.chainId).ManifoldCUSDC;
  if (!cusdcAddr) throw new Error("deploy ManifoldCUSDC first (scripts/00_wrapper_deploy_verify.ts)");
  console.log(`\n=== ManifoldBatcher micro-epoch on ${c.name} (me=${me}) ===`);

  // deploy batcher (reuse if present)
  let batcherAddr = deployments(c.chainId).ManifoldBatcher;
  if (!batcherAddr) {
    const d = await deploy("ManifoldBatcher", wallet, [usdcAddr, cusdcAddr, ADDR.TOKEN_MESSENGER_V2, 3, 3, 8]);
    batcherAddr = d.address;
    saveDeployment(c.chainId, "ManifoldBatcher", batcherAddr);
    console.log(`deployed ManifoldBatcher ${batcherAddr}`);
  } else console.log(`reusing ManifoldBatcher ${batcherAddr}`);

  const batcher = new Contract(batcherAddr, artifact("ManifoldBatcher").abi, wallet);
  const usdc = new Contract(usdcAddr, USDC_ABI, wallet);
  const cusdc = new Contract(cusdcAddr, CUSDC_ABI, wallet);

  const amounts = [100_000n, 150_000n, 200_000n]; // 0.10 / 0.15 / 0.20 USDC
  const total = amounts.reduce((a, b) => a + b, 0n); // 0.45 USDC
  const wrapAmt = 500_000n; // wrap 0.5 USDC (margin over the 0.45 deposited)

  // pre-fund cUSDC + authorize the batcher as operator
  if ((await usdc.allowance(me, cusdcAddr)) < wrapAmt) await (await usdc.approve(cusdcAddr, wrapAmt)).wait();
  await (await cusdc.wrap(me, wrapAmt)).wait();
  console.log(`wrapped ${wrapAmt} (0.5 USDC) -> cUSDC`);
  if (!(await cusdc.isOperator(me, batcherAddr))) {
    await (await cusdc.setOperator(batcherAddr, 2n ** 47n)).wait();
    console.log("setOperator(batcher) ok");
  }

  // 3 hidden-amount deposits (dstHandle is a placeholder here — real one comes
  // from the depositor's Distributor pre-registration in Phase 3)
  for (let i = 0; i < amounts.length; i++) {
    const enc = await handle.encryptInput(amounts[i], "uint256", batcherAddr as `0x${string}`);
    const dstHandle = hexlify(randomBytes(32));
    const recipient = me; // self, for the smoke test
    await (await batcher.deposit(recipient, enc.handle, enc.handleProof, dstHandle)).wait();
    console.log(`deposit ${i + 1}/3 sent (amount hidden on-chain)`);
  }

  let info = await batcher.epochInfo(0);
  console.log(`after deposits: state=${info[0]} activeCount=${info[1]} entries=${info[4]}`);
  if (info[1] !== 3n) throw new Error(`activeCount ${info[1]} != 3`);

  // close: reveal sum (SITE 1) + start unwrap
  await (await batcher.closeEpoch()).wait();
  console.log("closeEpoch ok (encSum reveal + unwrap started)");

  // keeper: fetch both proofs concurrently (one wall-clock RTT)
  const [encSum, unwrapReqId] = await batcher.epochHandles(0);
  const t0 = Date.now();
  const [sumRes, unwrapRes] = await Promise.all([
    publicDecryptWithRetry(handle, encSum),
    publicDecryptWithRetry(handle, unwrapReqId),
  ]);
  console.log(`revealed: encSum=${sumRes.value} unwrapRequestId=${unwrapRes.value} (RTT ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  if (sumRes.value !== total) throw new Error(`encSum ${sumRes.value} != expected ${total}`);

  // settle (bridge disabled -> no CCTP burn)
  await (await batcher.settleEpoch(sumRes.decryptionProof, unwrapRes.decryptionProof, 0n)).wait();
  info = await batcher.epochInfo(0);
  console.log(`after settle: state=${info[0]} aggregate=${info[2]} (expect ${total})`);
  if (info[2] !== total) throw new Error(`aggregate ${info[2]} != ${total}`);
  if (info[0] !== 2n) throw new Error(`state ${info[0]} != Settled(2)`);

  const claimsHash = await batcher.claimsHashOf(0);
  console.log(`\nMICRO-EPOCH OK: 3 hidden deposits -> A=${info[2]} (0.45 USDC) revealed & settled; claimsHash=${claimsHash.slice(0, 18)}...`);
  console.log(`next epoch open: currentEpoch=${await batcher.currentEpoch()}`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
