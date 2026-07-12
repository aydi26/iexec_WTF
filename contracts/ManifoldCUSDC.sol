// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";

/// @title ManifoldCUSDC — deployable confidential-USDC wrapper for Manifold.
/// @notice Thin concrete subclass of iExec's official (unmodified) optimized
/// ERC20->ERC7984 wrapper. One instance per chain, wrapping testnet USDC.
/// We add no logic — G1 forbids modifying the wrapper; deploying an instance
/// of the official abstract contract is its intended use.
contract ManifoldCUSDC is ERC20ToERC7984Wrapper {
    constructor(IERC20 usdc)
        ERC20ToERC7984Wrapper("Manifold Confidential USDC", "cUSDC", "", usdc)
    {}
}
