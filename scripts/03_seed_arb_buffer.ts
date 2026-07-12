/**
 * Phase 3 — seed Arb USDC and fund the Distributor fee buffer.
 * Bridges USDC ETH->Arb via direct CCTP fast transfer (also validates the
 * burn -> Iris attestation -> receiveMessage pipeline), then transfers a small
 * buffer to the Distributor so finalizeEpoch can wrap the full aggregate A
 * despite the inbound feeExecuted.
 */
import { Contract } from "ethers";
import { CHAINS, connect, deployments, ADDR } from "./lib/common.js";
import { fastBurn, fetchAttestation, receiveMessage, computeMaxFee, bytes32Addr } from "./lib/cctp.js";

const ERC20 = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const me = eth.wallet.address;
  const ethUsdc = (ADDR.USDC as any)[11155111];
  const arbUsdc = (ADDR.USDC as any)[421614];
  const dist = deployments(421614).NoxusDistributor;

  const bridgeAmt = 1_500_000n; // 1.5 USDC
  const bufferAmt = 500_000n; // 0.5 USDC to the Distributor

  const arbUsdcC = new Contract(arbUsdc, ERC20, arb.wallet);
  const have = await arbUsdcC.balanceOf(me);
  console.log(`Arb USDC balance: ${have}`);

  if (have < bufferAmt) {
    console.log(`bridging ${bridgeAmt} (1.5 USDC) ETH->Arb ...`);
    const maxFee = await computeMaxFee(bridgeAmt, 0, 3);
    const burnTx = await fastBurn(eth.wallet, ethUsdc, {
      amount: bridgeAmt, dstDomain: 3, mintRecipient: bytes32Addr(me), destinationCaller: bytes32Addr("0x0000000000000000000000000000000000000000"), hookData: "0x", maxFee,
    });
    console.log(`  burn tx ${burnTx}; polling Iris ...`);
    const { message, attestation } = await fetchAttestation(0, burnTx);
    console.log(`  attested; receiveMessage on Arb ...`);
    const rx = await receiveMessage(arb.wallet, message, attestation);
    console.log(`  minted on Arb (tx ${rx}); Arb USDC now ${await arbUsdcC.balanceOf(me)}`);
  }

  // fund the Distributor buffer
  const distBal = await arbUsdcC.balanceOf(dist);
  if (distBal < bufferAmt) {
    await (await arbUsdcC.transfer(dist, bufferAmt)).wait();
    console.log(`funded Distributor buffer: ${await arbUsdcC.balanceOf(dist)} USDC units`);
  } else console.log(`Distributor buffer already ${distBal}`);

  console.log("\nseed complete.");
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
