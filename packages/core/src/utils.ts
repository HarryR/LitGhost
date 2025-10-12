import { defaultAbiCoder } from '@ethersproject/abi';
import { arrayify, concat } from '@ethersproject/bytes';
import { keccak256 } from '@ethersproject/keccak256';
import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

// Set the SHA-512 hash function for ed25519 v3 (required for Node.js)
ed25519.hashes.sha512 = sha512;
ed25519.hashes.sha512Async = (m: Uint8Array) => Promise.resolve(sha512(m));

export async function randomKeypair() {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = await ed25519.getPublicKeyAsync(privateKey);
  return {privateKey, publicKey};
}

/**
 * Compute ECDH shared secret using ed25519
 * Uses scalar multiplication: sharedSecret = privateKey * publicKey
 */
export function computeSharedSecret(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  // Get the scalar from the private key (first 32 bytes of extended key)
  const extKey = ed25519.utils.getExtendedPublicKey(privateKey);
  const scalar = extKey.scalar;

  // Multiply the public key point by the scalar
  const pubPoint = ed25519.Point.fromBytes(publicKey);
  const sharedPoint = pubPoint.multiply(scalar);

  // Return the shared secret as bytes
  return sharedPoint.toBytes();
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
