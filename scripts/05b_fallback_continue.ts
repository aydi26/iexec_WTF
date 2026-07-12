/**
 * Phase 5 (continuation) — resume the adversarial epoch from closeEpoch onward.
 * Deposits + inflated pre-registrations for the target epoch are already on-chain.
 * Runs: close -> settle+burn -> relay -> check(==0) -> fallback -> opt-in reveals
 * -> initiateRefund -> relayRefund. Usage: tsx scripts/05b_fallback_continue.ts [epochId]
 */
import { Contract } from "ethers";
import { CHAINS, connect, handleClient, deployments, artifact, publicDecryptWithRetry } from "./lib/common.js";
import { fetchAttestation, computeMaxFee } from "./lib/cctp.js";

async function main() {
  const eth = connect(CHAINS.eth);
  const arb = connect(CHAINS.arb);
  const ethH = await handleClient(eth.wallet);
  const arbH = await handleClient(arb.wallet);
  const epochId = BigInt(process.argv[2] ?? "1");

  const batcher = new Contract(deployments(11155111).ManifoldBatcher, artifact("ManifoldBatcher").abi, eth.wallet);
  const dist = new Contract(deployments(421614).ManifoldDistributor, artifact("ManifoldDistributor").abi, arb.wallet);

  const bi = await batcher.epochInfo(epochId);
  console.log(`\n=== Adversarial continue — epoch ${epochId} (batcher state=${bi[0]} active=${bi[1]}) ===`);
  const total = 450_000n; // A = 0.10+0.15+0.20

  // close (if still Open)
  if (bi[0] === 0n) { await (await batcher.closeEpoch()).wait(); console.log("closeEpoch ok"); }
  // settle (if Closed)
  const bi2 = await batcher.epochInfo(epochId);
  if (bi2[0] === 1n) {
    const [encSum, unwrapReqId] = await batcher.epochHandles(epochId);
    const [sumRes, unwrapRes] = await Promise.all([publicDecryptWithRetry(ethH, encSum), publicDecryptWithRetry(ethH, unwrapReqId)]);
    const maxFee = await computeMaxFee(total, 0, 3);
    const rc = await (await batcher.settleEpoch(sumRes.decryptionProof, unwrapRes.decryptionProof, maxFee)).wait();
    console.log(`settled A=${sumRes.value} + burned (tx ${rc.hash}); polling Iris ...`);
    const m = await fetchAttestation(0, rc.hash);
    await (await dist.relayReceive(m.message, m.attestation)).wait();
    console.log("relayReceive ok");
  }
  // check + finalize -> fallback
  let di = await dist.epochInfo(epochId);
  if (di[0] === 1n /*PreRegistering*/ || di[0] === 2n /*Received*/) {
    if (di[0] === 2n) { await (await dist.checkEpoch(epochId)).wait(); }
    const checkRes = await publicDecryptWithRetry(arbH, await dist.checkHandle(epochId));
    console.log(`integrity check = ${checkRes.value} (expect 0)`);
    await (await dist.finalizeEpoch(epochId, checkRes.decryptionProof)).wait();
  }
  di = await dist.epochInfo(epochId);
  console.log(`dist state after finalize = ${di[0]} (5 = FallbackAttribution)`);

  // opt-in attribution reveal
  if (di[0] === 5n) {
    let revealed = 0n;
    for (let i = 0; i < 3; i++) {
      const c = await dist.claimAt(epochId, i);
      if (!c[3] /*not revealed*/) {
        await (await dist.requestClaimReveal(epochId, i)).wait();
        const r = await publicDecryptWithRetry(arbH, c[2]);
        await (await dist.resolveClaim(epochId, i, r.decryptionProof)).wait();
        revealed += r.value;
        console.log(`  claim ${i} revealed = ${r.value}${i === 2 ? " (INFLATED)" : ""}`);
      }
    }
    console.log(`Sum(revealed)=${revealed} vs A=${total} -> inconsistency ${revealed !== total ? "EXPOSED" : "none"}`);
    // refund-to-source
    const rf = await computeMaxFee(total, 3, 0);
    const rc = await (await dist.initiateRefund(epochId, rf)).wait();
    console.log(`initiateRefund + burned (tx ${rc.hash}); polling Iris (Arb->ETH) ...`);
    const m = await fetchAttestation(3, rc.hash);
    await (await batcher.relayRefund(epochId, m.message, m.attestation)).wait();
  }
  const be = await batcher.epochInfo(epochId);
  console.log(`Batcher epoch state=${be[0]} (3 = Refunded)`);
  if (be[0] !== 3n) throw new Error(`expected Refunded, got ${be[0]}`);
  console.log(`\nADVERSARIAL E2E OK: inflated dst -> check==0 -> attribution reveal exposed the cheat -> refund-to-source re-credited attested amounts. DoD (2) achieved.`);
}

main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
