/**
 * Deploy the REVERSE directional pair, enabling bidirectional bridging.
 * Forward pair (already live): Batcher@ETH -> Distributor@Arb (ETH -> Arb).
 * Reverse pair (this script):  Batcher@Arb -> Distributor@ETH (Arb -> ETH).
 *   Arb Sepolia: NoxusBatcher (dstDomain = 0 -> ETH)     [reuses Arb NoxusCUSDC]
 *   ETH Sepolia: NoxusDistributor (srcDomain = 3 <- Arb) [reuses ETH NoxusCUSDC]
 * Then wires the reverse pair and seeds the ETH Distributor fee buffer.
 *
 * The contracts are direction-agnostic (CCTP domain + remote peer are constructor
 * params), so this is a pure deploy+wire — no contract changes.
 */
import { Contract, zeroPadValue, getAddress } from "ethers";
import { CHAINS, connect, deploy, deployments, saveDeployment, artifact, ADDR } from "./lib/common.js";

const b32 = (a: string) => zeroPadValue(getAddress(a), 32);
const ERC20 = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const ethUsdc = (ADDR.USDC as any)[11155111];
  const arbUsdc = (ADDR.USDC as any)[421614];
  const ethCusdc = deployments(11155111).NoxusCUSDC;
  const arbCusdc = deployments(421614).NoxusCUSDC;
  if (!ethCusdc || !arbCusdc) throw new Error("cUSDC wrappers missing on one chain");

  // --- ETH Distributor (receives Arb -> ETH; srcDomain = 3) ---
  let ethDist = deployments(11155111).NoxusDistributor;
  if (!ethDist) {
    const d = await deploy("NoxusDistributor", eth.wallet, [
      ethUsdc, ethCusdc, ADDR.MESSAGE_TRANSMITTER_V2, ADDR.TOKEN_MESSENGER_V2, 3 /*srcDomain=Arb*/, 3600,
    ]);
    ethDist = d.address;
    saveDeployment(11155111, "NoxusDistributor", ethDist);
    console.log(`ETH NoxusDistributor ${ethDist}`);
  } else console.log(`ETH NoxusDistributor (reuse) ${ethDist}`);

  // --- Arb Batcher (bridges Arb -> ETH; dstDomain = 0) ---
  let arbBatcher = deployments(421614).NoxusBatcher;
  if (!arbBatcher) {
    const d = await deploy("NoxusBatcher", arb.wallet, [
      arbUsdc, arbCusdc, ADDR.TOKEN_MESSENGER_V2, ADDR.MESSAGE_TRANSMITTER_V2, 0 /*dstDomain=ETH*/, 3 /*minDepositors*/, 8 /*maxClaims*/,
    ]);
    arbBatcher = d.address;
    saveDeployment(421614, "NoxusBatcher", arbBatcher);
    console.log(`Arb NoxusBatcher ${arbBatcher}`);
  } else console.log(`Arb NoxusBatcher (reuse) ${arbBatcher}`);

  // --- wire the reverse pair (deployer-only, one-shot) ---
  const arbBatcherC = new Contract(arbBatcher, artifact("NoxusBatcher").abi, arb.wallet);
  const ethDistC = new Contract(ethDist, artifact("NoxusDistributor").abi, eth.wallet);
  try { await (await arbBatcherC.wirePeer(b32(ethDist))).wait(); } catch (e: any) { console.log(`arb batcher wirePeer skipped: ${e?.shortMessage ?? e?.message}`); }
  try { await (await ethDistC.wirePeer(b32(arbBatcher))).wait(); } catch (e: any) { console.log(`eth distributor wirePeer skipped: ${e?.shortMessage ?? e?.message}`); }
  console.log("wired reverse pair: Batcher@Arb <-> Distributor@ETH");

  // --- seed the ETH Distributor fee buffer (covers the CCTP fee gap) ---
  const bufferAmt = 30_000n; // 0.03 USDC — enough for the fee gap on small reverse bridges
  const usdc = new Contract(ethUsdc, ERC20, eth.wallet);
  const me = await eth.wallet.getAddress();
  const bal = await usdc.balanceOf(me);
  if (bal >= bufferAmt) {
    await (await usdc.transfer(ethDist, bufferAmt)).wait();
    console.log(`seeded ETH Distributor buffer: ${bufferAmt} USDC units`);
  } else {
    console.log(`skip seed: ETH USDC ${bal} < ${bufferAmt} (fund later before a reverse bridge)`);
  }

  console.log("\nReverse pair deploy + wire complete.");
  console.log(`ETH: Batcher(fwd) ${deployments(11155111).NoxusBatcher} · Distributor(rev) ${ethDist}`);
  console.log(`Arb: Distributor(fwd) ${deployments(421614).NoxusDistributor} · Batcher(rev) ${arbBatcher}`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
