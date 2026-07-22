/** L1 unit tests — CCTPMessageParser fixed-offset field extraction, verified
 *  against crafted MessageV2+BurnMessageV2 blobs (offsets from Circle source). */
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { craftMessage, encodeHook, addr32, freshHandle } = require("./helpers.js");

describe("CCTPMessageParser — fixed-offset extraction (L1)", function () {
  this.timeout(60_000);

  let harness;

  before(async () => {
    harness = await (await ethers.getContractFactory("CCTPParserHarness")).deploy();
  });

  it("extracts every field the Distributor relies on from a crafted blob", async () => {
    const sender = addr32(ethers.Wallet.createRandom().address);
    const recipient = addr32(ethers.Wallet.createRandom().address);
    const hook = encodeHook(7n, [[ethers.Wallet.createRandom().address, freshHandle()]]);
    const m = craftMessage({
      sourceDomain: 3,
      mintRecipient: recipient,
      amount: 123_456_789n,
      messageSender: sender,
      feeExecuted: 42n,
      hookData: hook,
    });
    assert.equal(Number(await harness.sourceDomain(m)), 3);
    assert.equal(await harness.bodyMessageSender(m), sender);
    assert.equal(await harness.bodyMintRecipient(m), recipient);
    assert.equal(await harness.amount(m), 123_456_789n);
    assert.equal(await harness.feeExecuted(m), 42n);
    assert.equal(await harness.hookData(m), hook);
  });

  it("hookData round-trips an abi-encoded (epochId, ClaimId[]) payload", async () => {
    const claims = [
      [ethers.Wallet.createRandom().address, freshHandle()],
      [ethers.Wallet.createRandom().address, freshHandle()],
      [ethers.Wallet.createRandom().address, freshHandle()],
    ];
    const hook = encodeHook(99n, claims);
    const m = craftMessage({
      mintRecipient: addr32(ethers.Wallet.createRandom().address),
      amount: 1n,
      messageSender: addr32(ethers.Wallet.createRandom().address),
      hookData: hook,
    });
    const out = await harness.hookData(m);
    const [epochId, decoded] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["uint256", "tuple(address recipient, bytes32 dstHandle)[]"],
      out,
    );
    assert.equal(epochId, 99n);
    assert.equal(decoded.length, 3);
    assert.equal(decoded[1].recipient, claims[1][0]);
    assert.equal(decoded[2].dstHandle, claims[2][1]);
  });
});
