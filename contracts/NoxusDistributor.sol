// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Nox, euint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import "encrypted-types/EncryptedTypes.sol";
import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {IERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC20ToERC7984Wrapper.sol";
import {IMessageTransmitterV2} from "./interfaces/IMessageTransmitterV2.sol";
import {ITokenMessengerV2} from "./interfaces/ITokenMessengerV2.sol";
import {CCTPMessageParser} from "./lib/CCTPMessageParser.sol";

/// @title NoxusDistributor (Arb Sepolia destination leg) — docs/PLAN.md §3.2.
/// @notice Depositors pre-register their confidential destination claim directly
/// (D-006 = option B, owner-binding). On CCTP mint, the aggregate A arrives; an
/// on-chain TEE-verified integrity check (Σ claims == A) gates confidential
/// distribution. On failure: opt-in attribution reveal + refund-to-source.
contract NoxusDistributor {
    using CCTPMessageParser for bytes;

    enum State { None, PreRegistering, Received, CheckPending, Distributed, FallbackAttribution, RefundInitiated }

    struct Claim {
        address recipient;
        bytes32 dstHandle; // external handle bytes (for claimsHash binding)
        euint256 ingested; // fromExternal result
        bool revealed; // PRIVACY FALLBACK — plaintext by design
        uint256 revealedAmount; // PRIVACY FALLBACK — plaintext by design
    }

    struct Epoch {
        State state;
        uint256 aggregate; // public A
        uint256 feeExecuted;
        euint256 checkNum; // 1 = integrity ok
        uint64 receivedAt;
        uint64 checkRequestedAt;
        Claim[] claims;
    }

    IERC20 public immutable usdc;
    IERC7984 public immutable cusdc;
    IERC20ToERC7984Wrapper public immutable wrapper;
    IMessageTransmitterV2 public immutable transmitter;
    ITokenMessengerV2 public immutable tokenMessenger;
    uint32 public immutable srcDomain; // Ethereum = 0
    uint32 public immutable refundDstDomain; // back to Ethereum = 0
    uint64 public immutable fallbackTimeout;
    address public immutable deployer;

    bytes32 public remoteBatcher; // set once via wirePeer
    uint32 private constant FAST_THRESHOLD = 1000;

    mapping(uint256 => Epoch) private epochs;

    event PreRegistered(uint256 indexed epochId, address indexed recipient, uint256 index);
    event EpochReceived(uint256 indexed epochId, uint256 aggregate);
    event CheckRequested(uint256 indexed epochId);
    event EpochDistributed(uint256 indexed epochId);
    event EpochFallback(uint256 indexed epochId);
    event ClaimRevealRequested(uint256 indexed epochId, uint256 index);
    // PRIVACY FALLBACK — plaintext by design (the only per-claim amount that ever appears)
    event FallbackClaimRevealed(uint256 indexed epochId, uint256 index, address recipient, uint256 amount);
    event RefundInitiated(uint256 indexed epochId, uint256 aggregate);
    event PeerWired(bytes32 remoteBatcher);

    error BadState();
    error NotRecipient();
    error CountMismatch();
    error ClaimsHashMismatch();
    error BadOrigin();
    error MaxFeeTooHigh();
    error BufferShort();
    error NotTimedOut();
    error AlreadyWired();

    constructor(
        IERC20 _usdc,
        address _cusdc,
        IMessageTransmitterV2 _transmitter,
        ITokenMessengerV2 _tokenMessenger,
        uint32 _srcDomain,
        uint64 _fallbackTimeout
    ) {
        usdc = _usdc;
        cusdc = IERC7984(_cusdc);
        wrapper = IERC20ToERC7984Wrapper(_cusdc);
        transmitter = _transmitter;
        tokenMessenger = _tokenMessenger;
        srcDomain = _srcDomain;
        refundDstDomain = _srcDomain; // refund goes back to the source domain
        fallbackTimeout = _fallbackTimeout;
        deployer = msg.sender;
    }

    function wirePeer(bytes32 _remoteBatcher) external {
        if (msg.sender != deployer) revert AlreadyWired(); // deployer-only config; re-settable
        remoteBatcher = _remoteBatcher;
        emit PeerWired(_remoteBatcher);
    }

    /// @notice Depositor pre-registers their confidential destination claim.
    /// MUST be the depositor's own tx: Nox binds the input to msg.sender (owner)
    /// and this contract (app). dstHandle/proof are created with app=this,
    /// owner=msg.sender on THIS chain.
    function preRegister(uint256 epochId, address recipient, externalEuint256 dstHandle, bytes calldata proof)
        external
    {
        Epoch storage e = epochs[epochId];
        if (e.state != State.None && e.state != State.PreRegistering) revert BadState();
        e.state = State.PreRegistering;
        euint256 ingested = Nox.fromExternal(dstHandle, proof);
        Nox.allowThis(ingested);
        Nox.allow(ingested, recipient);
        e.claims.push(Claim(recipient, externalEuint256.unwrap(dstHandle), ingested, false, 0));
        emit PreRegistered(epochId, recipient, e.claims.length - 1);
    }

    /// @notice Relay the CCTP message: mint A here, then bind it to the pre-registered
    /// claim set via (count, claimsHash). destinationCaller = this contract (D-011).
    function relayReceive(bytes calldata message, bytes calldata attestation) external {
        require(transmitter.receiveMessage(message, attestation), "receiveMessage failed");
        if (message.sourceDomain() != srcDomain) revert BadOrigin();
        if (message.bodyMessageSender() != remoteBatcher) revert BadOrigin();
        if (message.bodyMintRecipient() != bytes32(uint256(uint160(address(this))))) revert BadOrigin();

        (uint256 epochId, uint256 count, bytes32 claimsHash) =
            abi.decode(message.hookData(), (uint256, uint256, bytes32));
        Epoch storage e = epochs[epochId];
        if (e.state != State.PreRegistering) revert BadState();
        if (e.claims.length != count) revert CountMismatch();
        if (_claimsHash(e) != claimsHash) revert ClaimsHashMismatch();

        e.aggregate = message.amount();
        e.feeExecuted = message.feeExecuted();
        e.receivedAt = uint64(block.timestamp);
        e.state = State.Received;
        emit EpochReceived(epochId, e.aggregate);
    }

    /// @notice Integrity check: reveal whether Σ pre-registered claims == A.
    /// Overflow-safe fold (safeAdd + okCount) so wrap-to-A collusion cannot pass.
    function checkEpoch(uint256 epochId) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.Received) revert BadState();
        uint256 n = e.claims.length;

        euint256 total = Nox.toEuint256(0);
        euint256 okCount = Nox.toEuint256(0);
        for (uint256 i; i < n; ++i) {
            (ebool ok, euint256 t) = Nox.safeAdd(total, e.claims[i].ingested);
            total = t;
            okCount = Nox.add(okCount, Nox.select(ok, Nox.toEuint256(1), Nox.toEuint256(0)));
        }
        ebool sumOk = Nox.eq(total, Nox.toEuint256(e.aggregate));
        ebool allOk = Nox.eq(okCount, Nox.toEuint256(n));
        euint256 checkNum = Nox.select(
            allOk, Nox.select(sumOk, Nox.toEuint256(1), Nox.toEuint256(0)), Nox.toEuint256(0)
        );
        e.checkNum = checkNum;
        Nox.allowThis(checkNum);
        Nox.allowPublicDecryption(checkNum); // SITE 2 — integrity result
        e.checkRequestedAt = uint64(block.timestamp);
        e.state = State.CheckPending;
        emit CheckRequested(epochId);
    }

    /// @notice Finalize: on check==1 wrap A and distribute confidentially; else fallback.
    function finalizeEpoch(uint256 epochId, bytes calldata proof) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.CheckPending) revert BadState();
        uint256 v = Nox.publicDecrypt(e.checkNum, proof);
        if (v == 1) {
            if (usdc.balanceOf(address(this)) < e.aggregate) revert BufferShort();
            usdc.approve(address(wrapper), e.aggregate);
            wrapper.wrap(address(this), e.aggregate);
            uint256 n = e.claims.length;
            for (uint256 i; i < n; ++i) {
                // grant the token transient access to compute with this handle; the
                // recipient's ACL on their new balance is granted by the token's _update.
                Nox.allowTransient(e.claims[i].ingested, address(wrapper));
                cusdc.confidentialTransfer(e.claims[i].recipient, e.claims[i].ingested);
            }
            e.state = State.Distributed;
            emit EpochDistributed(epochId);
        } else {
            _enterFallback(epochId, e);
        }
    }

    /// @notice Timeout hatch: if the KMS proof never arrives (or ingestion stalls),
    /// anyone can force the epoch into fallback after fallbackTimeout. Refund needs
    /// zero Nox availability to move funds.
    function forceFallback(uint256 epochId) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.Received && e.state != State.CheckPending) revert BadState();
        uint64 anchor = e.checkRequestedAt > e.receivedAt ? e.checkRequestedAt : e.receivedAt;
        if (block.timestamp <= anchor + fallbackTimeout) revert NotTimedOut();
        _enterFallback(epochId, e);
    }

    function _enterFallback(uint256 epochId, Epoch storage e) internal {
        e.state = State.FallbackAttribution;
        emit EpochFallback(epochId);
    }

    /// @notice Opt-in self-exculpation: a recipient reveals their OWN claim. The
    /// cheater's refusal to reveal is itself the attribution signal. Honest amounts
    /// stay private unless their holder chooses to reveal (D-010).
    function requestClaimReveal(uint256 epochId, uint256 index) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.FallbackAttribution) revert BadState();
        Claim storage c = e.claims[index];
        if (c.recipient != msg.sender) revert NotRecipient();
        Nox.allowPublicDecryption(c.ingested); // SITE 3 — PRIVACY FALLBACK — plaintext by design
        emit ClaimRevealRequested(epochId, index);
    }

    /// PRIVACY FALLBACK — plaintext by design. Informational only; gates nothing.
    function resolveClaim(uint256 epochId, uint256 index, bytes calldata proof) external {
        Epoch storage e = epochs[epochId];
        Claim storage c = e.claims[index];
        uint256 v = Nox.publicDecrypt(c.ingested, proof);
        c.revealed = true;
        c.revealedAmount = v;
        emit FallbackClaimRevealed(epochId, index, c.recipient, v);
    }

    /// @notice Bridge A back to the Batcher for confidential refund-to-source.
    function initiateRefund(uint256 epochId, uint256 maxFee) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.FallbackAttribution) revert BadState();
        if (maxFee > e.aggregate / 100) revert MaxFeeTooHigh();
        usdc.approve(address(tokenMessenger), e.aggregate);
        tokenMessenger.depositForBurnWithHook(
            e.aggregate, refundDstDomain, remoteBatcher, address(usdc), remoteBatcher, maxFee, FAST_THRESHOLD,
            abi.encode(epochId)
        );
        e.state = State.RefundInitiated;
        emit RefundInitiated(epochId, e.aggregate);
    }

    // --- views ---
    function epochInfo(uint256 epochId)
        external
        view
        returns (State state, uint256 aggregate, uint256 feeExecuted, uint256 claimCount)
    {
        Epoch storage e = epochs[epochId];
        return (e.state, e.aggregate, e.feeExecuted, e.claims.length);
    }

    function checkHandle(uint256 epochId) external view returns (euint256) {
        return epochs[epochId].checkNum;
    }

    function claimAt(uint256 epochId, uint256 index)
        external
        view
        returns (address recipient, bytes32 dstHandle, euint256 ingested, bool revealed, uint256 revealedAmount)
    {
        Claim storage c = epochs[epochId].claims[index];
        return (c.recipient, c.dstHandle, c.ingested, c.revealed, c.revealedAmount);
    }

    function claimsHashOf(uint256 epochId) external view returns (bytes32) {
        return _claimsHash(epochs[epochId]);
    }

    function _claimsHash(Epoch storage e) internal view returns (bytes32) {
        bytes memory buf;
        uint256 n = e.claims.length;
        for (uint256 i; i < n; ++i) {
            buf = abi.encodePacked(buf, e.claims[i].recipient, e.claims[i].dstHandle);
        }
        return keccak256(buf);
    }
}
