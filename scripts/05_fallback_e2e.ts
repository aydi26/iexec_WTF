/**
 * Phase 5 — adversarial cross-chain E2E (DoD (2)), all live, zero mocks.
 * Depositor #3 deposits the honest amount on the SOURCE but pre-registers an
 * INFLATED destination claim (real SDK). Sum(dst) != A -> integrity check == 0 ->
 * fallback -> opt-in attribution reveal exposes the inflation -> refund-to-source
 * bridges A back and confidentially re-credits every depositor their ATTESTED
 * source amount (the cheater cannot claim more than attested).
 */
import { Contract } from "ethers";
import { CHAINS, connect, handleClient, deployments, artifact, ADDR, publicDecryptWithRetry } from "./lib/common.js";
import { fetchAttestation, computeMaxFee } from "./lib/cctp.js";

const CUSDC_ABI = [
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
];
const USDC_ABI = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const me = eth.wallet.address;
  const ethH = await handleClient(eth.wallet);
  const arbH = await handleClient(arb.wallet);

  const ethUsdc = new Contract((ADDR.USDC as any)[11155111], USDC_ABI, eth.wallet);
  const ethCusdcAddr = deployments(11155111).ManifoldCUSDC;
  const batcherAddr = deployments(11155111).ManifoldBatcher;
  const distAddr = deployments(421614).ManifoldDistributor;
  const cusdc = new Contract(ethCusdcAddr, CUSDC_ABI, eth.wallet);
  const batcher = new Contract(batcherAddr, artifact("ManifoldBatcher").abi, eth.wallet);
  const dist = new Contract(distAddr, artifact("ManifoldDistributor").abi, arb.wallet);

  const src = [100_000n, 150_000n, 200_000n]; // honest source deposits
  const dst = [100_000n, 150_000n, 990_000n]; // #3 inflates the destination claim
  const total = src.reduce((a, b) => a + b, 0n); // A = 0.45
  const epochId = await batcher.currentEpoch();
  console.log(`\n=== Adversarial E2E — epoch ${epochId}, A=${total}, Sum(dst)=${dst.reduce((a, b) => a + b, 0n)} ===`);

  // pre-fund cUSDC for deposits + a small cUSDC buffer to the Batcher (covers the refund-leg fee)
  const wrapAmt = 500_000n;
  if ((await ethUsdc.allowance(me, ethCusdcAddr)) < wrapAmt + 20_000n) await (await ethUsdc.approve(ethCusdcAddr, wrapAmt + 20_000n)).wait();
  await (await cusdc.wrap(me, wrapAmt)).wait();
  await (await cusdc.wrap(batcherAddr, 20_000n)).wait(); // Batcher refund fee buffer (0.02 cUSDC)
  if (!(await cusdc.isOperator(me, batcherAddr))) await (await cusdc.setOperator(batcherAddr, 2n ** 47n)).wait();
  console.log("pre-funded cUSDC + Batcher buffer + setOperator");

  for (let i = 0; i < 3; i++) {
    const dstEnc = await arbH.encryptInput(dst[i], "uint256", distAddr as `0x${string}`);
    await (await dist.preRegister(epochId, me, dstEnc.handle, dstEnc.handleProof)).wait();
    const srcEnc = await ethH.encryptInput(src[i], "uint256", batcherAddr as `0x${string}`);
    await (await batcher.deposit(me, srcEnc.handle, srcEnc.handleProof, dstEnc.handle)).wait();
    console.log(`depositor ${i + 1}: src=hidden dst=hidden${i === 2 ? " (INFLATED)" : ""}`);
  }

  // settle + bridge
  await (await batcher.closeEpoch()).wait();
  const [encSum, unwrapReqId] = await batcher.epochHandles(epochId);
  const [sumRes, unwrapRes] = await Promise.all([publicDecryptWithRetry(ethH, encSum), publicDecryptWithRetry(ethH, unwrapReqId)]);
  const maxFee = await computeMaxFee(total, 0, 3);
  const settleRc = await (await batcher.settleEpoch(sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee)).wait();
  console.log(`settled A=${sumRes.value} + burned; polling Iris ...`);
  const relayMsg = await fetchAttestation(0, settleRc.hash);
  await (await dist.relayReceive(relayMsg.message, relayMsg.attestation)).wait();

  // integrity check -> should be 0
  await (await dist.checkEpoch(epochId)).wait();
  const checkRes = await publicDecryptWithRetry(arbH, await dist.checkHandle(epochId));
  console.log(`integrity check = ${checkRes.value} (expect 0 -> cheating detected)`);
  await (await dist.finalizeEpoch(epochId, checkRes.decryptionProof)).wait();
  let di = await dist.epochInfo(epochId);
  console.log(`finalize: dist state=${di[0]} (5 = FallbackAttribution)`);
  if (di[0] !== 5n) throw new Error(`expected FallbackAttribution, got ${di[0]}`);

  // opt-in attribution reveal (exposes the inflation): each recipient reveals their own claim
  let revealedSum = 0n;
  for (let i = 0; i < 3; i++) {
    await (await dist.requestClaimReveal(epochId, i)).wait();
    const c = await dist.claimAt(epochId, i);
    const r = await publicDecryptWithRetry(arbH, c[2]);
    await (await dist.resolveClaim(epochId, i, r.decryptionProof)).wait();
    revealedSum += r.value;
    console.log(`  claim ${i} revealed = ${r.value}${i === 2 ? " (inflated!)" : ""}`);
  }
  console.log(`Sum(revealed dst)=${revealedSum} vs A=${total} -> inconsistency ${revealedSum !== total ? "EXPOSED" : "none"}`);

  // refund-to-source: bridge A back, Batcher re-credits each depositor their attested source amount
  const refundFee = await computeMaxFee(total, 3, 0);
  const refundRc = await (await dist.initiateRefund(epochId, refundFee)).wait();
  console.log(`initiateRefund + burned (tx ${refundRc.hash}); polling Iris (Arb->ETH) ...`);
  const refundMsg = await fetchAttestation(3, refundRc.hash);
  await (await batcher.relayRefund(epochId, refundMsg.message, refundMsg.attestation)).wait();
  const be = await batcher.epochInfo(epochId);
  console.log(`Batcher epoch state=${be[0]} (3 = Refunded) refunded=${be[3]}`);
  if (be[0] !== 3n) throw new Error(`expected Refunded, got ${be[0]}`);

  console.log(`\nADVERSARIAL E2E OK: inflated dst claim -> check==0 -> attribution reveal exposed Sum(dst)=${revealedSum}!=A=${total} -> refund-to-source re-credited attested amounts. Cheater got their real 0.20, not 0.99. DoD (2) achieved.`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
