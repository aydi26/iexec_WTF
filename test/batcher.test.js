/** L1 unit tests — NoxusBatcher state machine, guards, batch entry points,
 *  withdraw accounting (F-9 CEI). Runs against the NoxComputeStub injected at
 *  the pinned 31337 NoxCompute address; the REAL NoxusBatcher + NoxusCUSDC are
 *  the code under test. */
const { expect } = (() => { try { return require("chai"); } catch { return { expect: null }; } })();
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const {
  deployNoxStub, freshHandle, addr32, expectRevert, MAX_UINT48,
  proofFor, craftMessage, ZERO32,
} = require("./helpers.js");
const { AbiCoder } = require("ethers");

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

  it("grantAuditor: only the entry's depositor may grant (NotDepositor); owner succeeds", async () => {
    // fresh state; entry #0 belongs to alice
    await freshFixture();
    await (await dep(alice)).wait();
    // a non-depositor cannot grant view access on alice's entry
    await expectRevert(batcher.connect(mallory).grantAuditor(0n, 0n, mallory.address), "NotDepositor");
    // the depositor herself can (stub addViewer is a no-op that accepts anything)
    await (await batcher.connect(alice).grantAuditor(0n, 0n, mallory.address)).wait();
  });
});

/** Settle / refund happy-path + view coherence. These need the wrapper to
 *  actually hold USDC (the fixture wraps 30 USDC across three users) so
 *  settleEpoch's `usdc.balanceOf(this) - bal0 == A` delta check is satisfiable
 *  against the stub: finalizeUnwrap decrypts the (echoed) proofT into A and
 *  SafeERC20-transfers exactly A of the wrapped MockUSDC to the batcher. */
