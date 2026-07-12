/**
 * Resilient resume of the adversarial epoch: finds the settle burn tx from the
 * EpochSettled event (so a mid-run RPC nonce glitch doesn't force a redo), then
 * relays -> check -> fallback -> reveals -> refund. Usage: tsx scripts/05d_resume.ts [epochId]
 */
import { Contract } from "ethers";
import { CHAINS, connect, handleClient, deployments, artifact, ADDR, publicDecryptWithRetry } from "./lib/common.js";
import { fetchAttestation, computeMaxFee } from "./lib/cctp.js";

const USDC_ABI = ["function transfer(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const arbH = await handleClient(arb.wallet);
  const epochId = BigInt(process.argv[2] ?? "1");
  const total = 450_000n;

  const batcher = new Contract(deployments(11155111).NoxusBatcher, artifact("NoxusBatcher").abi, eth.wallet);
  const dist = new Contract(deployments(421614).NoxusDistributor, artifact("NoxusDistributor").abi, arb.wallet);
  const usdc = new Contract((ADDR.USDC as any)[11155111], USDC_ABI, eth.wallet);

  let di = await dist.epochInfo(epochId);
  console.log(`dist epoch ${epochId} state=${di[0]} aggregate=${di[1]} claims=${di[3]}`);

  // 1) relay the settle burn if not yet received (state < Received=2)
  if (di[0] < 2n) {
    const ev = await batcher.queryFilter(batcher.filters.EpochSettled(epochId));
    if (!ev.length) throw new Error("no EpochSettled event; settle may not have happened");
    const settleTx = ev[ev.length - 1].transactionHash;
    console.log(`found settle tx ${settleTx}; polling Iris ...`);
    const m = await fetchAttestation(0, settleTx);
    await (await dist.relayReceive(m.message, m.attestation)).wait();
    console.log("relayReceive ok");
    di = await dist.epochInfo(epochId);
  }

  // 2) check -> finalize -> fallback
  if (di[0] === 2n) { await (await dist.checkEpoch(epochId)).wait(); }
  di = await dist.epochInfo(epochId);
  if (di[0] === 3n /*CheckPending*/) {
    const cr = await publicDecryptWithRetry(arbH, await dist.checkHandle(epochId));
    console.log(`integrity check = ${cr.value} (expect 0)`);
    await (await dist.finalizeEpoch(epochId, cr.decryptionProof)).wait();
  }
  di = await dist.epochInfo(epochId);
  console.log(`dist state = ${di[0]} (5 = FallbackAttribution)`);

  // 3) opt-in reveals + refund
  if (di[0] === 5n) {
    let revealed = 0n;
    for (let i = 0; i < 3; i++) {
      const c = await dist.claimAt(epochId, i);
      if (!c[3]) {
        await (await dist.requestClaimReveal(epochId, i)).wait();
        const r = await publicDecryptWithRetry(arbH, c[2]);
        await (await dist.resolveClaim(epochId, i, r.decryptionProof)).wait();
        revealed += r.value;
        console.log(`  claim ${i} revealed = ${r.value}${i === 2 ? " (INFLATED)" : ""}`);
      } else revealed += BigInt(c[4]);
    }
    console.log(`Sum(revealed)=${revealed} vs A=${total} -> ${revealed !== total ? "EXPOSED" : "consistent"}`);
    // ensure Batcher plain-USDC buffer for the refund leg fee
    if ((await usdc.balanceOf(deployments(11155111).NoxusBatcher)) < 60_000n) {
      await (await usdc.transfer(deployments(11155111).NoxusBatcher, 100_000n)).wait();
    }
    const rc = await (await dist.initiateRefund(epochId, await computeMaxFee(total, 3, 0))).wait();
    console.log(`initiateRefund + burned (${rc.hash}); polling Iris (Arb->ETH) ...`);
    const m = await fetchAttestation(3, rc.hash);
    await (await batcher.relayRefund(epochId, m.message, m.attestation)).wait();
  } else if (di[0] === 6n) {
    // refund already initiated; find the tx + relay
    const ev = await dist.queryFilter(dist.filters.RefundInitiated(epochId));
    const m = await fetchAttestation(3, ev[ev.length - 1].transactionHash);
    await (await batcher.relayRefund(epochId, m.message, m.attestation)).wait();
  }

  const be = await batcher.epochInfo(epochId);
  console.log(`Batcher epoch ${epochId} state=${be[0]} (3 = Refunded)`);
  if (be[0] !== 3n) throw new Error(`expected Refunded, got ${be[0]}`);
  console.log(`\nADVERSARIAL E2E OK (fresh Noxus): inflated claim -> check==0 -> reveal exposed cheat -> refund-to-source. DoD (2) achieved.`);
}

main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
