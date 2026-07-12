// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @dev Minimal interface to Circle's official CCTP V2 TokenMessengerV2
/// (unmodified deployment; vendored signature from circlefin/evm-cctp-contracts
/// master, verified 2026-07-12). G1: we call, never modify.
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;
}