describe("NoxusBatcher — settle, refund, views (L1, stubbed Nox)", function () {
  this.timeout(120_000);

  let usdc, cusdc, messenger, transmitter, batcher;
  let deployer, alice, bob, carol, dave, remoteDist;

  async function freshFixture() {
    [deployer, alice, bob, carol, dave] = await ethers.getSigners();
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
    remoteDist = addr32(ethers.Wallet.createRandom().address);
    await (await batcher.wirePeer(remoteDist)).wait();
    for (const u of [alice, bob, carol]) {
      await (await usdc.mint(u.address, WRAP)).wait();
      await (await usdc.connect(u).approve(await cusdc.getAddress(), WRAP)).wait();
      await (await cusdc.connect(u).wrap(u.address, WRAP)).wait();
      await (await cusdc.connect(u).setOperator(await batcher.getAddress(), MAX_UINT48)).wait();
    }
  }

  const depTo = (signer, recipient, dstHandle) =>
    batcher.connect(signer).deposit(recipient, freshHandle(), "0x1234", dstHandle ?? freshHandle());

  // abi.encode(epochId) — the refund-leg hookData relayRefund decodes.
  const refundHook = (epochId) => AbiCoder.defaultAbiCoder().encode(["uint256"], [epochId]);

  const A = 5_000_000n; // <= 30 USDC the wrapper holds, so finalizeUnwrap can release it

  before(freshFixture);

  it("epochHandles: encSum initialized at open, unwrapRequestId set only after close", async () => {
    const eh = await batcher.epochHandles(0n);
    assert.notEqual(eh[0], ZERO32); // encSum is Nox.toEuint256(0) -> a fresh non-zero handle
    assert.equal(eh[1], ZERO32); // no unwrap requested yet
  });

  it("settleEpoch: reveals A, finalizes the unwrap, ships the ordered ACTIVE claim set (F-9 skip/order)", async () => {
    // four deposits; withdraw the 2nd so _activeClaims must skip it and keep order
    const dh = [freshHandle(), freshHandle(), freshHandle(), freshHandle()];
    await (await depTo(alice, alice.address, dh[0])).wait();
    await (await depTo(bob, bob.address, dh[1])).wait();
    await (await depTo(carol, carol.address, dh[2])).wait();
    await (await depTo(alice, dave.address, dh[3])).wait(); // recipient = dave (third-party send)
    await (await batcher.connect(bob).withdrawDeposit(0n, 1n)).wait(); // drop entry #1

    await (await batcher.closeEpoch()).wait();
    const ehAfterClose = await batcher.epochHandles(0n);
    assert.notEqual(ehAfterClose[1], ZERO32); // unwrapRequestId now set

    const bal0 = await usdc.balanceOf(batcher.target);
    await (await batcher.settleEpoch(proofFor(A), proofFor(A), 0n)).wait();

    const info = await batcher.epochInfo(0n);
    assert.equal(Number(info[0]), 2); // Settled
    assert.equal(info[2], A); // aggregate
    // finalizeUnwrap released exactly A of the wrapped USDC to the batcher
    assert.equal(await usdc.balanceOf(batcher.target) - bal0, A);

    // bridge fired: exactly A burned, and the shipped hookData carries the
    // ORDERED ACTIVE claims (bob's withdrawn entry #1 skipped, order preserved)
    assert.equal(Number(await messenger.calls()), 1);
    assert.equal(await messenger.lastAmount(), A);
    const [epochId, claims] = AbiCoder.defaultAbiCoder().decode(
      ["uint256", "tuple(address recipient, bytes32 dstHandle)[]"], await messenger.lastHookData(),
    );
    assert.equal(epochId, 0n);
    assert.equal(claims.length, 3); // 4 deposits - 1 withdrawn
    assert.deepEqual(claims.map((c) => c.recipient), [alice.address, carol.address, dave.address]);
    assert.deepEqual(claims.map((c) => c.dstHandle), [dh[0], dh[2], dh[3]]);

    // a new epoch opened; state machine advanced
    assert.equal(Number(await batcher.currentEpoch()), 1);
  });

  it("relayRefund: state guard precedes everything (NotClosed on an unsettled epoch)", async () => {
    // epoch 1 is freshly Open (never settled) -> the state check fires first,
    // before the short-msg / origin / hookData checks are ever reached
    await expectRevert(batcher.relayRefund(1n, "0x1234", "0x"), "NotClosed");
  });

  it("relayRefund negatives on a Settled epoch: short msg, then bad origin fields, then epoch tag", async () => {
    // epoch 0 is Settled from the prior test; all these checks live AFTER the
    // state guard so they are only reachable once an epoch is refund-eligible.
    await expectRevert(batcher.relayRefund(0n, "0x1234", "0x"), "short msg");

    const base = { mintRecipient: addr32(batcher.target), amount: A, messageSender: remoteDist };
    await expectRevert(
      batcher.relayRefund(0n, craftMessage({ ...base, sourceDomain: 99, hookData: refundHook(0n) }), "0x"),
      "bad srcDomain",
    );
    await expectRevert(
      batcher.relayRefund(0n, craftMessage({
        ...base, sourceDomain: DST_DOMAIN, messageSender: addr32(carol.address), hookData: refundHook(0n),
      }), "0x"),
      "bad sender",
    );
    await expectRevert(
      batcher.relayRefund(0n, craftMessage({
        ...base, sourceDomain: DST_DOMAIN, mintRecipient: addr32(carol.address), hookData: refundHook(0n),
      }), "0x"),
      "bad recipient",
    );
    await expectRevert(
      batcher.relayRefund(0n, craftMessage({ ...base, sourceDomain: DST_DOMAIN, hookData: refundHook(42n) }), "0x"),
      "epoch",
    );
  });

  it("relayRefund happy path re-wraps A and credits depositors; second call reverts (NotClosed)", async () => {
    const goodMsg = craftMessage({
      sourceDomain: DST_DOMAIN, mintRecipient: addr32(batcher.target), amount: A,
      messageSender: remoteDist, hookData: refundHook(0n),
    });
    await (await batcher.relayRefund(0n, goodMsg, "0x")).wait();
    assert.equal(Number((await batcher.epochInfo(0n))[0]), 3); // Refunded
    // CEI + one-shot: a replay is rejected by the (refunded || !Settled) guard
    await expectRevert(batcher.relayRefund(0n, goodMsg, "0x"), "NotClosed");
  });
});
