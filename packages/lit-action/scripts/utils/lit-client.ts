/**
 * Utilities for initializing and connecting to Lit Protocol
 */

import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_NETWORK } from '@lit-protocol/constants';

/**
 * Create and connect to Lit Protocol network
 * Using datil-dev for testing (longer timeout for debugging)
 */
export async function createLitClient(): Promise<LitNodeClient> {
  console.log('Connecting to Lit Protocol (datil-dev network)...');

  const litNodeClient = new LitNodeClient({
    litNetwork: LIT_NETWORK.DatilDev,
    debug: false,
  });

  await litNodeClient.connect();

  console.log('✓ Connected to Lit Protocol');

  return litNodeClient;
}

/**
 * Disconnect from Lit Protocol
 */
export async function disconnectLitClient(client: LitNodeClient): Promise<void> {
  await client.disconnect();
  console.log('✓ Disconnected from Lit Protocol');
}
