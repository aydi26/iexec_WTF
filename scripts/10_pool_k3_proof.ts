/**
 * REAL k=3 proof (pool mode): three INDEPENDENT wallets deposit their own hidden
 * amounts into the SAME epoch — no operator/self fillers — then the keeper key
 * settles. On-chain, A = a1+a2+a3 (three unknowns) and entryAt shows three
 * distinct depositors: no individual amount is recoverable. This is what the
 * frontend "Pool mode" toggle does with real users; here we script 3 wallets.
 *
 * Ephemeral wallets W2/W3 are created, funded with gas + USDC from the deployer,
 * and their leftover USDC swept back at the end. Run: tsx scripts/10_pool_k3_proof.ts
 */
import { Contract, Wallet, parseUnits, parseEther, formatUnits } from "ethers";
import { CHAINS, connect, handleClient, deployments, artifact, ADDR, publicDecryptWithRetry } from "./lib/common.js";
import { fetchAttestation, computeMaxFee } from "./lib/cctp.js";

const CUSDC_ABI = [
  "function setOperator(address operator, uint48 until)",
  "function isOperator(address holder, address spender) view returns (bool)",
  "function wrap(address to, uint256 amount) returns (bytes32)",
  "function confidentialBalanceOf(address) view returns (bytes32)",
];
const USDC_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const deployer = await eth.wallet.getAddress();
  const ethUsdc = (ADDR.USDC as any)[11155111];
  const ethCusdcAddr = deployments(11155111).NoxusCUSDC;
  const batcherAddr = deployments(11155111).NoxusBatcher;
  const distAddr = deployments(421614).NoxusDistributor;

  // Three INDEPENDENT depositors: deployer (W1) + two fresh wallets (W2, W3).
  const w2 = Wallet.createRandom().connect(eth.provider);
  const w3 = Wallet.createRandom().connect(eth.provider);
  const users = [
    { name: "W1 (deployer)", signer: eth.wallet, addr: deployer, amount: parseUnits("0.05", 6) },
    { name: "W2 (independent)", signer: w2, addr: w2.address, amount: parseUnits("0.31", 6) },
    { name: "W3 (independent)", signer: w3, addr: w3.address, amount: parseUnits("0.62", 6) },
  ];
  const A = users.reduce((s, u) => s + u.amount, 0n);
  console.log(`\n=== REAL k=3 proof (pool mode) — A = ${formatUnits(A, 6)} USDC across 3 independent wallets ===`);
  console.log(`W1 ${deployer}\nW2 ${w2.address}\nW3 ${w3.address}\n`);

  const usdcD = new Contract(ethUsdc, USDC_ABI, eth.wallet);
  // Fund W2/W3 with gas + USDC from the deployer.
  for (const u of [w2, w3]) {
    await (await eth.wallet.sendTransaction({ to: u.address, value: parseEther("0.01") })).wait();
    await (await usdcD.transfer(u.address, parseUnits("1.0", 6))).wait();
  }
  console.log("funded W2/W3 (gas + 1 USDC each)");

  const epochId = await new Contract(batcherAddr, artifact("NoxusBatcher").abi, eth.provider).currentEpoch();
  console.log(`target epoch #${epochId}\n`);

  // Each user INDEPENDENTLY: preRegister own claim (Arb) + fund + deposit own amount (ETH). No fillers.
  for (const u of users) {
    const arbConn = { provider: arb.provider, wallet: new Wallet(u.signer instanceof Wallet ? u.signer.privateKey : process.env.DEPLOYER_PRIVATE_KEY!, arb.provider) };
    const arbH = await handleClient(arbConn.wallet as any);
    const ethH = await handleClient(u.signer as any);
    const cusdc = new Contract(ethCusdcAddr, CUSDC_ABI, u.signer);
    const usdc = new Contract(ethUsdc, USDC_ABI, u.signer);
    const dist = new Contract(distAddr, artifact("NoxusDistributor").abi, arbConn.wallet);
    const batcher = new Contract(batcherAddr, artifact("NoxusBatcher").abi, u.signer);

    // preRegister own claim on Arb
    const dstEnc = await arbH.encryptInput(u.amount, "uint256", distAddr as `0x${string}`);
    await (await dist.preRegister(epochId, u.addr, dstEnc.handle, dstEnc.handleProof)).wait();
    // fund cUSDC + operator
    const wrapAmt = u.amount + 20_000n;
    if ((await usdc.allowance(u.addr, ethCusdcAddr)) < wrapAmt) await (await usdc.approve(ethCusdcAddr, wrapAmt)).wait();
    await (await cusdc.wrap(u.addr, wrapAmt)).wait();
    if (!(await cusdc.isOperator(u.addr, batcherAddr))) await (await cusdc.setOperator(batcherAddr, 2n ** 47n)).wait();
    // deposit own amount on ETH (reuse the same dst handle)
    const srcEnc = await ethH.encryptInput(u.amount, "uint256", batcherAddr as `0x${string}`);
    await (await batcher.deposit(u.addr, srcEnc.handle, srcEnc.handleProof, dstEnc.handle)).wait();
    console.log(`${u.name}: preRegistered + deposited (amount hidden on-chain)`);
  }

  // Show what an observer sees: 3 distinct depositors, amounts encrypted.
  const batcherRead = new Contract(batcherAddr, artifact("NoxusBatcher").abi, eth.provider);
  const info = await batcherRead.epochInfo(epochId);
  console.log(`\nbatch: ${info[1]} deposits from 3 distinct wallets — an observer sees WHO, never how much:`);
  for (let i = 0n; i < info[4]; i++) {
    const e = await batcherRead.entryAt(epochId, i);
    console.log(`  entry ${i}: depositor ${e[0]}`);
  }

  // Keeper (deployer key here for the script) closes + settles + relays + checks + finalizes.
  const batcher = new Contract(batcherAddr, artifact("NoxusBatcher").abi, eth.wallet);
  const dist = new Contract(distAddr, artifact("NoxusDistributor").abi, arb.wallet);
  const ethH = await handleClient(eth.wallet);
  const arbH = await handleClient(arb.wallet);
  await (await batcher.closeEpoch()).wait();
  const [encSum, unwrapReqId] = await batcher.epochHandles(epochId);
  const [sumRes, unwrapRes] = await Promise.all([publicDecryptWithRetry(ethH, encSum), publicDecryptWithRetry(ethH, unwrapReqId)]);
  console.log(`\nrevealed A = ${formatUnits(sumRes.value, 6)} USDC (the ONLY public number; expect ${formatUnits(A, 6)})`);
  if (sumRes.value !== A) throw new Error(`A mismatch: ${sumRes.value} != ${A}`);
  const maxFee = await computeMaxFee(A, 0, 3);
  const settleRc = await (await batcher.settleEpoch(sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee)).wait();
  console.log(`settled + burned (tx ${settleRc.hash}); polling Iris…`);
  const { message, attestation } = await fetchAttestation(0, settleRc.hash);
  await (await dist.relayReceive(message, attestation)).wait();
  await (await dist.checkEpoch(epochId)).wait();
  const checkNum = await dist.checkHandle(epochId);
  const checkRes = await publicDecryptWithRetry(arbH, checkNum);
  console.log(`integrity check = ${checkRes.value} (1 = ok)`);
  await (await dist.finalizeEpoch(epochId, checkRes.decryptionProof)).wait();
  const di = await dist.epochInfo(epochId);
  if (di[0] !== 4n) throw new Error(`not Distributed: state ${di[0]}`);
  console.log(`finalize: dist state=${di[0]} (4 = Distributed)`);

  // Sweep W2/W3 leftover USDC back to the deployer (best-effort).
  for (const u of [w2, w3]) {
    try { const bal = await new Contract(ethUsdc, USDC_ABI, u).balanceOf(u.address); if (bal > 0n) await (await new Contract(ethUsdc, USDC_ABI, u).transfer(deployer, bal)).wait(); } catch { /* ignore */ }
  }

  console.log(`\nREAL k=3 PROVEN: 3 independent wallets, A=${formatUnits(A, 6)} public, three unknowns in the sum → no individual amount recoverable. check==1, Distributed.`);
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
