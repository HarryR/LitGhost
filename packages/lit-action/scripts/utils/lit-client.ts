/**
 * Utilities for initializing and connecting to Lit Protocol
 * Using SDK v7.3.0 with datil-dev network
 */

import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_NETWORK, LIT_NETWORK_VALUES } from '@lit-protocol/constants';



/**
 * Create and connect to Lit Protocol network
 * Using datil-dev network (SDK v7.3.0)
 */
export async function createLitClient(litNetwork: LIT_NETWORK_VALUES, debug:boolean=true) {
  console.log('Connecting to Lit Protocol (datil-dev network, SDK v7.3.0)...');

  const litClient = new LitNodeClient({litNetwork, debug,});

  await litClient.connect();

  console.log('✓ Connected to Lit Protocol');

  return litClient;
}

/**
 * Disconnect from Lit Protocol
 */
export async function disconnectLitClient(client: any): Promise<void> {
  if (client.disconnect) {
    await client.disconnect();
  }
  console.log('✓ Disconnected from Lit Protocol');
}
