/**
 * Third-party destination E2E (proves the relaxed preRegister guard).
 * The SENDER (deployer) bridges ETH->Arb to a FRESH recipient address it does not
 * control the funds of: it creates the recipient's encrypted destination claim,
 * pre-registers it FOR the recipient, deposits, and the batch distributes. The
 * recipient (a throwaway wallet, never funded, signs nothing) then decrypts its
 * own credited balance with its OWN key — proving the confidential credit landed.
 * Anti-squatting still holds: the claim only resolves because the sender committed
 * the matching (recipient, dstHandle) in the source deposit.
 */
import { Contract, Wallet } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
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

  // Fresh third-party recipient — we hold its key ONLY to decrypt and verify; it
  // never signs a transaction and is never funded.
  const recipientKey = Wallet.createRandom();
  const recipient = recipientKey.address;

  const ethUsdc = new Contract((ADDR.USDC as any)[11155111], USDC_ABI, eth.wallet);
  const ethCusdcAddr = deployments(11155111).NoxusCUSDC;
  const batcherAddr = deployments(11155111).NoxusBatcher;
  const distAddr = deployments(421614).NoxusDistributor;
  const arbCusdcAddr = deployments(421614).NoxusCUSDC;
  const cusdc = new Contract(ethCusdcAddr, CUSDC_ABI, eth.wallet);
  const batcher = new Contract(batcherAddr, artifact("NoxusBatcher").abi, eth.wallet);
  const dist = new Contract(distAddr, artifact("NoxusDistributor").abi, arb.wallet);

  // transfer 0 -> the THIRD PARTY; transfers 1,2 -> fillers back to sender
  const recips = [recipient, me, me];
  const amounts = [50_000n, 30_000n, 20_000n]; // 0.05 to recipient + 0.05 fillers = A 0.10
  const total = amounts.reduce((a, b) => a + b, 0n);
  const epochId = await batcher.currentEpoch();
  console.log(`\n=== Third-party E2E (ETH->Arb) — epoch ${epochId}, A=${total} ===`);
  console.log(`sender=${me}\nthird-party recipient=${recipient} (fresh, unfunded)`);

  const wrapAmt = 120_000n;
  if ((await ethUsdc.allowance(me, ethCusdcAddr)) < wrapAmt) await (await ethUsdc.approve(ethCusdcAddr, wrapAmt)).wait();
  await (await cusdc.wrap(me, wrapAmt)).wait();
  if (!(await cusdc.isOperator(me, batcherAddr))) await (await cusdc.setOperator(batcherAddr, 2n ** 47n)).wait();
  console.log("sender pre-funded cUSDC + setOperator");

  for (let i = 0; i < 3; i++) {
    // sender CREATES the recipient's dst claim (owner=sender) and registers it FOR the recipient
    const dstEnc = await arbH.encryptInput(amounts[i], "uint256", distAddr as `0x${string}`);
    await (await dist.preRegister(epochId, recips[i], dstEnc.handle, dstEnc.handleProof)).wait();
    const srcEnc = await ethH.encryptInput(amounts[i], "uint256", batcherAddr as `0x${string}`);
    await (await batcher.deposit(recips[i], srcEnc.handle, srcEnc.handleProof, dstEnc.handle)).wait();
    console.log(`transfer ${i + 1}/3 -> ${recips[i] === me ? "self (filler)" : "THIRD PARTY"}: preRegistered + deposited, amount hidden`);
  }

  await (await batcher.closeEpoch()).wait();
  const [encSum, unwrapReqId] = await batcher.epochHandles(epochId);
  const [sumRes, unwrapRes] = await Promise.all([publicDecryptWithRetry(ethH, encSum), publicDecryptWithRetry(ethH, unwrapReqId)]);
  const maxFee = await computeMaxFee(total, 0, 3);
  const settleRc = await (await batcher.settleEpoch(sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee)).wait();
  console.log(`settled A=${sumRes.value} + burned; polling Iris ...`);
  const { message, attestation } = await fetchAttestation(0, settleRc.hash);
  await (await dist.relayReceive(message, attestation)).wait();

  await (await dist.checkEpoch(epochId)).wait();
  const checkRes = await publicDecryptWithRetry(arbH, await dist.checkHandle(epochId));
  console.log(`integrity check = ${checkRes.value} (1 = ok)`);
  await (await dist.finalizeEpoch(epochId, checkRes.decryptionProof)).wait();
  const di = await dist.epochInfo(epochId);
  console.log(`finalize: dist state=${di[0]} (4 = Distributed)`);
  if (di[0] !== 4n) throw new Error(`not Distributed: state ${di[0]}`);

  // THE PROOF: the third party decrypts ITS OWN credited balance with ITS OWN key.
  const arbCusdcRead = new Contract(arbCusdcAddr, CUSDC_ABI, arb.provider);
  const recipHandleClient = await createEthersHandleClient(recipientKey.connect(arb.provider) as any);
  const balHandle = await arbCusdcRead.confidentialBalanceOf(recipient);
  const dec = await recipHandleClient.decrypt(balHandle as `0x${string}`);
  console.log(`third-party recipient decrypted its own cUSD balance on Arb = ${dec.value}`);
  if (BigInt(dec.value) !== amounts[0]) throw new Error(`recipient balance ${dec.value} != expected ${amounts[0]}`);

  console.log(`\nTHIRD-PARTY E2E OK: sender bridged ${amounts[0]} to a fresh address it does not control; recipient decrypted exactly ${amounts[0]} with its own key. Direct third-party sends work.`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
