// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @dev Minimal interface to Circle's official CCTP V2 MessageTransmitterV2
/// (unmodified deployment; signature verified 2026-07-12). G1: call, never modify.
interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
}
