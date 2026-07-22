/** Shared L1 test helpers (CJS — hardhat v2 mocha runs plain .js). */
const { ethers, network } = require("hardhat");
const { AbiCoder, concat, toBeHex, zeroPadValue } = require("ethers");
const assert = require("node:assert/strict");

/// Pinned NoxCompute address the Nox SDK library resolves for chainid 31337
/// (verified in @iexec-nox/nox-protocol-contracts contracts/sdk/Nox.sol).
const NOX_COMPUTE_ADDR = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685";
const ZERO32 = "0x" + "00".repeat(32);
const MAX_UINT48 = 2n ** 48n - 1n;

/// Deploy NoxComputeStub normally, then inject its runtime code at the pinned
/// address via hardhat_setCode so every Nox.* library call hits the stub.
async function deployNoxStub() {
  const factory = await ethers.getContractFactory("NoxComputeStub");
  const stub = await factory.deploy();
  await stub.waitForDeployment();
  const code = await ethers.provider.getCode(await stub.getAddress());
  await network.provider.send("hardhat_setCode", [NOX_COMPUTE_ADDR, code]);
}

let handleNonce = 0;
/// Fresh pseudo external handle (bytes32) for deposit/preRegister inputs.
function freshHandle() {
  handleNonce += 1;
  return ethers.keccak256(ethers.toUtf8Bytes(`test-external-handle-${handleNonce}`));
}

/// Encode a plaintext uint256 as the 32-byte "decryption proof" the
/// NoxComputeStub echoes back through validateDecryptionProof.
function proofFor(value) {
  return zeroPadValue(toBeHex(value), 32);
}

function addr32(address) {
  return zeroPadValue(address, 32);
}

const u32 = (v) => zeroPadValue(toBeHex(v), 4);
const b32 = (v) => (typeof v === "bigint" ? zeroPadValue(toBeHex(v), 32) : zeroPadValue(v, 32));

/// Assemble a CCTP V2 MessageV2 + BurnMessageV2 blob at the exact fixed offsets
/// documented in contracts/lib/CCTPMessageParser.sol.
function craftMessage(o) {
  return concat([
    u32(1), // version
    u32(o.sourceDomain ?? 0),
    u32(o.destinationDomain ?? 3),
    b32(o.nonce ?? 1n),
    b32(o.sender ?? ZERO32),
    b32(o.recipient ?? ZERO32),
    b32(o.destinationCaller ?? ZERO32),
    u32(o.minFinalityThreshold ?? 1000),
    u32(o.finalityThresholdExecuted ?? 1000),
    u32(1), // body version
    b32(o.burnToken ?? ZERO32),
    b32(o.mintRecipient),
    b32(o.amount),
    b32(o.messageSender),
    b32(o.maxFee ?? 0n),
    b32(o.feeExecuted ?? 0n),
    b32(o.expirationBlock ?? 0n),
    o.hookData ?? "0x",
  ]);
}

/// abi.encode(epochId, ClaimId[]) — the hookData payload relayReceive decodes.
function encodeHook(epochId, claims) {
  return AbiCoder.defaultAbiCoder().encode(
    ["uint256", "tuple(address recipient, bytes32 dstHandle)[]"],
    [epochId, claims],
  );
}

/// Assert a call reverts and the revert output contains `fragment`.
async function expectRevert(p, fragment) {
  let failed = false;
  try {
    const res = await p;
    if (res && typeof res.wait === "function") await res.wait();
  } catch (e) {
    failed = true;
    const msg = String((e && e.message) || e);
    assert.ok(msg.includes(fragment), `expected revert containing "${fragment}", got: ${msg}`);
  }
  assert.ok(failed, `expected revert containing "${fragment}", but the call succeeded`);
}

async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine", []);
}

module.exports = {
  NOX_COMPUTE_ADDR, ZERO32, MAX_UINT48,
  deployNoxStub, freshHandle, proofFor, addr32,
  craftMessage, encodeHook, expectRevert, increaseTime,
};
