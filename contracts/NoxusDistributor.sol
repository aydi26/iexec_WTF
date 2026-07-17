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

    /// @dev The Batcher's committed claim identifier (mirrors NoxusBatcher.ClaimId),
    /// decoded from hookData in deposit order.
    struct ClaimId {
        address recipient;
        bytes32 dstHandle;
    }

    struct Claim {
        address recipient;
        bytes32 dstHandle; // external handle bytes (matches the committed ClaimId)
        euint256 ingested; // fromExternal result (the pre-registered handle)
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
        bool hasMissing; // a committed claim had no matching pre-registration
        Claim[] claims; // resolved, in committed order (built at relayReceive)
    }

    // Pre-registrations, keyed by keccak256(abi.encode(recipient, dstHandle)).
    // Anyone may pre-register into an epoch, but relayReceive only ever references
    // the keys named by the source-authenticated committed list — injected extras
    // are never resolved and cannot brick the epoch (F-1/F-2).
    mapping(uint256 => mapping(bytes32 => euint256)) private preReg;
    mapping(uint256 => mapping(bytes32 => bool)) private registered;

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

    event PreRegistered(uint256 indexed epochId, address indexed recipient, bytes32 dstHandle);
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

    /// @dev One-shot wiring: first wire wins and is immutable after (the deploy
    /// script wires once right after deploy).
    function wirePeer(bytes32 _remoteBatcher) external {
        if (msg.sender != deployer) revert AlreadyWired(); // deployer-only: no front-run of the peer
        if (remoteBatcher != bytes32(0)) revert AlreadyWired(); // one-shot: immutable once set
        remoteBatcher = _remoteBatcher;
        emit PeerWired(_remoteBatcher);
    }

    /// @notice Depositor pre-registers their confidential destination claim, keyed
    /// by keccak256(recipient, dstHandle). MUST be the recipient's own tx: Nox binds
    /// the input to msg.sender (owner) and this contract (app), and we additionally
    /// require msg.sender == recipient (F-7). dstHandle/proof are created with
    /// app=this, owner=msg.sender on THIS chain.
    function preRegister(uint256 epochId, address recipient, externalEuint256 dstHandle, bytes calldata proof)
        external
    {
        if (msg.sender != recipient) revert NotRecipient();
        Epoch storage e = epochs[epochId];
        if (e.state != State.None && e.state != State.PreRegistering) revert BadState();
        bytes32 key = keccak256(abi.encode(recipient, externalEuint256.unwrap(dstHandle)));
        if (registered[epochId][key]) revert BadState();
        e.state = State.PreRegistering;
        euint256 ingested = Nox.fromExternal(dstHandle, proof);
        Nox.allowThis(ingested);
        Nox.allow(ingested, recipient);
        preReg[epochId][key] = ingested;
        registered[epochId][key] = true;
        emit PreRegistered(epochId, recipient, externalEuint256.unwrap(dstHandle));
    }

    /// @notice Relay the CCTP message: mint A here, then resolve exactly the
    /// source-authenticated committed claim list (in order) against our
    /// pre-registrations. destinationCaller = this contract (D-011). A committed
    /// claim with no matching pre-registration flags hasMissing (the epoch then
    /// cannot distribute — see declareFallback); injected extras (keys not on the
    /// committed list) are simply never referenced (F-1/F-2).
    function relayReceive(bytes calldata message, bytes calldata attestation) external {
        require(message.length >= 376, "short msg"); // guard fixed-offset field reads
        require(transmitter.receiveMessage(message, attestation), "receiveMessage failed");
        if (message.sourceDomain() != srcDomain) revert BadOrigin();
        if (message.bodyMessageSender() != remoteBatcher) revert BadOrigin();
        if (message.bodyMintRecipient() != bytes32(uint256(uint160(address(this))))) revert BadOrigin();

        (uint256 epochId, ClaimId[] memory committed) = abi.decode(message.hookData(), (uint256, ClaimId[]));
        Epoch storage e = epochs[epochId];
        // Allow None too: if nobody pre-registered, the mint still lands (all claims
        // resolve as missing -> hasMissing) and the epoch can go to fallback/refund,
        // so the aggregate is never stranded in the CCTP message.
        if (e.state != State.None && e.state != State.PreRegistering) revert BadState();

        uint256 n = committed.length;
        for (uint256 i; i < n; ++i) {
            bytes32 key = keccak256(abi.encode(committed[i].recipient, committed[i].dstHandle));
            if (registered[epochId][key]) {
                e.claims.push(
                    Claim(committed[i].recipient, committed[i].dstHandle, preReg[epochId][key], false, 0)
                );
            } else {
                e.hasMissing = true;
            }
        }

        e.aggregate = message.amount();
        e.feeExecuted = message.feeExecuted();
        e.receivedAt = uint64(block.timestamp);
        e.state = State.Received;
        emit EpochReceived(epochId, e.aggregate);
    }

    /// @notice A committed pre-registration went missing (a plaintext fact needing
    /// no reveal): allow anyone to move the epoch straight to fallback so source
    /// depositors get refunded. Callable while Received && hasMissing.
    function declareFallback(uint256 epochId) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.Received || !e.hasMissing) revert BadState();
        _enterFallback(epochId, e);
    }

    /// @notice Integrity check: reveal whether Σ pre-registered claims == A.
    /// Overflow-safe fold (safeAdd + okCount) so wrap-to-A collusion cannot pass.
    function checkEpoch(uint256 epochId) external {
        Epoch storage e = epochs[epochId];
        if (e.state != State.Received) revert BadState();
        // A hasMissing / empty-claim epoch cannot distribute — it must go to
        // fallback via declareFallback (or forceFallback on timeout), never here.
        if (e.hasMissing || e.claims.length == 0) revert BadState();
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
            // Fee-buffer exhaustion is observable (bufferShortfall) and non-permanent:
            // if BufferShort reverts, anyone can transfer USDC to top the contract up
            // and retry; and forceFallback rescues after fallbackTimeout (reachable
            // from CheckPending), so a short buffer never strands the epoch (F-4).
            if (usdc.balanceOf(address(this)) < e.aggregate) revert BufferShort();
            e.state = State.Distributed; // CEI: state transition before external calls
            usdc.approve(address(wrapper), e.aggregate);
            wrapper.wrap(address(this), e.aggregate);
            uint256 n = e.claims.length;
            for (uint256 i; i < n; ++i) {
                // grant the token transient access to compute with this handle; the
                // recipient's ACL on their new balance is granted by the token's _update.
                Nox.allowTransient(e.claims[i].ingested, address(wrapper));
                cusdc.confidentialTransfer(e.claims[i].recipient, e.claims[i].ingested);
            }
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
        if (e.state != State.FallbackAttribution && e.state != State.RefundInitiated) revert BadState();
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
        returns (State state, uint256 aggregate, uint256 feeExecuted, uint256 claimCount, bool hasMissing)
    {
        Epoch storage e = epochs[epochId];
        return (e.state, e.aggregate, e.feeExecuted, e.claims.length, e.hasMissing);
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

    /// @notice Observable fee-buffer gap (F-4): how much USDC the contract is short
    /// of the aggregate. If > 0, finalizeEpoch reverts BufferShort — anyone may
    /// transfer USDC here to top up, or forceFallback rescues after the timeout.
    function bufferShortfall(uint256 epochId) external view returns (uint256) {
        uint256 aggregate = epochs[epochId].aggregate;
        uint256 bal = usdc.balanceOf(address(this));
        return aggregate > bal ? aggregate - bal : 0;
    }
}
