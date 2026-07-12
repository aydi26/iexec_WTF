/** CCTP V2 helpers: fast burn, Iris attestation polling, receiveMessage. */
import { Contract, Wallet, zeroPadValue, getAddress } from "ethers";
import { ADDR, sleep } from "./common.js";

const IRIS = "https://iris-api-sandbox.circle.com";

const TOKEN_MESSENGER_ABI = [
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
];
const TRANSMITTER_ABI = ["function receiveMessage(bytes message, bytes attestation) returns (bool)"];
const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];

export const FAST_THRESHOLD = 1000;
export const bytes32Addr = (a: string) => zeroPadValue(getAddress(a), 32);

/** Live fast fee (bps) for src->dst from Iris, with a safety multiple. */
export async function computeMaxFee(amount: bigint, srcDomain: number, dstDomain: number): Promise<bigint> {
  try {
    const r = await fetch(`${IRIS}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, { signal: AbortSignal.timeout(15000) });
    const arr = (await r.json()) as Array<{ finalityThreshold: number; minimumFee: number }>;
    const fast = arr.find((x) => x.finalityThreshold <= 1000) ?? arr[0];
    const bps = fast?.minimumFee ?? 1;
    // maxFee = ceil(amount * bps / 10000) * 3 (margin), min 1
    const fee = (amount * BigInt(Math.ceil(bps * 100)) + 999_999n) / 1_000_000n; // bps*100/1e6 = bps/1e4
    return fee * 3n > 0n ? fee * 3n : 1n;
  } catch {
    return amount / 1000n > 0n ? amount / 1000n : 1n; // fallback 10 bps
  }
}

/** Burn USDC on the source chain (fast). destinationCaller=bytes32(0) => anyone relays;
 *  pass a specific caller to restrict receiveMessage. Returns the burn tx hash. */
export async function fastBurn(
  wallet: Wallet,
  usdcAddr: string,
  opts: { amount: bigint; dstDomain: number; mintRecipient: string; destinationCaller: string; hookData: string; maxFee: bigint }
): Promise<string> {
  const usdc = new Contract(usdcAddr, ERC20_ABI, wallet);
  if ((await usdc.allowance(wallet.address, ADDR.TOKEN_MESSENGER_V2)) < opts.amount) {
    await (await usdc.approve(ADDR.TOKEN_MESSENGER_V2, opts.amount)).wait();
  }
  const tm = new Contract(ADDR.TOKEN_MESSENGER_V2, TOKEN_MESSENGER_ABI, wallet);
  const noHook = !opts.hookData || opts.hookData === "0x";
  const tx = noHook
    ? await tm.depositForBurn(opts.amount, opts.dstDomain, opts.mintRecipient, usdcAddr, opts.destinationCaller, opts.maxFee, FAST_THRESHOLD)
    : await tm.depositForBurnWithHook(opts.amount, opts.dstDomain, opts.mintRecipient, usdcAddr, opts.destinationCaller, opts.maxFee, FAST_THRESHOLD, opts.hookData);
  const rc = await tx.wait();
  return rc!.hash;
}

/** Poll Iris until the burn is attested; returns the message + attestation bytes. */
export async function fetchAttestation(srcDomain: number, burnTxHash: string, timeoutMs = 300_000) {
  const url = `${IRIS}/v2/messages/${srcDomain}?transactionHash=${burnTxHash}`;
  const t0 = Date.now();
  let delay = 2000;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (r.ok) {
        const j = (await r.json()) as { messages?: Array<{ status: string; message: string; attestation: string; delayReason?: string }> };
        const m = j.messages?.[0];
        if (m?.status === "complete" && m.message && m.attestation && m.attestation !== "0x") {
          return { message: m.message, attestation: m.attestation };
        }
        if (m?.delayReason) console.log(`  Iris delayReason: ${m.delayReason}`);
      }
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`Iris attestation timeout for ${burnTxHash}`);
    await sleep(delay);
    delay = Math.min(delay * 1.3, 8000);
  }
}

/** Call MessageTransmitterV2.receiveMessage directly (for non-Manifold mints, e.g. seeding). */
export async function receiveMessage(wallet: Wallet, message: string, attestation: string): Promise<string> {
  const tr = new Contract(ADDR.MESSAGE_TRANSMITTER_V2, TRANSMITTER_ABI, wallet);
  const tx = await tr.receiveMessage(message, attestation);
  const rc = await tx.wait();
  return rc!.hash;
}
