// ============================================================================
// Nox handle SDK bridge
// ----------------------------------------------------------------------------
// Thin wrapper around @iexec-nox/handle. The SDK auto-resolves network config
// by chainId (11155111 ETH Sepolia, 421614 Arb Sepolia) from the wallet client,
// so we just hand it the connected viem WalletClient.
//
// Client surface used by Manifold views:
//   encryptInput(value: bigint, 'uint256', appContractAddress) -> { handle, handleProof }
//   decrypt(handle)        -> { value, solidityType }
//   publicDecrypt(handle)  -> { value, solidityType, decryptionProof }
//   viewACL(handle)        -> { isPublic, admins, viewers }
// ============================================================================

import { createViemHandleClient } from "@iexec-nox/handle";

// Cache the client per (chainId + account) so we don't re-create it on every call.
let _cache = { key: null, client: null };

/**
 * Get (or lazily create) a Nox HandleClient bound to the given viem WalletClient.
 * @param {import('viem').WalletClient} walletClient - from wagmi useWalletClient()
 */
export async function getHandleClient(walletClient) {
  if (!walletClient) throw new Error("Wallet not connected");
  const account =
    walletClient.account?.address || walletClient.account || "unknown";
  const chainId = walletClient.chain?.id ?? "unknown";
  const key = `${chainId}:${account}`;

  if (_cache.key === key && _cache.client) return _cache.client;

  const client = await createViemHandleClient(walletClient);
  _cache = { key, client };
  return client;
}

/** Encrypt a USDC amount (bigint, 6-decimals wei) for a target app contract. */
export async function encryptAmount(walletClient, amountWei, appContractAddress) {
  const client = await getHandleClient(walletClient);
  return client.encryptInput(amountWei, "uint256", appContractAddress);
}

/** Client-side decrypt a handle you're allowed to view -> bigint value. */
export async function decryptHandle(walletClient, handle) {
  const client = await getHandleClient(walletClient);
  const { value } = await client.decrypt(handle);
  return value;
}

/** Public-decrypt a handle -> { value, decryptionProof }. */
export async function publicDecryptHandle(walletClient, handle) {
  const client = await getHandleClient(walletClient);
  return client.publicDecrypt(handle);
}

/** Inspect a handle's ACL -> { isPublic, admins, viewers }. */
export async function viewHandleACL(walletClient, handle) {
  const client = await getHandleClient(walletClient);
  return client.viewACL(handle);
}
