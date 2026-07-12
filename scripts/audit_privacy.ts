/**
 * Privacy audit (docs/PLAN.md §4). Static checks on OUR authored contracts:
 *  1. allowPublicDecryption appears at EXACTLY the 3 legal reveal sites (G3).
 *  2. No amount-typed event parameter outside the labeled fallback allowlist.
 *  3. No require/if on encrypted (ebool/euint) values (G5), outside `select`.
 * Vendored packages (node_modules) and interfaces/lib are out of scope.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const AUTHORED = ["contracts/NoxusBatcher.sol", "contracts/NoxusDistributor.sol", "contracts/NoxusCUSDC.sol"];
const EVENT_AMOUNT_ALLOWLIST = ["EpochSettled", "EpochReceived", "RefundInitiated", "FallbackClaimRevealed"];

let failures = 0;
const fail = (m: string) => { console.log(`  FAIL: ${m}`); failures++; };
const ok = (m: string) => console.log(`  ok: ${m}`);

// 1. allowPublicDecryption count == 3, each near a REVEAL SITE / PRIVACY FALLBACK label
let totalReveals = 0;
for (const f of AUTHORED) {
  const src = readFileSync(f, "utf8").split("\n");
  src.forEach((line, i) => {
    if (/\ballowPublicDecryption\s*\(/.test(line) && !line.trim().startsWith("//")) {
      totalReveals++;
      const ctx = src.slice(Math.max(0, i - 2), i + 1).join("\n");
      const labeled = /SITE \d|PRIVACY FALLBACK/.test(ctx);
      console.log(`  reveal @ ${f}:${i + 1} ${labeled ? "[labeled]" : "[UNLABELED]"}`);
      if (!labeled) fail(`unlabeled allowPublicDecryption at ${f}:${i + 1}`);
    }
  });
}
console.log(`\n[1] allowPublicDecryption sites = ${totalReveals} (expect 3)`);
totalReveals === 3 ? ok("exactly 3 legal reveal sites") : fail(`expected 3, found ${totalReveals}`);

// 2. events: no amount-ish param outside the allowlist
console.log(`\n[2] event amount-leakage scan`);
for (const f of AUTHORED) {
  const src = readFileSync(f, "utf8");
  const re = /event\s+(\w+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const [name, params] = [m[1], m[2]];
    const hasAmount = /\bamount\b|\baggregate\b|\bfee/i.test(params) || /uint256\s+\w*amount/i.test(params);
    if (hasAmount && !EVENT_AMOUNT_ALLOWLIST.includes(name)) fail(`event ${name} carries an amount-like param outside allowlist`);
  }
}
if (!failures) ok("no amount leakage in events outside {EpochSettled, EpochReceived, RefundInitiated, FallbackClaimRevealed(labeled)}");

// 3. no require/if directly on encrypted values
console.log(`\n[3] no branch on encrypted values (G5)`);
let branchHits = 0;
for (const f of AUTHORED) {
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (/(require|if)\s*\(/.test(line) && /\b(ebool|euint256|euint16)\b/.test(line)) {
      console.log(`  review @ ${f}:${i + 1}: ${line.trim().slice(0, 80)}`);
      branchHits++;
    }
  });
}
branchHits === 0 ? ok("no require/if on encrypted types") : fail(`${branchHits} potential encrypted-branch(es) — manual review`);

console.log(`\n=== audit:privacy ${failures === 0 ? "PASS" : `FAIL (${failures})`} ===`);
process.exit(failures === 0 ? 0 : 1);
