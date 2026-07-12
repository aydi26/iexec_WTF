// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @title CCTPMessageParser - reads fields from a CCTP V2 message by fixed offset.
/// @notice Offsets verified 2026-07-12 against circlefin/evm-cctp-contracts master
/// (MessageV2.sol + BurnMessageV2.sol) and the Circle docs table.
/// Outer MessageV2 header = 148 bytes: version[0], sourceDomain[4], destinationDomain[8],
/// nonce[12] (bytes32), sender[44], recipient[76], destinationCaller[108],
/// minFinalityThreshold[140], finalityThresholdExecuted[144], messageBody[148].
/// BurnMessageV2 body (absolute = 148 + field): version[148], burnToken[152],
/// mintRecipient[184], amount[216], messageSender[248], maxFee[280], feeExecuted[312],
/// expirationBlock[344], hookData[376].
library CCTPMessageParser {
    function sourceDomain(bytes calldata m) internal pure returns (uint32) {
        return uint32(bytes4(m[4:8]));
    }

    /// @dev The source-side burner (our Batcher/Distributor peer), from the burn body.
    function bodyMessageSender(bytes calldata m) internal pure returns (bytes32) {
        return bytes32(m[248:280]);
    }

    /// @dev The mint recipient (must be our destination contract), from the burn body.
    function bodyMintRecipient(bytes calldata m) internal pure returns (bytes32) {
        return bytes32(m[184:216]);
    }

    function amount(bytes calldata m) internal pure returns (uint256) {
        return uint256(bytes32(m[216:248]));
    }

    function feeExecuted(bytes calldata m) internal pure returns (uint256) {
        return uint256(bytes32(m[312:344]));
    }

    function hookData(bytes calldata m) internal pure returns (bytes calldata) {
        return m[376:];
    }
}
