// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @title NoxComputeStub — TEST-ONLY deterministic NoxCompute stand-in.
/// @notice Injected via `hardhat_setCode` at the pinned address the Nox SDK
/// library resolves for chainid 31337 (0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685).
/// Every compute op returns fresh pseudo-handles (keccak of a monotonic nonce);
/// every ACL/proof check accepts anything. The contracts under test never branch
/// on encrypted VALUES, only on handle plumbing, so this is sufficient for L1
/// state-machine/guard tests. `validateDecryptionProof` echoes the proof bytes,
/// so tests encode the desired plaintext as a 32-byte "proof".
/// @dev Signatures mirror INoxCompute; TEEType enum params are declared uint8
/// (identical ABI selector) to keep the stub dependency-free.
contract NoxComputeStub {
    uint256 private nonce;

    function _fresh() internal returns (bytes32) {
        return keccak256(abi.encodePacked("nox-stub-handle", ++nonce));
    }

    // ============ Compute ops → fresh pseudo-handles ============
    function wrapAsPublicHandle(bytes32, uint8) external returns (bytes32) {
        return _fresh();
    }

    function add(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function sub(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function mul(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function div(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function safeAdd(bytes32, bytes32) external returns (bytes32, bytes32) {
        return (_fresh(), _fresh());
    }

    function safeSub(bytes32, bytes32) external returns (bytes32, bytes32) {
        return (_fresh(), _fresh());
    }

    function safeMul(bytes32, bytes32) external returns (bytes32, bytes32) {
        return (_fresh(), _fresh());
    }

    function safeDiv(bytes32, bytes32) external returns (bytes32, bytes32) {
        return (_fresh(), _fresh());
    }

    function select(bytes32, bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function eq(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function ne(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function lt(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function le(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function gt(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function ge(bytes32, bytes32) external returns (bytes32) {
        return _fresh();
    }

    function transfer(bytes32, bytes32, bytes32) external returns (bytes32, bytes32, bytes32) {
        return (_fresh(), _fresh(), _fresh());
    }

    function mint(bytes32, bytes32, bytes32) external returns (bytes32, bytes32, bytes32) {
        return (_fresh(), _fresh(), _fresh());
    }

    function burn(bytes32, bytes32, bytes32) external returns (bytes32, bytes32, bytes32) {
        return (_fresh(), _fresh(), _fresh());
    }

    // ============ Proofs ============
    function validateInputProof(bytes32, address, bytes calldata, uint8) external {}

    /// @dev Echo the proof bytes: tests pass abi.encode(plaintext) (32 bytes) as
    /// the "decryption proof" and Nox.publicDecrypt returns that plaintext.
    function validateDecryptionProof(bytes32, bytes calldata proof) external pure returns (bytes memory) {
        return proof;
    }

    // ============ ACL: accept everything, record nothing ============
    function allow(bytes32, address) external {}

    function allowTransient(bytes32, address) external {}

    function disallowTransient(bytes32, address) external {}

    function isAllowed(bytes32, address) external pure returns (bool) {
        return true;
    }

    function validateAllowedForAll(address, bytes32[] calldata) external pure {}

    function addViewer(bytes32, address) external {}

    function isViewer(bytes32, address) external pure returns (bool) {
        return true;
    }

    function allowPublicDecryption(bytes32) external {}

    function isPubliclyDecryptable(bytes32) external pure returns (bool) {
        return true;
    }
}
