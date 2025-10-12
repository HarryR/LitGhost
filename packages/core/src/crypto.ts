import { keccak256 } from '@ethersproject/keccak256';
import { arrayify, concat } from '@ethersproject/bytes';
import { encodeUint32, decodeUint32, xorBytes, randomKeypair, createNamespacedKey, computeSharedSecret } from './utils';

const NAMESPACE_DEPOSIT = 'dorp.deposit';
const NAMESPACE_BALANCE = 'dorp.balance';

/**
 * Types
 */
export interface DepositTo {
  rand: Uint8Array;  // 32 bytes - ephemeral public key
  user: Uint8Array;  // 32 bytes - blinded user ID
}

export interface Leaf {
  encryptedBalances: Uint8Array[];  // 6x 4-byte encrypted balances
  idx: number;
  nonce: number;
}

/**
 * Blind a user ID using XOR with hashed ECDH secret
 * Used for deposits to hide the real user ID
 */
export function blindUserId(
  telegramId: string,
  sharedSecret: Uint8Array
): Uint8Array {
  const userIdHash = arrayify(keccak256(Buffer.from(telegramId, 'utf8')));
  const blindingKey = createNamespacedKey(sharedSecret, NAMESPACE_DEPOSIT);
  return xorBytes(userIdHash, blindingKey);
}

/**
 * Unblind a user ID (TEE side)
 * Reverses the blinding operation to recover the original telegram ID hash
 * Note: XOR is symmetric, so unblinding uses the same operation as blinding
 */
export function unblindUserId(
  blindedUserId: Uint8Array,
  sharedSecret: Uint8Array
): Uint8Array {
  const blindingKey = createNamespacedKey(sharedSecret, NAMESPACE_DEPOSIT);
  return xorBytes(blindedUserId, blindingKey);
}

/**
 * Create a DepositTo structure for a deposit
 * User generates ephemeral keypair and blinds their telegram ID
 */
export async function createDepositTo(
  telegramId: string,
  teePublicKey: Uint8Array
): Promise<{ depositTo: DepositTo; ephemeralPrivateKey: Uint8Array }> {
  const kp = await randomKeypair();
  const sharedSecret = computeSharedSecret(kp.privateKey, teePublicKey);
  const blindedUserId = blindUserId(telegramId, sharedSecret);
  return {
    depositTo: {
      rand: kp.publicKey,
      user: blindedUserId
    },
    ephemeralPrivateKey: kp.privateKey
  };
}

/**
 * Decrypt a DepositTo (TEE side)
 * TEE uses its long-term private key to recover the telegram ID
 */
export function decryptDepositTo(
  depositTo: DepositTo,
  teeLongTermPrivateKey: Uint8Array
): Uint8Array {
  const sharedSecret = computeSharedSecret(teeLongTermPrivateKey, depositTo.rand);
  return unblindUserId(depositTo.user, sharedSecret);
}

/**
 * Encrypt a single balance (uint32) for a specific user
 */
export function encryptBalance(
  balance: number,
  sharedSecret: Uint8Array
): Uint8Array {
  const balanceBytes = encodeUint32(balance);
  const encryptionKey = createNamespacedKey(sharedSecret, NAMESPACE_BALANCE);
  return xorBytes(balanceBytes, encryptionKey.slice(0, 4));
}

/**
 * Decrypt a single balance for a specific user
 * Note: XOR is symmetric, so decryption uses the same operation as encryption
 */
export function decryptBalance(
  encryptedBalance: Uint8Array,
  sharedSecret: Uint8Array
): number {
  const decryptionKey = createNamespacedKey(sharedSecret, NAMESPACE_BALANCE);
  const balanceBytes = xorBytes(encryptedBalance, decryptionKey.slice(0, 4));
  return decodeUint32(balanceBytes);
}

/**
 * Derive a secret with nonce for leaf encryption
 */
function deriveSecretWithNonce(sharedSecret: Uint8Array, nonce: number): Uint8Array {
  const nonceBytes = encodeUint32(nonce);
  return arrayify(keccak256(concat([sharedSecret, nonceBytes])));
}

/**
 * Encrypt all 6 balances in a leaf
 * Each balance is encrypted with the corresponding user's shared secret
 */
export function encryptLeaf(
  balances: number[],
  userSharedSecrets: Uint8Array[],
  nonce: number
): Uint8Array[] {
  if (balances.length !== 6 || userSharedSecrets.length !== 6) {
    throw new Error('Leaf must contain exactly 6 balances and 6 shared secrets');
  }
  return balances.map((balance, i) => {
    const secretWithNonce = deriveSecretWithNonce(userSharedSecrets[i], nonce);
    return encryptBalance(balance, secretWithNonce);
  });
}

/**
 * Decrypt a single user's balance from a leaf
 */
export function decryptLeafBalance(
  leaf: Leaf,
  position: number,
  userSharedSecret: Uint8Array
): number {
  if (position < 0 || position >= 6) {
    throw new Error('Position must be between 0 and 5');
  }
  const secretWithNonce = deriveSecretWithNonce(userSharedSecret, leaf.nonce);
  return decryptBalance(leaf.encryptedBalances[position], secretWithNonce);
}

/**
 * Helper: Get user's leaf index and position from userIndex
 */
export function getUserLeafInfo(userIndex: number): { leafIdx: number; position: number } {
  return {
    leafIdx: Math.floor(userIndex / 6),
    position: userIndex % 6
  };
}
