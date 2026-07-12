/**
 * Phase 1 — deploy NoxusCUSDC (cached) + verify the full wrapper cycle live:
 * approve -> wrap(1 USDC) -> unwrap(external input) -> publicDecrypt(unwrapRequestId)
 * -> finalizeUnwrap -> assert USDC balance restored. Proves the two-step reveal
 * machinery (D-007) end-to-end before any Noxus contract exists.
 *
 * Usage: tsx scripts/00_wrapper_deploy_verify.ts [--chain eth|arb]
 */
import { Contract } from "ethers";
import {
  chainFromArg, connect, handleClient, deploy, deployments, saveDeployment,
  artifact, ADDR, USDC_ABI, publicDecryptWithRetry,
} from "./lib/common.js";

async function main() {
  const c = chainFromArg("eth");
  const { wallet } = connect(c);
  const me = wallet.address;
  const usdcAddr = (ADDR.USDC as any)[c.chainId];
  console.log(`\n=== ${c.name} — wrapper deploy+verify (me=${me}) ===`);

  // deploy or reuse
  let wrapperAddr = deployments(c.chainId).NoxusCUSDC;
  if (!wrapperAddr) {
    const d = await deploy("NoxusCUSDC", wallet, [usdcAddr]);
    wrapperAddr = d.address;
    saveDeployment(c.chainId, "NoxusCUSDC", wrapperAddr);
    console.log(`deployed NoxusCUSDC ${wrapperAddr}`);
  } else console.log(`reusing NoxusCUSDC ${wrapperAddr}`);

  const a = artifact("NoxusCUSDC");
  const wrapper = new Contract(wrapperAddr, a.abi, wallet);
  const usdc = new Contract(usdcAddr, USDC_ABI, wallet);
  const handle = await handleClient(wallet);
  const ONE = 1_000_000n; // 1 USDC (6 dp)

  const usdc0 = await usdc.balanceOf(me);
  console.log(`USDC before: ${usdc0}`);
  if (usdc0 < ONE) throw new Error(`need >= 1 USDC on ${c.name}, have ${usdc0}`);

  // 1) approve + wrap
  if ((await usdc.allowance(me, wrapperAddr)) < ONE) {
    await (await usdc.approve(wrapperAddr, ONE)).wait();
    console.log("approved 1 USDC");
  }
  await (await wrapper.wrap(me, ONE)).wait();
  console.log(`wrapped: USDC now ${await usdc.balanceOf(me)} (locked in wrapper)`);

  // 2) unwrap via external encrypted input (owner=me, app=wrapper -> fromExternal ok)
  const enc = await handle.encryptInput(ONE, "uint256", wrapperAddr as `0x${string}`);
  const tx = await wrapper["unwrap(address,address,bytes32,bytes)"](me, me, enc.handle, enc.handleProof);
  const rcpt = await tx.wait();

  // 3) recover unwrapRequestId from the UnwrapRequested event
  let unwrapRequestId: string | undefined;
  for (const log of rcpt!.logs) {
    try {
      const p = wrapper.interface.parseLog(log);
      if (p?.name === "UnwrapRequested") unwrapRequestId = p.args[1];
    } catch {}
  }
  if (!unwrapRequestId) throw new Error("UnwrapRequested event not found");
  console.log(`unwrapRequestId: ${unwrapRequestId}`);

  // 4) publicDecrypt the request handle (wrapper granted public decryption internally)
  const { value, decryptionProof } = await publicDecryptWithRetry(handle, unwrapRequestId);
  console.log(`publicDecrypt(unwrapRequestId) = ${value} (expect ${ONE})`);
  if (value !== ONE) throw new Error(`unwrap amount mismatch: ${value} != ${ONE}`);

  // 5) finalizeUnwrap -> USDC returns
  await (await wrapper.finalizeUnwrap(unwrapRequestId, decryptionProof)).wait();
  const usdc1 = await usdc.balanceOf(me);
  console.log(`USDC after finalize: ${usdc1} (before was ${usdc0})`);
  if (usdc1 !== usdc0) throw new Error(`balance not restored: ${usdc1} != ${usdc0}`);

  console.log(`\nWRAPPER CYCLE OK on ${c.name}: wrap -> unwrap -> publicDecrypt -> finalizeUnwrap, 1 USDC round-tripped.`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
