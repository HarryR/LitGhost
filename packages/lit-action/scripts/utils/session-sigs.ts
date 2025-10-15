/**
 * Utilities for generating session signatures for Lit Protocol authentication
 */

import { ethers } from 'ethers';
import type { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_ABILITY } from '@lit-protocol/constants';
import {
  createSiweMessage,
  generateAuthSig,
  LitActionResource,
  LitPKPResource,
} from '@lit-protocol/auth-helpers';

/**
 * Generate session signatures for executing Lit Actions
 * This allows any Lit Action to be executed
 */
export async function getSessionSigsForLitAction(
  litNodeClient: LitNodeClient,
  wallet: ethers.Wallet
) {
  console.log('Generating session signatures for Lit Action execution...');

  const sessionSigs = await litNodeClient.getSessionSigs({
    chain: 'ethereum',
    expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
    resourceAbilityRequests: [
      {
        resource: new LitActionResource('*'),
        ability: LIT_ABILITY.LitActionExecution,
      },
    ],
    authNeededCallback: async ({ uri, expiration, resourceAbilityRequests }) => {
      const toSign = await createSiweMessage({
        uri,
        expiration,
        resources: resourceAbilityRequests,
        walletAddress: wallet.address,
        nonce: await litNodeClient.getLatestBlockhash(),
        litNodeClient,
      });

      return await generateAuthSig({
        signer: wallet,
        toSign,
      });
    },
  });

  console.log('✓ Session signatures generated');

  return sessionSigs;
}

/**
 * Generate session signatures for PKP signing operations
 * Requires a specific PKP token ID
 */
export async function getSessionSigsForPKP(
  litNodeClient: LitNodeClient,
  wallet: ethers.Wallet,
  pkpTokenId: string
) {
  console.log('Generating session signatures for PKP signing...');

  const sessionSigs = await litNodeClient.getSessionSigs({
    chain: 'ethereum',
    expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
    resourceAbilityRequests: [
      {
        resource: new LitPKPResource(pkpTokenId),
        ability: LIT_ABILITY.PKPSigning,
      },
      {
        resource: new LitActionResource('*'),
        ability: LIT_ABILITY.LitActionExecution,
      },
    ],
    authNeededCallback: async ({ uri, expiration, resourceAbilityRequests }) => {
      const toSign = await createSiweMessage({
        uri,
        expiration,
        resources: resourceAbilityRequests,
        walletAddress: wallet.address,
        nonce: await litNodeClient.getLatestBlockhash(),
        litNodeClient,
      });

      return await generateAuthSig({
        signer: wallet,
        toSign,
      });
    },
  });

  console.log('✓ Session signatures generated for PKP');

  return sessionSigs;
}
