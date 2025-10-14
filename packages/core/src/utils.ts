import {
  defaultAbiCoder, arrayify, concat, SigningKey,
  randomBytes, hexlify, computeHmac, SupportedAlgorithm
} from './ethers-compat.js';

/**
 * Generate a random secp256k1 keypair with even y-coordinate
 * This allows us to use 32-byte public keys (x-coordinate only)
 * by enforcing a convention that all keys have even y (0x02 prefix)
 */
export function randomKeypair() {
  while (true) {
    const privateKeyBytes = randomBytes(32);
    const signingKey = new SigningKey(privateKeyBytes);
    const compressed = signingKey.compressedPublicKey; // "0x02..." or "0x03..."

    if (compressed.startsWith('0x02')) {
      // Even y-coordinate - return x-coordinate only (32 bytes)
      return {
        privateKey: privateKeyBytes,
        publicKey: arrayify('0x' + compressed.slice(4)) // Remove "0x02" prefix
      };
    }
    // Odd y-coordinate, try again
  }
}

const SECP256K1_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');

export function isSecp256k1Scalar(hexValue: string): boolean {  
  const valueBigInt = BigInt(hexValue);
  // Must be in range [1, n)
  return valueBigInt > 0n && valueBigInt < SECP256K1_N;
}

/**
 * Derive a deterministic secp256k1 keypair with even y-coordinate
 * Used by the manager to derive user long-term keys from a master key
 *
 * @param seed - Base seed material (e.g., telegram username)
 * @param masterKey - Master secret key for derivation
 * @returns Keypair with 32-byte private key and 32-byte public key (x-coordinate only)
 */
export function deriveUserKeypair(
  seed: string,
  masterKey: Uint8Array
): { privateKey: Uint8Array; publicKey: Uint8Array } {
  let counter = 0;
  const seedBytes = Buffer.from(seed, 'utf8');

  while (true) {
    const material = concat([
      seedBytes,
      encodeUint32(counter)
    ]);
    const candidateSK_hex = computeHmac(SupportedAlgorithm.sha256, masterKey, material)
    if( isSecp256k1Scalar(candidateSK_hex) )
    {
      const candidateSK_bytes = arrayify(candidateSK_hex);
      const signingKey = new SigningKey(candidateSK_bytes);
      const compressed = signingKey.compressedPublicKey;
      if (compressed.startsWith('0x02')) {
        // Even y-coordinate - return x-coordinate only (32 bytes)
        return {
          privateKey: candidateSK_bytes,
          publicKey: arrayify('0x' + compressed.slice(4))
        };
      }
    }
    // Odd y-coordinate, increment counter and try again
    counter++;
  }
}

/**
 * Reconstruct a compressed public key from a 32-byte x-coordinate
 * Assumes even y-coordinate (0x02 prefix) per our convention
 */
export function reconstructCompressedPublicKey(xCoordinate: Uint8Array): string {
  if (xCoordinate.length !== 32) {
    throw new Error('Expected 32-byte x-coordinate');
  }
  return '0x02' + hexlify(xCoordinate).slice(2);
}

/**
 * Compute ECDH shared secret using secp256k1
 * Takes private key and 32-byte public key (x-coordinate only)
 */
export function computeSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  const signingKey = new SigningKey(privateKey);
  const compressedPublicKey = reconstructCompressedPublicKey(publicKey);
  const sharedSecretHex = signingKey.computeSharedSecret(compressedPublicKey);
  return arrayify(sharedSecretHex);
}

/**
 * Encode a number to uint32 bytes using ABI encoding, then extract the 4 bytes
 */
export function encodeUint32(value: number): Uint8Array {
  const encoded = arrayify(defaultAbiCoder.encode(['uint32'], [value]));
  // ABI encoding pads to 32 bytes, we want the last 4
  return encoded.slice(-4);
}

/**
 * Encode a number to uint256 bytes (32 bytes)
 */
export function encodeUint256(value: number | bigint): Uint8Array {
  return arrayify(defaultAbiCoder.encode(['uint256'], [value]));
}

/**
 * Decode uint32 from 4 bytes
 */
export function decodeUint32(bytes: Uint8Array): number {
  if (bytes.length !== 4) {
    throw new Error('Expected 4 bytes for uint32');
  }
  // Pad to 32 bytes for ABI decoding
  const padded = new Uint8Array(32);
  padded.set(bytes, 28); // Set at offset 28 (32-4)
  return defaultAbiCoder.decode(['uint32'], padded)[0];
}

/**
 * XOR two byte arrays of the same length
 */
export function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== b.length) {
    throw new Error('Arrays must have the same length for XOR');
  }
  const result = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    result[i] = a[i] ^ b[i];
  }
  return result;
}

/**
 * Create a namespaced encryption key from a shared secret
 */
export function createNamespacedKey(
  sharedSecret: Uint8Array,
  namespace: string
): Uint8Array {
  const namespaceBytes = Buffer.from(namespace, 'utf8');
  return arrayify(computeHmac(SupportedAlgorithm.sha256, sharedSecret, namespaceBytes));
}

export function namespacedHmac(secret:Uint8Array, namespace: string, data:Uint8Array): Uint8Array {
 const k = createNamespacedKey(secret, `(${namespace}) HMAC SHA256`);
 return arrayify(computeHmac(SupportedAlgorithm.sha256, k, data)) 
}