/**
 * Phase 1 — finalize D-006: prove the Nox proof owner-binding.
 * An encrypted input created by owner=A (app=C) must clear fromExternal ONLY when
 * A is the direct caller of C. A third party submitting A's input must revert.
 * Uses eth_call simulation (free, no second funded wallet).
 *
 * Usage: tsx scripts/verify_binding.ts [--chain arb|eth]
 */
import { Contract, Wallet } from "ethers";
import { chainFromArg, connect, handleClient, artifact, sleep } from "./lib/common.js";
import { readFileSync, existsSync } from "node:fs";

async function main() {
  const c = chainFromArg("arb");
  const { provider, wallet } = connect(c);
  const cacheFile = `docs/day0/harness-${c.chainId}.json`;
  if (!existsSync(cacheFile)) throw new Error(`no BenchHarness on ${c.name}; run the bench first`);
  const harnessAddr = JSON.parse(readFileSync(cacheFile, "utf8")).address;
  const a = artifact("BenchHarness");
  const harness = new Contract(harnessAddr, a.abi, wallet);
  const handle = await handleClient(wallet);
  const other = Wallet.createRandom().address; // a different address; never signs

  console.log(`\n=== ${c.name} — proof owner-binding test ===`);
  console.log(`harness=${harnessAddr}\nowner(deployer)=${wallet.address}\nthirdParty=${other}`);

  // input created by deployer (owner=deployer, app=harness)
  const enc = await handle.encryptInput(123n, "uint256", harnessAddr as `0x${string}`);
  const data = harness.interface.encodeFunctionData("ingest", [enc.handle, enc.handleProof]);

  // POSITIVE control: owner submits -> should simulate OK
  let positiveOk = false;
  try {
    await provider.call({ to: harnessAddr, from: wallet.address, data });
    positiveOk = true;
  } catch (e: any) {
    console.log(`positive control unexpectedly reverted: ${String(e?.shortMessage ?? e?.message).slice(0, 140)}`);
  }

  // NEGATIVE: a different address submits the SAME input -> should revert (ownerInProof != msg.sender)
  let negativeReverted = false;
  let negErr = "";
  try {
    await provider.call({ to: harnessAddr, from: other, data });
  } catch (e: any) {
    negativeReverted = true;
    negErr = String(e?.shortMessage ?? e?.reason ?? e?.message ?? e).slice(0, 160);
  }

  console.log(`\npositive (owner submits):      ${positiveOk ? "OK (would succeed)" : "REVERTED (!)"}`);
  console.log(`negative (3rd party submits):  ${negativeReverted ? "REVERTED (expected)" : "SUCCEEDED (!)"}`);
  if (negErr) console.log(`  revert reason: ${negErr}`);

  const verdict = positiveOk && negativeReverted;
  console.log(
    `\nD-006 owner-binding ${verdict ? "CONFIRMED" : "NOT confirmed"}: ` +
      (verdict
        ? "a relayer cannot submit a depositor's dst input -> pre-registration (option B) required."
        : "unexpected result -> re-examine before deciding D-006.")
  );
  process.exit(verdict ? 0 : 1);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
