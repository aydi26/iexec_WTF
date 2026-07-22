/**
 * Redeploy all 4 directional contracts with the new BATCH entry points
 * (preRegisterMany / depositMany). cUSDC wrappers are REUSED on both chains.
 * Deploys fresh Batcher+Distributor both ways, wires both pairs, funds the fee
 * buffers, and sets the keeper as operator on both Batchers (for fillers).
 */
import { Contract, zeroPadValue, getAddress, Wallet, parseUnits, formatUnits } from "ethers";
import { CHAINS, connect, deploy, deployments, saveDeployment, artifact, ADDR } from "./lib/common.js";

const b32 = (a: string) => zeroPadValue(getAddress(a), 32);
const ERC20 = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const CUSDC = ["function setOperator(address,uint48)", "function isOperator(address,address) view returns (bool)"];
const MAX48 = 281474976710655n;

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const ethUsdc = (ADDR.USDC as any)[11155111];
  const arbUsdc = (ADDR.USDC as any)[421614];
  const ethCusdc = deployments(11155111).NoxusCUSDC;
  const arbCusdc = deployments(421614).NoxusCUSDC;
  if (!ethCusdc || !arbCusdc) throw new Error("cUSDC wrappers missing");
  const keeper = new Wallet(process.env.KEEPER_PRIVATE_KEY!).address;

  console.log("=== Redeploy with batch entry points (reusing cUSDC) ===\n");

  // FORWARD pair: Batcher@ETH -> Distributor@Arb
  const distArb = await deploy("NoxusDistributor", arb.wallet, [
    arbUsdc, arbCusdc, ADDR.MESSAGE_TRANSMITTER_V2, ADDR.TOKEN_MESSENGER_V2, 0 /*srcDomain=ETH*/, 3600,
  ]);
  saveDeployment(421614, "NoxusDistributor", distArb.address);
  console.log(`Arb Distributor  ${distArb.address}`);

  const batEth = await deploy("NoxusBatcher", eth.wallet, [
    ethUsdc, ethCusdc, ADDR.TOKEN_MESSENGER_V2, ADDR.MESSAGE_TRANSMITTER_V2, 3 /*dstDomain=Arb*/, 3, 8,
  ]);
  saveDeployment(11155111, "NoxusBatcher", batEth.address);
  console.log(`ETH Batcher      ${batEth.address}`);

  // REVERSE pair: Batcher@Arb -> Distributor@ETH
  const distEth = await deploy("NoxusDistributor", eth.wallet, [
    ethUsdc, ethCusdc, ADDR.MESSAGE_TRANSMITTER_V2, ADDR.TOKEN_MESSENGER_V2, 3 /*srcDomain=Arb*/, 3600,
  ]);
  saveDeployment(11155111, "NoxusDistributor", distEth.address);
  console.log(`ETH Distributor  ${distEth.address}`);

  const batArb = await deploy("NoxusBatcher", arb.wallet, [
    arbUsdc, arbCusdc, ADDR.TOKEN_MESSENGER_V2, ADDR.MESSAGE_TRANSMITTER_V2, 0 /*dstDomain=ETH*/, 3, 8,
  ]);
  saveDeployment(421614, "NoxusBatcher", batArb.address);
  console.log(`Arb Batcher      ${batArb.address}\n`);

  // Wire both pairs (deployer-only, one-shot)
  const batEthC = new Contract(batEth.address, artifact("NoxusBatcher").abi, eth.wallet);
  const distArbC = new Contract(distArb.address, artifact("NoxusDistributor").abi, arb.wallet);
  const batArbC = new Contract(batArb.address, artifact("NoxusBatcher").abi, arb.wallet);
  const distEthC = new Contract(distEth.address, artifact("NoxusDistributor").abi, eth.wallet);
  await (await batEthC.wirePeer(b32(distArb.address))).wait();
  await (await distArbC.wirePeer(b32(batEth.address))).wait();
  await (await batArbC.wirePeer(b32(distEth.address))).wait();
  await (await distEthC.wirePeer(b32(batArb.address))).wait();
  console.log("wired both pairs\n");

  // Fund fee buffers: Distributors ~5, Batchers ~3 (refund path)
  const me = await eth.wallet.getAddress();
  const usdcE = new Contract(ethUsdc, ERC20, eth.wallet);
  const usdcA = new Contract(arbUsdc, ERC20, arb.wallet);
  const fund = async (usdc: any, to: string, amt: bigint, name: string) => {
    const bal = await usdc.balanceOf(me);
    if (bal >= amt) { await (await usdc.transfer(to, amt)).wait(); console.log(`funded ${name}: ${formatUnits(amt, 6)} USDC`); }
    else console.log(`skip ${name}: low USDC`);
  };
  await fund(usdcA, distArb.address, parseUnits("5", 6), "Arb Distributor");
  await fund(usdcE, batEth.address, parseUnits("3", 6), "ETH Batcher");
  await fund(usdcE, distEth.address, parseUnits("5", 6), "ETH Distributor");
  await fund(usdcA, batArb.address, parseUnits("3", 6), "Arb Batcher");

  // Keeper operator on both Batchers (for fillers)
  const cusdcE = new Contract(ethCusdc, CUSDC, eth.wallet);
  const cusdcA = new Contract(arbCusdc, CUSDC, arb.wallet);
  const keeperEth = connect(CHAINS.eth); // keeper signs its own setOperator
  const keeperArb = connect(CHAINS.arb);
  // The keeper must call setOperator itself (operator is per-holder). Use keeper key.
  const kE = new Contract(ethCusdc, CUSDC, new Wallet(process.env.KEEPER_PRIVATE_KEY!, keeperEth.provider));
  const kA = new Contract(arbCusdc, CUSDC, new Wallet(process.env.KEEPER_PRIVATE_KEY!, keeperArb.provider));
  if (!(await cusdcE.isOperator(keeper, batEth.address))) { await (await kE.setOperator(batEth.address, MAX48)).wait(); console.log("keeper setOperator ETH batcher"); }
  if (!(await cusdcA.isOperator(keeper, batArb.address))) { await (await kA.setOperator(batArb.address, MAX48)).wait(); console.log("keeper setOperator Arb batcher"); }

  console.log("\n=== DONE ===");
  console.log(JSON.stringify({ eth: deployments(11155111), arb: deployments(421614) }, null, 2));
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
