/**
 * Experiment 01: Connect to Lit Protocol and Generate Session Signatures
 *
 * This script tests the basic connection to the Lit Protocol datil-dev network
 * and generates session signatures using a random test wallet.
 *
 * What we're testing:
 * - Can we connect to datil-dev network?
 * - Can we generate session signatures with a random wallet?
 * - What does the session signature object look like?
 *
 * Run with: pnpm exp:01
 */

import { createLitClient, disconnectLitClient } from '../utils/lit-client';
import { generateRandomWallet } from '../utils/test-wallets';
import { getSessionSigsForLitAction } from '../utils/session-sigs';

async function main() {
  console.log('=== Experiment 01: Connect and Authenticate ===\n');

  let litClient;

  try {
    // Step 1: Generate a random test wallet
    console.log('Step 1: Generate random test wallet');
    const wallet = generateRandomWallet();
    console.log('  Address:', wallet.address);
    console.log();

    // Step 2: Connect to Lit Protocol
    console.log('Step 2: Connect to Lit Protocol (datil-dev)');
    litClient = await createLitClient();
    console.log();

    // Step 3: Generate session signatures
    console.log('Step 3: Generate session signatures');
    const sessionSigs = await getSessionSigsForLitAction(litClient, wallet);
    console.log();

    // Step 4: Inspect what we got
    console.log('Step 4: Inspect session signatures');
    console.log('  Number of signatures:', Object.keys(sessionSigs).length);
    console.log('  Signature keys:', Object.keys(sessionSigs).slice(0, 3), '...');

    // Look at one signature in detail
    const firstKey = Object.keys(sessionSigs)[0];
    const firstSig = sessionSigs[firstKey];
    console.log('\n  First signature structure:');
    console.log('    sig:', firstSig.sig?.substring(0, 50) + '...');
    console.log('    derivedVia:', firstSig.derivedVia);
    console.log('    signedMessage:', firstSig.signedMessage?.substring(0, 100) + '...');
    console.log('    address:', firstSig.address);

    console.log('\n✅ Success! Connection and authentication working.');
    console.log('\nFindings:');
    console.log('- datil-dev network is accessible');
    console.log('- Random wallets can be used for session signatures (no funds needed)');
    console.log('- Session signatures are generated for multiple Lit nodes');

  } catch (error) {
    console.error('\n❌ Error:', error);
    throw error;
  } finally {
    // Cleanup
    if (litClient) {
      console.log('\nCleaning up...');
      await disconnectLitClient(litClient);
    }
  }
}

// Run the experiment
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
