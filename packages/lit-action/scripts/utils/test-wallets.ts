/**
 * Utilities for test wallets
 */

import { ethers } from 'ethers';

/**
 * Hardcoded test private key for datil-dev experiments
 * This is a randomly generated key used for testing PKP minting
 * Safe to expose - only used for datil-dev testing network
 */
export const TEST_PRIVATE_KEY = '0xc77e929d6970d541accc8260402775b0ac6841413bd5f703afe4bd9c192e0bf0';

/**
 * Get the funded test wallet for PKP minting experiments
 * Uses a hardcoded private key (safe to expose - only for datil-dev testing)
 */
export function getFundedTestWallet(provider?: ethers.providers.Provider): ethers.Wallet {
  const wallet = new ethers.Wallet(TEST_PRIVATE_KEY, provider);
  console.log('Using test wallet:', wallet.address);
  return wallet;
}

/**
 * Generate a random Ethereum wallet for testing
 * These wallets don't need to have any funds
 */
export function generateRandomWallet(): ethers.Wallet {
  const wallet = ethers.Wallet.createRandom();
  console.log('Generated random test wallet:', wallet.address);
  return wallet;
}

/**
 * Create a wallet from a private key
 */
export function walletFromPrivateKey(privateKey: string, provider?: ethers.providers.Provider): ethers.Wallet {
  return new ethers.Wallet(privateKey, provider);
}
