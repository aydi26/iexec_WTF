// USDC amount helpers (6 decimals). Kept dependency-free of viem's parseUnits
// so the exact rounding/validation behaviour is under our control.
import { CUSDC_DECIMALS } from "../../config/contracts";

/**
 * Parse a human USDC string ("0.10") into base units (bigint, 6 decimals).
 * Returns null for empty / malformed input.
 */
export function parseUsdc(input) {
  if (input == null) return null;
  const s = String(input).trim();
  if (s === "" || !/^\d*\.?\d*$/.test(s) || s === ".") return null;
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > CUSDC_DECIMALS) return null; // too many decimals
  const padded = (frac + "0".repeat(CUSDC_DECIMALS)).slice(0, CUSDC_DECIMALS);
  try {
    return BigInt(whole || "0") * 10n ** BigInt(CUSDC_DECIMALS) + BigInt(padded || "0");
  } catch {
    return null;
  }
}

/** Format base units (bigint) back to a human USDC string. */
export function formatUsdc(units, maxFrac = CUSDC_DECIMALS) {
  if (units == null) return "-";
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(CUSDC_DECIMALS);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(CUSDC_DECIMALS, "0");
  frac = frac.slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

/** True if the string is a plausible 0x-prefixed hex of `bytes` length (in bytes). */
export function isHex(v, bytes) {
  if (typeof v !== "string") return false;
  const re = new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);
  return re.test(v);
}
