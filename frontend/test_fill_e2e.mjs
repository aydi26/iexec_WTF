// E2E of the keeper-filler mode — mirrors the browser flow exactly:
//   user: 1 preRegister + funding + 1 deposit    (the ONLY things they sign)
//   keeper (fill): 2 filler preRegisters + 2 filler deposits, fired at start
//   keeper (back half): close -> settle -> attest -> relay+check -> finalize
// Asserts the epoch reaches Distributed (state 4).
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia, arbitrumSepolia } from "viem/chains";
import { createViemHandleClient } from "@iexec-nox/handle";

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { runPhase } = await import("./api/keeper.js");

const load = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const BATCHER_ABI = load("./src/abis/NoxusBatcher.json");
const DIST_ABI = load("./src/abis/NoxusDistributor.json");
const CUSDC_ABI = load("./src/abis/NoxusCUSDC.json");
const DEP = { 11155111: load("./src/deployments/11155111.json"), 421614: load("./src/deployments/421614.json") };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pk = process.env.DEPLOYER_PRIVATE_KEY.startsWith("0x") ? process.env.DEPLOYER_PRIVATE_KEY : `0x${process.env.DEPLOYER_PRIVATE_KEY}`;
const acct = privateKeyToAccount(pk);
const mk = (chain, rpc) => ({
  pub: createPublicClient({ chain, transport: http(rpc) }),
  wallet: createWalletClient({ account: acct, chain, transport: http(rpc) }),
});
const CONN = {
  11155111: mk(sepolia, "https://ethereum-sepolia-rpc.publicnode.com"),
  421614: mk(arbitrumSepolia, "https://sepolia-rollup.arbitrum.io/rpc"),
};
const USDC = { 11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", 421614: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" };
const DOMAIN = { 11155111: 0, 421614: 3 };

// direction from argv: eth-arb (default) | arb-eth
const direction = process.argv[2] === "arb-eth" ? "arb-eth" : "eth-arb";
const [S, D] = direction === "arb-eth" ? [421614, 11155111] : [11155111, 421614];
const eth = CONN[S]; // source-side connection (naming kept from the original test)
const arb = CONN[D]; // destination-side connection
const me = acct.address;
const batcher = DEP[S].NoxusBatcher;
const dist = DEP[D].NoxusDistributor;
const cusdc = DEP[S].NoxusCUSDC;

async function main() {
  const AMOUNT = 50_000n; // the user's ONLY transfer (0.05 USDC)
  const epochId = await eth.pub.readContract({ address: batcher, abi: BATCHER_ABI, functionName: "currentEpoch" });
  console.log(`\n=== Keeper-filler E2E (${direction}) — epoch ${epochId}, user bridges 0.05, keeper fills 2x0.5 ===`);

  // (1) FILL — fired the moment the bridge starts (what the widget does)
  const t0 = Date.now();
  const f = await runPhase({ phase: "fill", direction, epochId: epochId.toString() });
  console.log(`fill -> ${JSON.stringify({ pre: f.preHashes?.length, dep: f.depHashes?.length, skipped: f.skipped, reason: f.reason })} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (!f.preHashes && !["already filled", "epoch already has co-depositors"].includes(f.reason)) {
    throw new Error(`fill did not engage: ${f.reason || "unknown"}`);
  }

  // (2) USER: 1 preRegister (Arb) — their only destination claim
  const arbH = await createViemHandleClient(arb.wallet);
  const dstEnc = await arbH.encryptInput(AMOUNT, "uint256", dist);
  let h = await arb.wallet.writeContract({ address: dist, abi: DIST_ABI, functionName: "preRegister", args: [epochId, me, dstEnc.handle, dstEnc.handleProof] });
  await arb.pub.waitForTransactionReceipt({ hash: h });
  console.log("user: preRegister x1 done (their ONLY dst claim)");

  // (3) USER: funding (approve-if-needed + wrap, like bridge.js) + 1 deposit (ETH)
  const ERC20 = [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  ];
  const USDC_SRC = USDC[S];
  const allowance = await eth.pub.readContract({ address: USDC_SRC, abi: ERC20, functionName: "allowance", args: [me, cusdc] });
  if (allowance < 60_000n) {
    h = await eth.wallet.writeContract({ address: USDC_SRC, abi: ERC20, functionName: "approve", args: [cusdc, 2n ** 256n - 1n] });
    await eth.pub.waitForTransactionReceipt({ hash: h });
    console.log("user: one-time max USDC approval");
  }
  h = await eth.wallet.writeContract({ address: cusdc, abi: CUSDC_ABI, functionName: "wrap", args: [me, 60_000n] });
  await eth.pub.waitForTransactionReceipt({ hash: h });
  const ethH = await createViemHandleClient(eth.wallet);
  const srcEnc = await ethH.encryptInput(AMOUNT, "uint256", batcher);
  h = await eth.wallet.writeContract({ address: batcher, abi: BATCHER_ABI, functionName: "deposit", args: [me, srcEnc.handle, srcEnc.handleProof, dstEnc.handle] });
  await eth.pub.waitForTransactionReceipt({ hash: h });
  console.log("user: deposit x1 done — user signed NOTHING else from here on");

  // (4) poll: batch must reach 3 deposits (keeper fillers landing)
  for (let t = 0; ; t++) {
    const info = await eth.pub.readContract({ address: batcher, abi: BATCHER_ABI, functionName: "epochInfo", args: [epochId] });
    const n = Number(info[1]);
    if (n >= 3) { console.log(`batch full: ${n}/3 deposits (user 1 + keeper fillers 2)`); break; }
    if (t > 60) throw new Error(`fillers never landed (count ${n})`);
    await sleep(4000);
  }

  // (5) keeper back half
  const c = await runPhase({ phase: "close", direction, epochId: epochId.toString() });
  if (c.hash) await eth.pub.waitForTransactionReceipt({ hash: c.hash });
  console.log("keeper: close", c.hash || `skipped(${c.state})`);
  const s = await runPhase({ phase: "settle", direction, epochId: epochId.toString() });
  if (s.hash) await eth.pub.waitForTransactionReceipt({ hash: s.hash });
  console.log("keeper: settle A=", s.aggregate, "(expect 1050000 = 0.05 + 2x0.5)");
  let att;
  for (let t = 0; t < 90; t++) {
    att = await runPhase({ phase: "attest", direction, domain: DOMAIN[S], txHash: s.hash });
    if (att.status === "complete") break;
    await sleep(3000);
  }
  if (att.status !== "complete") throw new Error("Iris timeout");
  console.log("keeper: attestation complete");
  const rc = await runPhase({ phase: "relaycheck", direction, epochId: epochId.toString(), message: att.message, attestation: att.attestation });
  console.log("keeper: relay", rc.relayHash?.slice(0, 14), "check", rc.checkHash?.slice(0, 14));
  const fin = await runPhase({ phase: "finalize", direction, epochId: epochId.toString() });
  if (fin.checkFailed) throw new Error(`INTEGRITY CHECK FAILED: ${fin.value}`);
  console.log("keeper: finalize state =", fin.state);
  if (fin.state !== 4) throw new Error(`not Distributed: ${fin.state}`);

  console.log(`\nKEEPER-FILLER E2E OK: user signed ONLY 1 preRegister + 1 wrap + 1 deposit; keeper filled 2x0.5 within seconds and drove the rest -> Distributed (state 4).`);
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
