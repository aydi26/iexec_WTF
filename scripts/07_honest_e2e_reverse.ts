/**
 * Reverse-direction honest E2E (Arb -> ETH), proving the bidirectional pair live.
 * Mirror of 04_honest_e2e.ts with source = Arb Sepolia, destination = ETH Sepolia.
 *   Batcher@Arb (dstDomain 0) -> CCTP -> Distributor@ETH (srcDomain 3).
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
const USDC_ABI = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const arb = connect(CHAINS.arb); // SOURCE
  const eth = connect(CHAINS.eth); // DESTINATION
  const me = await arb.wallet.getAddress();
  const srcH = await handleClient(arb.wallet); // Arb encrypt + Batcher@Arb reveals
  const dstH = await handleClient(eth.wallet); // ETH encrypt (Distributor@ETH) + check reveal

  const srcUsdc = new Contract((ADDR.USDC as any)[421614], USDC_ABI, arb.wallet);
  const srcCusdcAddr = deployments(421614).NoxusCUSDC;
  const batcherAddr = deployments(421614).NoxusBatcher;     // reverse Batcher (Arb)
  const distAddr = deployments(11155111).NoxusDistributor;  // reverse Distributor (ETH)
  if (!batcherAddr || !distAddr) throw new Error("reverse pair not deployed (run scripts/06)");
  const cusdc = new Contract(srcCusdcAddr, CUSDC_ABI, arb.wallet);
  const batcher = new Contract(batcherAddr, artifact("NoxusBatcher").abi, arb.wallet);
  const dist = new Contract(distAddr, artifact("NoxusDistributor").abi, eth.wallet);

  const amounts = [20_000n, 30_000n, 50_000n]; // 0.10 total
  const total = amounts.reduce((a, b) => a + b, 0n);
  const epochId = await batcher.currentEpoch();
  console.log(`\n=== Reverse honest E2E (Arb -> ETH) — epoch ${epochId}, A=${total} ===`);

  const wrapAmt = 120_000n;
  if ((await srcUsdc.allowance(me, srcCusdcAddr)) < wrapAmt) await (await srcUsdc.approve(srcCusdcAddr, wrapAmt)).wait();
  await (await cusdc.wrap(me, wrapAmt)).wait();
  if (!(await cusdc.isOperator(me, batcherAddr))) await (await cusdc.setOperator(batcherAddr, 2n ** 47n)).wait();
  console.log("pre-funded cUSDC + setOperator on Arb");

  for (let i = 0; i < amounts.length; i++) {
    const dstEnc = await dstH.encryptInput(amounts[i], "uint256", distAddr as `0x${string}`);
    await (await dist.preRegister(epochId, me, dstEnc.handle, dstEnc.handleProof)).wait();
    const srcEnc = await srcH.encryptInput(amounts[i], "uint256", batcherAddr as `0x${string}`);
    await (await batcher.deposit(me, srcEnc.handle, srcEnc.handleProof, dstEnc.handle)).wait();
    console.log(`depositor ${i + 1}/3: preRegistered (ETH) + deposited (Arb), amount hidden`);
  }

  await (await batcher.closeEpoch()).wait();
  const [encSum, unwrapReqId] = await batcher.epochHandles(epochId);
  const [sumRes, unwrapRes] = await Promise.all([publicDecryptWithRetry(srcH, encSum), publicDecryptWithRetry(srcH, unwrapReqId)]);
  console.log(`revealed A=${sumRes.value} (unwrap=${unwrapRes.value})`);
  const maxFee = await computeMaxFee(total, 3, 0); // src domain 3 (Arb) -> dst domain 0 (ETH)
  const settleRc = await (await batcher.settleEpoch(sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee)).wait();
  console.log(`settled + burned on Arb (tx ${settleRc.hash}); polling Iris (Arb->ETH ~20s) ...`);

  const { message, attestation } = await fetchAttestation(3, settleRc.hash); // source domain = 3
  await (await dist.relayReceive(message, attestation)).wait();
  let di = await dist.epochInfo(epochId);
  console.log(`relayReceive ok (ETH): dist state=${di[0]} aggregate=${di[1]} feeExecuted=${di[2]} claims=${di[3]}`);

  await (await dist.checkEpoch(epochId)).wait();
  const checkRes = await publicDecryptWithRetry(dstH, await dist.checkHandle(epochId));
  console.log(`integrity check = ${checkRes.value} (1 = ok)`);
  await (await dist.finalizeEpoch(epochId, checkRes.decryptionProof)).wait();
  di = await dist.epochInfo(epochId);
  console.log(`finalize (ETH): dist state=${di[0]} (4 = Distributed)`);
  if (di[0] !== 4n) throw new Error(`not Distributed: state ${di[0]}`);

  try {
    const bal = await new Contract(deployments(11155111).NoxusCUSDC, CUSDC_ABI, eth.wallet).confidentialBalanceOf(me);
    const dec = await dstH.decrypt(bal as `0x${string}`);
    console.log(`recipient decrypted cUSDC balance on ETH = ${dec.value}`);
  } catch (e: any) {
    console.log(`(balance decrypt best-effort skipped: ${String(e?.message).slice(0, 80)})`);
  }

  console.log(`\nREVERSE E2E OK: Arb -> ETH, 3 hidden deposits -> A=${total} bridged -> check==1 -> confidential distribution on ETH. Bidirectional proven.`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
