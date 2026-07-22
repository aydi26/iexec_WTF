// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {CCTPMessageParser} from "../lib/CCTPMessageParser.sol";

/// @title CCTPParserHarness — TEST-ONLY exposure of the internal library so the
/// fixed-offset field extraction can be unit-tested from crafted message blobs.
contract CCTPParserHarness {
    using CCTPMessageParser for bytes;

    function sourceDomain(bytes calldata m) external pure returns (uint32) {
        return m.sourceDomain();
    }

    function bodyMessageSender(bytes calldata m) external pure returns (bytes32) {
        return m.bodyMessageSender();
    }

    function bodyMintRecipient(bytes calldata m) external pure returns (bytes32) {
        return m.bodyMintRecipient();
    }

    function amount(bytes calldata m) external pure returns (uint256) {
        return m.amount();
    }

    function feeExecuted(bytes calldata m) external pure returns (uint256) {
        return m.feeExecuted();
    }

    function hookData(bytes calldata m) external pure returns (bytes memory) {
        return m.hookData();
    }
}
