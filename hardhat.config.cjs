require("@nomicfoundation/hardhat-ethers");
require("dotenv").config();

const { DEPLOYER_PRIVATE_KEY, ETH_SEPOLIA_RPC_URL, ARB_SEPOLIA_RPC_URL } = process.env;
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.35", // Nox.sol pins ^0.8.35
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true, // chained() folds several ops — avoid stack-too-deep
    },
  },
  networks: {
    ethSepolia: { url: ETH_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com", accounts, chainId: 11155111 },
    arbSepolia: { url: ARB_SEPOLIA_RPC_URL || "https://arbitrum-sepolia-rpc.publicnode.com", accounts, chainId: 421614 },
  },
};
