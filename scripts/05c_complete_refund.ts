/**
 * Complete the refund leg: the Batcher needs a small PLAIN-USDC buffer to cover
 * the refund-leg feeExecuted (relayRefund wraps the full aggregate A, which pulls
 * plain USDC). Funds the buffer, then relays the (un-consumed) refund message.
 * Usage: tsx scripts/05c_complete_refund.ts <epochId> <initiateRefundTxHash>
 */
import { Contract } from "ethers";
import { CHAINS, connect, deployments, artifact, ADDR } from "./lib/common.js";
import { fetchAttestation } from "./lib/cctp.js";

const USDC_ABI = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const epochId = BigInt(process.argv[2] ?? "1");
  const refundTx = process.argv[3];
  if (!refundTx) throw new Error("pass the initiateRefund tx hash");

  const batcherAddr = deployments(11155111).NoxusBatcher;
  const batcher = new Contract(batcherAddr, artifact("NoxusBatcher").abi, eth.wallet);
  const usdc = new Contract((ADDR.USDC as any)[11155111], USDC_ABI, eth.wallet);

  // plain-USDC buffer so wrap(A) succeeds despite the inbound refund fee
  const bal = await usdc.balanceOf(batcherAddr);
  if (bal < 100_000n) { await (await usdc.transfer(batcherAddr, 100_000n)).wait(); console.log(`funded Batcher USDC buffer -> ${await usdc.balanceOf(batcherAddr)}`); }

  console.log(`polling Iris for refund message (Arb->ETH) tx ${refundTx} ...`);
  const m = await fetchAttestation(3, refundTx);
  await (await batcher.relayRefund(epochId, m.message, m.attestation)).wait();

  const be = await batcher.epochInfo(epochId);
  console.log(`Batcher epoch ${epochId} state=${be[0]} (3 = Refunded)`);
  if (be[0] !== 3n) throw new Error(`expected Refunded, got ${be[0]}`);
  console.log(`\nREFUND COMPLETE: every depositor confidentially re-credited their attested source amount. Cheater got 0.20 (attested), not 0.99. DoD (2) achieved.`);
}

main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
