import { defaultAbiCoder, arrayify, concat, keccak256, SigningKey, randomBytes, hexlify } from './ethers-compat.js';

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
  return arrayify(keccak256(concat([namespaceBytes, sharedSecret])));
}
