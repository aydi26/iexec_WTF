// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Nox, euint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import "encrypted-types/EncryptedTypes.sol";
import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {IERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";
import {IMessageTransmitterV2} from "./interfaces/IMessageTransmitterV2.sol";
import {CCTPMessageParser} from "./lib/CCTPMessageParser.sol";

/// @title NoxusBatcher (ETH Sepolia source leg) — see docs/PLAN.md §3.1.
/// @notice Confidential cUSDC deposits accumulate into an encrypted sum; one
/// public aggregate A is revealed at settle and bridged via CCTP V2 with a
/// hookData commitment (epochId + claimsHash) binding the destination claims.
/// Individual amounts never touch the chain. D-006 = option B: depositors
/// pre-register their dst claim on the Distributor; here we only record the
/// (recipient, dstHandle) pairs to build claimsHash.
contract NoxusBatcher {
    using CCTPMessageParser for bytes;

    enum State { Open, Closed, Settled, Refunded }

    struct Entry {
        address depositor;
        euint256 transferred; // returned handle from confidentialTransferFrom (D-009)
        address recipient; // destination recipient
        bytes32 dstHandle; // external handle pre-registered on the Distributor
        bool withdrawn;
    }

    struct Epoch {
        State state;
        euint256 encSum; // encrypted running sum
        euint256 unwrapRequestId; // fresh handle from wrapper.unwrap (D-007)
        uint32 activeCount; // non-withdrawn deposits
        uint256 aggregate; // public A, set at settle
        bool refunded;
        Entry[] entries;
    }

    // --- immutables / wiring ---
    IERC20 public immutable usdc;
    IERC7984 public immutable cusdc; // our NoxusCUSDC wrapper (as ERC-7984)
    IERC20ToERC7984Wrapper public immutable wrapper; // same address, wrapper view
    ITokenMessengerV2 public immutable tokenMessenger;
    IMessageTransmitterV2 public immutable messageTransmitter; // for the refund leg
    uint32 public immutable dstDomain; // Arbitrum = 3
    uint32 public immutable minDepositors; // k-anonymity floor (3)
    uint32 public immutable maxClaims;
    address public immutable deployer;

    bytes32 public remoteDistributor; // set once via wirePeer
    bool public bridgeEnabled; // burn gated until wired (Phase 2 micro-epoch runs with this false)

    uint256 public currentEpoch;
    mapping(uint256 => Epoch) private epochs;

    uint32 private constant FAST_THRESHOLD = 1000;

    event Deposited(uint256 indexed epochId, address indexed depositor, address indexed recipient, uint256 index);
    event DepositWithdrawn(uint256 indexed epochId, uint256 index);
    event EpochClosed(uint256 indexed epochId, uint32 activeCount);
    event EpochSettled(uint256 indexed epochId, uint256 aggregate, bytes32 claimsHash);
    event EpochRefunded(uint256 indexed epochId);
    event PeerWired(bytes32 remoteDistributor);

    error NotOpen();
    error NotClosed();
    error TooFewDepositors();
    error TooManyClaims();
    error NotDepositor();
    error AlreadyWithdrawn();
    error AggregateMismatch();
    error AlreadyWired();

    constructor(
        IERC20 _usdc,
        address _cusdc,
        ITokenMessengerV2 _tokenMessenger,
        IMessageTransmitterV2 _messageTransmitter,
        uint32 _dstDomain,
        uint32 _minDepositors,
        uint32 _maxClaims
    ) {
        usdc = _usdc;
        cusdc = IERC7984(_cusdc);
        wrapper = IERC20ToERC7984Wrapper(_cusdc);
        tokenMessenger = _tokenMessenger;
        messageTransmitter = _messageTransmitter;
        dstDomain = _dstDomain;
        minDepositors = _minDepositors;
        maxClaims = _maxClaims;
        deployer = msg.sender;
        _openEpoch(0);
    }

    /// @dev One-time wiring of the destination peer; enables bridging.
    function wirePeer(bytes32 _remoteDistributor) external {
        if (msg.sender != deployer) revert AlreadyWired(); // deployer-only config; re-settable
        remoteDistributor = _remoteDistributor;
        bridgeEnabled = true;
        emit PeerWired(_remoteDistributor);
    }

    /// @notice Confidential deposit. Depositor must hold cUSDC and have called
    /// cusdc.setOperator(this, expiry). srcHandle/srcProof must be created with
    /// app = this contract, owner = msg.sender (Nox binding).
    function deposit(
        address dstRecipient,
        externalEuint256 srcHandle,
        bytes calldata srcProof,
        bytes32 dstHandle
    ) external {
        Epoch storage e = epochs[currentEpoch];
        if (e.state != State.Open) revert NotOpen();
        if (e.activeCount >= maxClaims) revert TooManyClaims();

        euint256 amt = Nox.fromExternal(srcHandle, srcProof);
        Nox.allowTransient(amt, address(wrapper));
        euint256 transferred = cusdc.confidentialTransferFrom(msg.sender, address(this), amt);

        (ebool ok, euint256 s) = Nox.safeAdd(e.encSum, transferred);
        e.encSum = Nox.select(ok, s, e.encSum); // overflow branch is dead at USDC supply (G5 form)
        Nox.allowThis(e.encSum);
        Nox.allowThis(transferred);
        Nox.allow(transferred, msg.sender);

        e.entries.push(Entry(msg.sender, transferred, dstRecipient, dstHandle, false));
        e.activeCount += 1;
        emit Deposited(currentEpoch, msg.sender, dstRecipient, e.entries.length - 1);
    }

    /// @notice Heals the innocent zero/short-transfer case or a change of mind
    /// while the epoch is still Open. Removes the deposit from the sum and refunds.
    function withdrawDeposit(uint256 epochId, uint256 index) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.Open) revert NotOpen();
        Entry storage en = e.entries[index];
        if (en.depositor != msg.sender) revert NotDepositor();
        if (en.withdrawn) revert AlreadyWithdrawn();

        (ebool ok, euint256 s) = Nox.safeSub(e.encSum, en.transferred);
        e.encSum = Nox.select(ok, s, e.encSum);
        Nox.allowThis(e.encSum);

        Nox.allowTransient(en.transferred, address(wrapper));
        cusdc.confidentialTransfer(msg.sender, en.transferred);

        en.withdrawn = true;
        e.activeCount -= 1;
        emit DepositWithdrawn(epochId, index);
    }

    /// @notice Close the epoch: reveal the sum (SITE 1) and start the wrapper unwrap.
    function closeEpoch() external {
        Epoch storage e = epochs[currentEpoch];
        if (e.state != State.Open) revert NotOpen();
        if (e.activeCount < minDepositors) revert TooFewDepositors();

        Nox.allowPublicDecryption(e.encSum); // SITE 1 — epoch sum
        Nox.allowTransient(e.encSum, address(wrapper));
        e.unwrapRequestId = wrapper.unwrap(address(this), address(this), e.encSum);
        e.state = State.Closed;
        emit EpochClosed(currentEpoch, e.activeCount);
    }

    /// @notice Settle: verify A on-chain, finalize the unwrap, and (if wired) burn+bridge.
    /// proofA verifies encSum -> A; proofT finalizes the wrapper unwrap. Both KMS proofs
    /// are fetched concurrently by the keeper (one wall-clock RTT, D-007).
    function settleEpoch(bytes calldata proofA, bytes calldata proofT, uint256 maxFee) external {
        uint256 epochId = currentEpoch;
        Epoch storage e = epochs[epochId];
        if (e.state != State.Closed) revert NotClosed();
        if (e.activeCount < minDepositors) revert TooFewDepositors();

        uint256 a = Nox.publicDecrypt(e.encSum, proofA);
        require(maxFee <= a / 100, "maxFee too high");

        uint256 bal0 = usdc.balanceOf(address(this));
        wrapper.finalizeUnwrap(e.unwrapRequestId, proofT);
        if (usdc.balanceOf(address(this)) - bal0 != a) revert AggregateMismatch();

        e.aggregate = a;
        e.state = State.Settled;
        bytes32 claimsHash = _claimsHash(e);
        emit EpochSettled(epochId, a, claimsHash);

        if (bridgeEnabled) {
            bytes memory hookData = abi.encode(epochId, e.activeCount, claimsHash);
            usdc.approve(address(tokenMessenger), a);
            tokenMessenger.depositForBurnWithHook(
                a, dstDomain, remoteDistributor, address(usdc), remoteDistributor, maxFee, FAST_THRESHOLD, hookData
            );
        }
        _openEpoch(epochId + 1);
    }

    /// @notice Receive a refund leg from the Distributor (fallback path): re-wrap A
    /// and confidentially credit each active depositor their attested source amount.
    function relayRefund(uint256 epochId, bytes calldata message, bytes calldata attestation) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.Settled || e.refunded) revert NotClosed();
        require(messageTransmitter.receiveMessage(message, attestation), "receiveMessage failed");
        require(message.sourceDomain() == dstDomain, "bad srcDomain");
        require(message.bodyMessageSender() == remoteDistributor, "bad sender");
        require(message.bodyMintRecipient() == bytes32(uint256(uint160(address(this)))), "bad recipient");
        require(abi.decode(message.hookData(), (uint256)) == epochId, "epoch");

        uint256 a = e.aggregate;
        usdc.approve(address(wrapper), a);
        wrapper.wrap(address(this), a); // fee buffer covers the inbound refund fee
        uint256 n = e.entries.length;
        for (uint256 i; i < n; ++i) {
            Entry storage en = e.entries[i];
            if (en.withdrawn) continue;
            Nox.allowTransient(en.transferred, address(wrapper));
            cusdc.confidentialTransfer(en.depositor, en.transferred); // recipient ACL via token _update
        }
        e.refunded = true;
        e.state = State.Refunded;
        emit EpochRefunded(epochId);
    }

    /// @notice Grant an auditor view access to a depositor's amount. Add-only:
    /// Nox has no removeViewer, so grants are irrevocable on-chain (see feedback.md).
    function grantAuditor(uint256 epochId, uint256 index, address auditor) external {
        Entry storage en = epochs[epochId].entries[index];
        if (en.depositor != msg.sender) revert NotDepositor();
        Nox.addViewer(en.transferred, auditor);
    }

    // --- views (auto-getters omit array/handle members) ---
    function epochHandles(uint256 epochId) external view returns (euint256 encSum, euint256 unwrapRequestId) {
        Epoch storage e = epochs[epochId];
        return (e.encSum, e.unwrapRequestId);
    }

    function epochInfo(uint256 epochId)
        external
        view
        returns (State state, uint32 activeCount, uint256 aggregate, bool refunded, uint256 entryCount)
    {
        Epoch storage e = epochs[epochId];
        return (e.state, e.activeCount, e.aggregate, e.refunded, e.entries.length);
    }

    function entryAt(uint256 epochId, uint256 index)
        external
        view
        returns (address depositor, address recipient, bytes32 dstHandle, bool withdrawn)
    {
        Entry storage en = epochs[epochId].entries[index];
        return (en.depositor, en.recipient, en.dstHandle, en.withdrawn);
    }

    function claimsHashOf(uint256 epochId) external view returns (bytes32) {
        return _claimsHash(epochs[epochId]);
    }

    // --- internal ---
    function _openEpoch(uint256 epochId) internal {
        currentEpoch = epochId;
        Epoch storage e = epochs[epochId];
        e.state = State.Open;
        e.encSum = Nox.toEuint256(0); // euint256 is not valid-zero by default (§6)
        Nox.allowThis(e.encSum);
    }

    /// @dev keccak over ordered active (recipient, dstHandle) pairs — binds the
    /// source batch to the destination pre-registrations (verified by the Distributor).
    function _claimsHash(Epoch storage e) internal view returns (bytes32) {
        bytes memory buf;
        uint256 n = e.entries.length;
        for (uint256 i; i < n; ++i) {
            Entry storage en = e.entries[i];
            if (en.withdrawn) continue;
            buf = abi.encodePacked(buf, en.recipient, en.dstHandle);
        }
        return keccak256(buf);
    }
}
