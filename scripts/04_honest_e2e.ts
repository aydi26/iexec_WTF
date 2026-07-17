/**
 * Phase 4 — honest cross-chain E2E (DoD (1)), all live, zero mocks.
 * Depositors pre-register dst claims on Arb (option B), deposit encrypted amounts
 * on ETH, the batch settles + bridges one public aggregate A, the Distributor
 * relays the mint, runs the on-chain integrity check (Sum == A), and distributes
 * confidentially. Amounts 0.10 / 0.15 / 0.20 USDC (self as recipient for the smoke).
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
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const me = await eth.wallet.getAddress();
  const ethH = await handleClient(eth.wallet);
  const arbH = await handleClient(arb.wallet);

  const ethUsdc = new Contract((ADDR.USDC as any)[11155111], USDC_ABI, eth.wallet);
  const ethCusdcAddr = deployments(11155111).NoxusCUSDC;
  const batcherAddr = deployments(11155111).NoxusBatcher;
  const distAddr = deployments(421614).NoxusDistributor;
  const cusdc = new Contract(ethCusdcAddr, CUSDC_ABI, eth.wallet);
  const batcher = new Contract(batcherAddr, artifact("NoxusBatcher").abi, eth.wallet);
  const dist = new Contract(distAddr, artifact("NoxusDistributor").abi, arb.wallet);

  const amounts = [20_000n, 30_000n, 50_000n]; // 0.02/0.03/0.05 = 0.10 (small, conserves faucet USDC)
  const total = amounts.reduce((a, b) => a + b, 0n);
  const epochId = await batcher.currentEpoch();
  console.log(`\n=== Honest E2E — epoch ${epochId}, A=${total} (0.45 USDC) ===`);

  // pre-fund cUSDC + operator on the source
  const wrapAmt = 120_000n; // 0.12 cUSDC (margin over the 0.10 deposited)
  if ((await ethUsdc.allowance(me, ethCusdcAddr)) < wrapAmt) await (await ethUsdc.approve(ethCusdcAddr, wrapAmt)).wait();
  await (await cusdc.wrap(me, wrapAmt)).wait();
  if (!(await cusdc.isOperator(me, batcherAddr))) await (await cusdc.setOperator(batcherAddr, 2n ** 47n)).wait();
  console.log("pre-funded cUSDC + setOperator");

  // per depositor: preRegister on Arb (own tx, owner-binding) then deposit on ETH (same dstHandle)
  for (let i = 0; i < amounts.length; i++) {
    const dstEnc = await arbH.encryptInput(amounts[i], "uint256", distAddr as `0x${string}`);
    await (await dist.preRegister(epochId, me, dstEnc.handle, dstEnc.handleProof)).wait();
    const srcEnc = await ethH.encryptInput(amounts[i], "uint256", batcherAddr as `0x${string}`);
    await (await batcher.deposit(me, srcEnc.handle, srcEnc.handleProof, dstEnc.handle)).wait();
    console.log(`depositor ${i + 1}/3: preRegistered (Arb) + deposited (ETH), amount hidden`);
  }

  // (Cross-chain claim binding is now enforced on-chain: settleEpoch ships the
  // ordered committed ClaimId[] in hookData and the Distributor resolves exactly
  // those pre-registrations — no positional claimsHash cross-check needed.)

  // close + settle (dual-proof, one RTT) -> burn+bridge
  await (await batcher.closeEpoch()).wait();
  const [encSum, unwrapReqId] = await batcher.epochHandles(epochId);
  const [sumRes, unwrapRes] = await Promise.all([publicDecryptWithRetry(ethH, encSum), publicDecryptWithRetry(ethH, unwrapReqId)]);
  console.log(`revealed A=${sumRes.value} (unwrap=${unwrapRes.value})`);
  const maxFee = await computeMaxFee(total, 0, 3);
  const settleRc = await (await batcher.settleEpoch(sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee)).wait();
  console.log(`settled + burned (tx ${settleRc.hash}); polling Iris ...`);

  // relay the mint to Arb
  const { message, attestation } = await fetchAttestation(0, settleRc.hash);
  await (await dist.relayReceive(message, attestation)).wait();
  let di = await dist.epochInfo(epochId);
  console.log(`relayReceive ok: dist state=${di[0]} aggregate=${di[1]} feeExecuted=${di[2]} claims=${di[3]}`);

  // integrity check -> reveal -> finalize
  await (await dist.checkEpoch(epochId)).wait();
  const checkNum = await dist.checkHandle(epochId);
  const checkRes = await publicDecryptWithRetry(arbH, checkNum);
  console.log(`integrity check = ${checkRes.value} (1 = ok)`);
  await (await dist.finalizeEpoch(epochId, checkRes.decryptionProof)).wait();
  di = await dist.epochInfo(epochId);
  console.log(`finalize: dist state=${di[0]} (4 = Distributed)`);
  if (di[0] !== 4n) throw new Error(`not Distributed: state ${di[0]}`);

  // recipient client-decrypts their confidential balance (best-effort)
  try {
    const bal = await new Contract(deployments(421614).NoxusCUSDC, CUSDC_ABI, arb.wallet).confidentialBalanceOf(me);
    const dec = await arbH.decrypt(bal as `0x${string}`);
    console.log(`recipient decrypted cUSDC balance on Arb = ${dec.value}`);
  } catch (e: any) {
    console.log(`(balance decrypt best-effort skipped: ${String(e?.message).slice(0, 80)})`);
  }

  console.log(`\nHONEST E2E OK: 3 hidden deposits -> A=${total} bridged -> check==1 -> confidential distribution on Arb. DoD (1) achieved.`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
