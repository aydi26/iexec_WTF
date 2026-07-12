/**
 * Phase 3 — deploy the destination leg + a fresh Batcher (with refund receiver),
 * then wire the peers. Idempotent-ish: redeploys and overwrites the registry.
 *   ETH Sepolia: NoxusBatcher (reuses existing NoxusCUSDC)
 *   Arb Sepolia: NoxusCUSDC + NoxusDistributor
 */
import { Contract, zeroPadValue, getAddress } from "ethers";
import { CHAINS, connect, deploy, deployments, saveDeployment, artifact, ADDR } from "./lib/common.js";

const b32 = (a: string) => zeroPadValue(getAddress(a), 32);

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const ethUsdc = (ADDR.USDC as any)[11155111];
  const arbUsdc = (ADDR.USDC as any)[421614];

  // --- Arb wrapper ---
  let arbCusdc = deployments(421614).NoxusCUSDC;
  if (!arbCusdc) {
    const d = await deploy("NoxusCUSDC", arb.wallet, [arbUsdc]);
    arbCusdc = d.address;
    saveDeployment(421614, "NoxusCUSDC", arbCusdc);
    console.log(`Arb NoxusCUSDC ${arbCusdc}`);
  } else console.log(`Arb NoxusCUSDC (reuse) ${arbCusdc}`);

  // --- Arb Distributor ---
  let distAddr = deployments(421614).NoxusDistributor;
  if (!distAddr) {
    const d = await deploy("NoxusDistributor", arb.wallet, [
      arbUsdc, arbCusdc, ADDR.MESSAGE_TRANSMITTER_V2, ADDR.TOKEN_MESSENGER_V2, 0 /*srcDomain=ETH*/, 3600 /*fallbackTimeout*/,
    ]);
    distAddr = d.address;
    saveDeployment(421614, "NoxusDistributor", distAddr);
    console.log(`Arb NoxusDistributor ${distAddr}`);
  } else console.log(`Arb NoxusDistributor (reuse) ${distAddr}`);

  // --- ETH Batcher (fresh, with messageTransmitter for refunds) ---
  const ethCusdc = deployments(11155111).NoxusCUSDC;
  if (!ethCusdc) throw new Error("ETH NoxusCUSDC missing; run scripts/00 first");
  const batcher = await deploy("NoxusBatcher", eth.wallet, [
    ethUsdc, ethCusdc, ADDR.TOKEN_MESSENGER_V2, ADDR.MESSAGE_TRANSMITTER_V2, 3 /*dstDomain=Arb*/, 3 /*minDepositors*/, 8 /*maxClaims*/,
  ]);
  saveDeployment(11155111, "NoxusBatcher", batcher.address);
  console.log(`ETH NoxusBatcher ${batcher.address}`);

  // --- wire peers (resilient to AlreadyWired) ---
  const batcherC = new Contract(batcher.address, artifact("NoxusBatcher").abi, eth.wallet);
  const distC = new Contract(distAddr, artifact("NoxusDistributor").abi, arb.wallet);
  try { await (await batcherC.wirePeer(b32(distAddr))).wait(); } catch (e: any) { console.log(`batcher wirePeer skipped: ${e?.shortMessage ?? e?.message}`); }
  try { await (await distC.wirePeer(b32(batcher.address))).wait(); } catch (e: any) { console.log(`distributor wirePeer skipped: ${e?.shortMessage ?? e?.message}`); }
  console.log(`wired: Batcher<->Distributor`);
  console.log(`\nDeploy + wire complete.`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
