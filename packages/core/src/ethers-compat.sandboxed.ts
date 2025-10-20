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
export const computeHmac = globalEthers.utils.computeHmac;
export const SupportedAlgorithm = globalEthers.utils.SupportedAlgorithm;
export const keccak256 = globalEthers.utils.keccak256;
export const arrayify = globalEthers.utils.arrayify;
export const concat = globalEthers.utils.concat;
export const hexlify = globalEthers.utils.hexlify;
export const toUtf8Bytes = globalEthers.utils.toUtf8Bytes;
export const defaultAbiCoder = globalEthers.utils.defaultAbiCoder;
export const SigningKey = globalEthers.utils.SigningKey;
export const recoverPublicKey = globalEthers.utils.recoverPublicKey;
export const randomBytes = globalEthers.utils.randomBytes;
export const recoverAddress = globalEthers.utils.recoverAddress;
export const serializeTransaction = globalEthers.utils.serializeTransaction;
export const joinSignature = globalEthers.utils.joinSignature;
export const verifyMessage = globalEthers.utils.verifyMessage;
export const Contract = globalEthers.Contract;
export const JsonRpcProvider = globalEthers.providers.JsonRpcProvider;
