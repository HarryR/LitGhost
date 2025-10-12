/**
 * Ethers compatibility layer for sandboxed environments
 *
 * This version expects ethers v5 to be available as a global object.
 * It does NOT import from @ethersproject packages - only uses globals.
 */

// Get global ethers - throw error if not available
const globalEthers = (globalThis as any).ethers;
if (!globalEthers || !globalEthers.utils) {
  throw new Error('Global ethers object not found. This build requires ethers v5 to be available globally.');
}

/**
 * Export ethers utilities from global object
 */
export const keccak256 = globalEthers.utils.keccak256;
export const arrayify = globalEthers.utils.arrayify;
export const concat = globalEthers.utils.concat;
export const hexlify = globalEthers.utils.hexlify;
export const defaultAbiCoder = globalEthers.utils.defaultAbiCoder;
export const SigningKey = globalEthers.utils.SigningKey;
export const randomBytes = globalEthers.utils.randomBytes;
