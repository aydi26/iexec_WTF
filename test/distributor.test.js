/** L1 unit tests — NoxusDistributor pre-registration (incl. preRegisterMany),
 *  relayReceive parsing/guards (crafted CCTP blobs, the PLAN §4 fixture
 *  technique), integrity-check state guards, fallback lanes and timeouts. */
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const {
  deployNoxStub, freshHandle, addr32, craftMessage, encodeHook,
  expectRevert, increaseTime,
} = require("./helpers.js");

const SRC_DOMAIN = 0;
const FALLBACK_TIMEOUT = 3600;

describe("NoxusDistributor — pre-registration, relay, fallback (L1, stubbed Nox)", function () {
  this.timeout(120_000);

  let usdc, cusdc, messenger, transmitter, dist;
  let deployer, alice, bob, mallory;
  let remoteBatcher; // bytes32 peer identity used in crafted messages

  async function freshFixture() {
    [deployer, alice, bob, mallory] = await ethers.getSigners();
    await deployNoxStub();
    usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    cusdc = await (await ethers.getContractFactory("NoxusCUSDC")).deploy(await usdc.getAddress());
    messenger = await (await ethers.getContractFactory("MockTokenMessenger")).deploy();
    transmitter = await (await ethers.getContractFactory("MockTransmitter")).deploy();
    dist = await (await ethers.getContractFactory("NoxusDistributor")).deploy(
      await usdc.getAddress(), await cusdc.getAddress(),
      await transmitter.getAddress(), await messenger.getAddress(),
      SRC_DOMAIN, FALLBACK_TIMEOUT,
    );
    remoteBatcher = addr32(ethers.Wallet.createRandom().address);
    await (await dist.wirePeer(remoteBatcher)).wait();
  }

  const msgFor = (epochId, claims, overrides = {}) =>
    craftMessage({
      sourceDomain: SRC_DOMAIN,
      mintRecipient: addr32(dist.target),
      amount: 1_050_000n,
      messageSender: remoteBatcher,
      feeExecuted: 10n,
      hookData: encodeHook(epochId, claims),
      ...overrides,
    });

  before(freshFixture);

  it("preRegister registers a claim; exact duplicate (recipient,handle) reverts (BadState)", async () => {
    const h = freshHandle();
    await (await dist.connect(alice).preRegister(0n, alice.address, h, "0x12")).wait();
    await expectRevert(dist.connect(alice).preRegister(0n, alice.address, h, "0x12"), "BadState");
  });

  it("preRegisterMany rejects mismatched / empty arrays (LengthMismatch)", async () => {
    await expectRevert(
      dist.preRegisterMany(0n, [alice.address], [freshHandle(), freshHandle()], ["0x12", "0x34"]),
      "LengthMismatch",
    );
    await expectRevert(dist.preRegisterMany(0n, [], [], []), "LengthMismatch");
  });

  it("preRegisterMany registers several claims in ONE tx (third-party recipients allowed)", async () => {
    const hs = [freshHandle(), freshHandle(), freshHandle()];
    // caller = alice registering for herself + bob + a fresh third party
    const third = ethers.Wallet.createRandom().address;
    await (await dist.connect(alice).preRegisterMany(
      1n, [alice.address, bob.address, third], hs, ["0x01", "0x02", "0x03"],
    )).wait();
    // duplicates within the same epoch still rejected per-item
    await expectRevert(
      dist.connect(alice).preRegisterMany(1n, [bob.address], [hs[1]], ["0x02"]),
      "BadState",
    );
  });

  it("relayReceive rejects short messages and wrong origins", async () => {
    await expectRevert(dist.relayReceive("0x1234", "0x"), "short msg");
    const claims = [[alice.address, freshHandle()]];
    await expectRevert(
      dist.relayReceive(msgFor(2n, claims, { sourceDomain: 7 }), "0x"),
      "BadOrigin",
    );
    await expectRevert(
      dist.relayReceive(msgFor(2n, claims, { messageSender: addr32(mallory.address) }), "0x"),
      "BadOrigin",
    );
    await expectRevert(
      dist.relayReceive(msgFor(2n, claims, { mintRecipient: addr32(mallory.address) }), "0x"),
      "BadOrigin",
    );
  });

  it("relayReceive: registered committed claims resolve; unregistered ones flag hasMissing", async () => {
    // epoch 2: one registered claim + one committed-but-never-registered claim
    const good = freshHandle();
    await (await dist.connect(alice).preRegister(2n, alice.address, good, "0x12")).wait();
    const committed = [[alice.address, good], [mallory.address, freshHandle()]];
    await (await dist.relayReceive(msgFor(2n, committed), "0x")).wait();
    const info = await dist.epochInfo(2n);
    assert.equal(Number(info[0]), 2); // Received
    assert.equal(info[1], 1_050_000n); // aggregate parsed from the crafted blob
    assert.equal(Number(info[3]), 1); // only the registered claim resolved
    assert.equal(info[4], true); // hasMissing (the dust-griefing lane)
  });

  it("checkEpoch refuses a hasMissing epoch (BadState); declareFallback takes it instead", async () => {
    await expectRevert(dist.checkEpoch(2n), "BadState");
    await (await dist.declareFallback(2n)).wait();
    assert.equal(Number((await dist.epochInfo(2n))[0]), 5); // FallbackAttribution
    await expectRevert(dist.declareFallback(2n), "BadState"); // one-way
  });

  it("clean epoch: relay -> checkEpoch flips Received -> CheckPending; preRegister then closes (BadState)", async () => {
    const h = freshHandle();
    await (await dist.connect(alice).preRegister(3n, alice.address, h, "0x12")).wait();
    await (await dist.relayReceive(msgFor(3n, [[alice.address, h]]), "0x")).wait();
    await (await dist.checkEpoch(3n)).wait();
    assert.equal(Number((await dist.epochInfo(3n))[0]), 3); // CheckPending
    // no more pre-registrations once the epoch left PreRegistering
    await expectRevert(dist.connect(bob).preRegister(3n, bob.address, freshHandle(), "0x"), "BadState");
    await expectRevert(dist.checkEpoch(3n), "BadState"); // check is one-shot
  });

  it("forceFallback: NotTimedOut before the window, succeeds after evm_increaseTime", async () => {
    await expectRevert(dist.forceFallback(3n), "NotTimedOut");
    await increaseTime(FALLBACK_TIMEOUT + 60);
    await (await dist.connect(mallory).forceFallback(3n)).wait(); // any caller
    assert.equal(Number((await dist.epochInfo(3n))[0]), 5); // FallbackAttribution
  });

  it("requestClaimReveal is recipient-only (NotRecipient)", async () => {
    // epoch 2 is in fallback with claim #0 owned by alice
    await expectRevert(dist.connect(mallory).requestClaimReveal(2n, 0n), "NotRecipient");
    await (await dist.connect(alice).requestClaimReveal(2n, 0n)).wait();
  });

  it("initiateRefund records the reverse CCTP burn on the mock messenger", async () => {
    // epoch 2 sits in FallbackAttribution; fund the fee-side USDC the refund needs
    await (await usdc.mint(dist.target, 2_000_000n)).wait();
    const before = Number(await messenger.calls());
    await (await dist.initiateRefund(2n, 1_000n)).wait();
    assert.equal(Number(await messenger.calls()), before + 1);
    assert.equal(await messenger.lastAmount(), 1_050_000n); // refunds exactly A
    assert.equal(Number((await dist.epochInfo(2n))[0]), 6); // RefundInitiated
  });

  it("wirePeer is one-shot (AlreadyWired)", async () => {
    await expectRevert(dist.wirePeer(addr32(alice.address)), "AlreadyWired");
  });
});
