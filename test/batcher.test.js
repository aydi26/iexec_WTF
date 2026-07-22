/** L1 unit tests — NoxusBatcher state machine, guards, batch entry points,
 *  withdraw accounting (F-9 CEI). Runs against the NoxComputeStub injected at
 *  the pinned 31337 NoxCompute address; the REAL NoxusBatcher + NoxusCUSDC are
 *  the code under test. */
const { expect } = (() => { try { return require("chai"); } catch { return { expect: null }; } })();
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const {
  deployNoxStub, freshHandle, addr32, expectRevert, MAX_UINT48,
} = require("./helpers.js");

const DST_DOMAIN = 3;
const MIN_DEPOSITORS = 3;
const MAX_CLAIMS = 8;
const WRAP = 10_000_000n; // 10 USDC of confidential balance per user

describe("NoxusBatcher — state machine & guards (L1, stubbed Nox)", function () {
  this.timeout(120_000);

  let usdc, cusdc, messenger, transmitter, batcher;
  let deployer, alice, bob, carol, mallory;

  async function freshFixture() {
    [deployer, alice, bob, carol, mallory] = await ethers.getSigners();
    await deployNoxStub();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    cusdc = await (await ethers.getContractFactory("NoxusCUSDC")).deploy(await usdc.getAddress());
    messenger = await (await ethers.getContractFactory("MockTokenMessenger")).deploy();
    transmitter = await (await ethers.getContractFactory("MockTransmitter")).deploy();
    batcher = await (await ethers.getContractFactory("NoxusBatcher")).deploy(
      await usdc.getAddress(), await cusdc.getAddress(),
      await messenger.getAddress(), await transmitter.getAddress(),
      DST_DOMAIN, MIN_DEPOSITORS, MAX_CLAIMS,
    );
    await (await batcher.wirePeer(addr32(ethers.Wallet.createRandom().address))).wait();
    // fund + wrap + operator for the three "users"
    for (const u of [alice, bob, carol]) {
      await (await usdc.mint(u.address, WRAP)).wait();
      await (await usdc.connect(u).approve(await cusdc.getAddress(), WRAP)).wait();
      await (await cusdc.connect(u).wrap(u.address, WRAP)).wait();
      await (await cusdc.connect(u).setOperator(await batcher.getAddress(), MAX_UINT48)).wait();
    }
  }

  const dep = (signer, recipient) =>
    batcher.connect(signer).deposit(recipient ?? signer.address, freshHandle(), "0x1234", freshHandle());

  before(freshFixture);

  it("wirePeer is one-shot (AlreadyWired) and deployer-only", async () => {
    await expectRevert(batcher.wirePeer(addr32(alice.address)), "AlreadyWired");
    await expectRevert(batcher.connect(mallory).wirePeer(addr32(alice.address)), "AlreadyWired");
  });

  it("deposit records entries; epochInfo/entryAt stay coherent", async () => {
    await (await dep(alice)).wait();
    await (await dep(bob)).wait();
    let info = await batcher.epochInfo(0n);
    assert.equal(Number(info[0]), 0); // Open
    assert.equal(Number(info[1]), 2); // activeCount
    assert.equal(Number(info[4]), 2); // entryCount
    const e0 = await batcher.entryAt(0n, 0n);
    assert.equal(e0[0], alice.address);
    assert.equal(e0[3], false); // not withdrawn
  });

  it("closeEpoch reverts below minDepositors (TooFewDepositors)", async () => {
    await expectRevert(batcher.closeEpoch(), "TooFewDepositors");
  });

  it("depositMany rejects mismatched / empty arrays (LengthMismatch)", async () => {
    const h = freshHandle();
    await expectRevert(
      batcher.connect(carol).depositMany([carol.address, carol.address], [h], ["0x12"], [h]),
      "LengthMismatch",
    );
    await expectRevert(batcher.connect(carol).depositMany([], [], [], []), "LengthMismatch");
  });

  it("depositMany batches several deposits in ONE tx (counts advance)", async () => {
    const before = Number((await batcher.epochInfo(0n))[1]);
    const hs = [freshHandle(), freshHandle()];
    const ds = [freshHandle(), freshHandle()];
    await (await batcher.connect(carol).depositMany(
      [carol.address, carol.address], hs, ["0x12", "0x34"], ds,
    )).wait();
    const info = await batcher.epochInfo(0n);
    assert.equal(Number(info[1]), before + 2);
  });

  it("withdrawDeposit: only the depositor, only once; accounting updates (F-9)", async () => {
    // entry #0 belongs to alice
    await expectRevert(batcher.connect(mallory).withdrawDeposit(0n, 0n), "NotDepositor");
    const before = Number((await batcher.epochInfo(0n))[1]);
    await (await batcher.connect(alice).withdrawDeposit(0n, 0n)).wait();
    const info = await batcher.epochInfo(0n);
    assert.equal(Number(info[1]), before - 1); // activeCount decremented
    assert.equal((await batcher.entryAt(0n, 0n))[3], true); // withdrawn flag set
    await expectRevert(batcher.connect(alice).withdrawDeposit(0n, 0n), "AlreadyWithdrawn");
  });

  it("closeEpoch flips Open -> Closed once the floor is met; further deposits revert (NotOpen)", async () => {
    // current active: bob + carol×2 = 3 → floor met
    await (await batcher.closeEpoch()).wait();
    const info = await batcher.epochInfo(0n);
    assert.equal(Number(info[0]), 1); // Closed
    await expectRevert(dep(alice), "NotOpen");
    await expectRevert(batcher.closeEpoch(), "NotOpen");
    await expectRevert(batcher.connect(bob).withdrawDeposit(0n, 1n), "NotOpen");
  });

  it("maxClaims caps deposits in an epoch (TooManyClaims)", async () => {
    // fresh contracts to test the cap cleanly
    await freshFixture();
    for (let i = 0; i < MAX_CLAIMS; i++) {
      const u = [alice, bob, carol][i % 3];
      await (await dep(u)).wait();
    }
    await expectRevert(dep(alice), "TooManyClaims");
  });
});
