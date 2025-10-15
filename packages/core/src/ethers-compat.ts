/**
 * Ethers compatibility layer for standard builds
 *
 * Simply re-exports utilities from @ethersproject packages.
 * For sandboxed builds, see ethers-compat.sandboxed.ts
 */

export { keccak256 } from '@ethersproject/keccak256';
export { computeHmac, SupportedAlgorithm } from '@ethersproject/sha2';
export { arrayify, concat, hexlify } from '@ethersproject/bytes';
export { toUtf8Bytes } from '@ethersproject/strings';
export { defaultAbiCoder } from '@ethersproject/abi';
export { SigningKey } from '@ethersproject/signing-key';
export { randomBytes } from '@ethersproject/random';
export { Contract } from '@ethersproject/contracts';
export { JsonRpcProvider } from '@ethersproject/providers';