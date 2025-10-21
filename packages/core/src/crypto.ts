import { encodeUint32, decodeUint32, xorBytes, randomKeypair, createNamespacedKey, computeSharedSecret, namespacedHmac } from './utils';

export const NAMESPACE_DEPOSIT = 'LitGhost.deposit';
export const NAMESPACE_BALANCE = 'LitGhost.balance';

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
 * Validates a Telegram username according to TDLib rules:
 * - 1-32 characters
 * - Must start with a letter
 * - Can contain letters, digits, and underscores
 * - Cannot end with underscore
 * - Cannot have consecutive underscores
 *
 * See: https://github.com/tdlib/td/blob/369ee922b45bfa7e8da357e4d62e93925862d86d/td/telegram/misc.cpp#L260
 */
export function isValidTelegramUsername(username: string): boolean {
  if (username.length === 0 || username.length > 32) {
    return false;
  }
  // Must start with a letter
  if (!/^[a-zA-Z]/.test(username[0])) {
    return false;
  }
  // Cannot end with underscore
  if (username[username.length - 1] === '_') {
    return false;
  }
  // Check all characters are alphanumeric or underscore
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    return false;
  }
  // Check no consecutive underscores
  if (username.includes('__')) {
    return false;
  }
  return true;
}

/**
 * Blind a telegram username using XOR with hashed ECDH secret
 * Encrypts the plaintext username (zero-padded to 32 bytes) so the TEE can decrypt it
 * and know who received the deposit.
 *
 * The shared secret is derived from ECDH between an ephemeral key (used once per deposit)
 * and a long-term TEE public key, ensuring each blinded ID is unique.
 */
export function blindUserId(
  telegramId: string,
  sharedSecret: Uint8Array
): Uint8Array {
  // Validate telegram username format per TDLib rules
  if (!isValidTelegramUsername(telegramId)) {
    throw new Error('Invalid Telegram username format');
  }

  // Encode telegram ID to ASCII bytes (usernames are ASCII-only)
  const encoded = new TextEncoder().encode(telegramId);

  // Zero-pad to 32 bytes (right-padded with zeros)
  const usernameBytes = new Uint8Array(32);
  usernameBytes.set(encoded, 0);

  const blindingKey = createNamespacedKey(sharedSecret, NAMESPACE_DEPOSIT);
  return xorBytes(usernameBytes, blindingKey);
}

/**
 * Unblind a user ID (TEE side)
 * Reverses the blinding operation to recover the plaintext telegram username.
 * Note: XOR is symmetric, so unblinding uses the same operation as blinding.
 *
 * Strips trailing zero-byte padding before ASCII decoding.
 */
export function unblindUserId(
  blindedUserId: Uint8Array,
  sharedSecret: Uint8Array
): string {
  const blindingKey = createNamespacedKey(sharedSecret, NAMESPACE_DEPOSIT);
  const usernameBytes = xorBytes(blindedUserId, blindingKey);

  // Strip trailing null bytes before decoding
  let length = usernameBytes.length;
  while (length > 0 && usernameBytes[length - 1] === 0) {
    length--;
  }

  // Decode only the non-padded portion as ASCII
  const username = new TextDecoder('ascii').decode(usernameBytes.subarray(0, length));

  // Verify result is valid Telegram username format (defensive check)
  if (!isValidTelegramUsername(username)) {
    throw new Error('Decrypted username has invalid Telegram username format');
  }

  return username;
}

/**
 * Create a DepositTo structure for a deposit
 * User generates ephemeral keypair and blinds their telegram ID
 */
export function createDepositTo(
  telegramId: string,
  teePublicKey: Uint8Array
): { depositTo: DepositTo; ephemeralPrivateKey: Uint8Array } {
  const kp = randomKeypair();
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
 * TEE uses its long-term private key to recover the plaintext telegram username
 */
export function decryptDepositTo(
  depositTo: DepositTo,
  teeLongTermPrivateKey: Uint8Array
): string {
  const sharedSecret = computeSharedSecret(teeLongTermPrivateKey, depositTo.rand);
  return unblindUserId(depositTo.user, sharedSecret);
}

/**
 * Encrypt a single balance (uint32) for a specific user
 * @param balance - The balance to encrypt
 * @param sharedSecret - The shared secret between TEE and user
 * @param nonce - Nonce for additional entropy (required for security)
 */
export function encryptBalance(
  balance: number,
  sharedSecret: Uint8Array,
  nonce: number
): Uint8Array {
  const encryptionKey = namespacedHmac(sharedSecret, NAMESPACE_BALANCE, encodeUint32(nonce));
  return xorBytes(encodeUint32(balance), encryptionKey.slice(0, 4));
}

/**
 * Decrypt a single balance for a specific user
 * Note: XOR is symmetric, so decryption uses the same operation as encryption
 * @param encryptedBalance - The encrypted balance
 * @param sharedSecret - The shared secret between TEE and user
 * @param nonce - Nonce (must match the nonce used during encryption)
 */
export function decryptBalance(
  encryptedBalance: Uint8Array,
  sharedSecret: Uint8Array,
  nonce: number
): number {
  const decryptionKey = namespacedHmac(sharedSecret, NAMESPACE_BALANCE, encodeUint32(nonce));
  const xorMask = decryptionKey.slice(0, 4);
  const result = decodeUint32(xorBytes(encryptedBalance, xorMask));
  return result;
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
    return encryptBalance(balance, userSharedSecrets[i], nonce);
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
  return decryptBalance(leaf.encryptedBalances[position], userSharedSecret, leaf.nonce);
}

/**
 * Helper: Get user's leaf index and position from userIndex
 * Users are stored in leaves of 6 users each:
 *   - Leaf 0: users 0-5 (user 0 is sentinel, positions 1-5 are real users 1-5)
 *   - Leaf 1: users 6-11
 *   - Leaf N: users (N*6) to (N*6+5)
 */
export function getUserLeafInfo(userIndex: number): { leafIdx: number; position: number } {
  return {
    leafIdx: Math.floor(userIndex / 6),
    position: userIndex % 6
  };
}
