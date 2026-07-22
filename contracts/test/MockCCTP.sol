// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @title MockTransmitter — TEST-ONLY MessageTransmitterV2 stand-in.
/// @notice receiveMessage returns a settable boolean (default true) and records
/// the last message so tests can assert what was relayed.
contract MockTransmitter {
    bool public ret = true;
    uint256 public calls;
    bytes public lastMessage;

    function setReturn(bool v) external {
        ret = v;
    }

    function receiveMessage(bytes calldata message, bytes calldata) external returns (bool) {
        calls += 1;
        lastMessage = message;
        return ret;
    }
}

/// @title MockTokenMessenger — TEST-ONLY TokenMessengerV2 stand-in.
/// @notice depositForBurnWithHook is a recording no-op (no token pull).
contract MockTokenMessenger {
    uint256 public calls;
    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    address public lastBurnToken;
    bytes32 public lastDestinationCaller;
    uint256 public lastMaxFee;
    uint32 public lastMinFinalityThreshold;
    bytes public lastHookData;

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        calls += 1;
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        lastDestinationCaller = destinationCaller;
        lastMaxFee = maxFee;
        lastMinFinalityThreshold = minFinalityThreshold;
        lastHookData = hookData;
    }
}
