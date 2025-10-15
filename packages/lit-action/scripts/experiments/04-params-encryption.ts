/**
 * Experiment 04: Test jsParams Security and Encryption
 *
 * This script tests whether jsParams sent to Lit Actions are encrypted
 * and whether we need to add our own encryption layer.
 *
 * What we're testing:
 * - Are jsParams encrypted in transit?
 * - Can the Lit Action see plaintext jsParams?
 * - What happens if we send sensitive data?
 * - Do we need to encrypt data before sending to Lit Actions?
 *
 * Security considerations:
 * - jsParams are sent from client to Lit nodes
 * - We need to know if this is encrypted end-to-end
 * - If not, we need to implement our own encryption
 *
 * Run with: pnpm exp:04
 */

import { createLitClient, disconnectLitClient } from '../utils/lit-client';
import { generateRandomWallet } from '../utils/test-wallets';
import { getSessionSigsForLitAction } from '../utils/session-sigs';

async function main() {
  console.log('=== Experiment 04: jsParams Security ===\n');

  let litClient;

  try {
    // Step 1: Connect and setup
    console.log('Step 1: Setup');
    litClient = await createLitClient();
    const wallet = generateRandomWallet();
    const sessionSigs = await getSessionSigsForLitAction(litClient, wallet);
    console.log();

    // Step 2: Send various types of data as jsParams
    console.log('Step 2: Test different data types in jsParams');

    const litActionCode = `
(async () => {
  // Log everything we receive
  const results = {
    receivedParams: {
      plainString: typeof plainString !== 'undefined' ? plainString : 'MISSING',
      secretData: typeof secretData !== 'undefined' ? secretData : 'MISSING',
      numericValue: typeof numericValue !== 'undefined' ? numericValue : 'MISSING',
      objectData: typeof objectData !== 'undefined' ? objectData : 'MISSING',
      binaryData: typeof binaryData !== 'undefined' ? binaryData : 'MISSING',
    },
    canAccessAll: true,
    environment: {
      hasEthers: typeof ethers !== 'undefined',
      hasLitActions: typeof Lit !== 'undefined' && typeof Lit.Actions !== 'undefined',
    }
  };

  Lit.Actions.setResponse({
    response: JSON.stringify(results, null, 2)
  });
})();
`;

    const testData = {
      plainString: 'Hello, this is plaintext!',
      secretData: 'THIS_SHOULD_BE_SECRET_PASSWORD_123',
      numericValue: 42,
      objectData: {
        nested: 'value',
        array: [1, 2, 3],
      },
      binaryData: new Uint8Array([1, 2, 3, 4, 5]),
    };

    console.log('  Sending test data:');
    console.log('    - Plain string');
    console.log('    - "Secret" password (plaintext)');
    console.log('    - Numeric value');
    console.log('    - Object with nested data');
    console.log('    - Binary Uint8Array');
    console.log();

    const result = await litClient.executeJs({
      code: litActionCode,
      sessionSigs,
      jsParams: testData,
    });

    // Step 3: Inspect what the Lit Action received
    console.log('Step 3: What the Lit Action received:');
    const response = JSON.parse(result.response as string);
    console.log(JSON.stringify(response, null, 2));
    console.log();

    // Step 4: Analysis
    console.log('Step 4: Analysis');

    const allParamsReceived = Object.values(response.receivedParams).every(
      (v) => v !== 'MISSING'
    );

    if (allParamsReceived) {
      console.log('  ✅ All jsParams were received by the Lit Action');
      console.log('  📊 The Lit Action can see ALL data sent via jsParams');
    } else {
      console.log('  ⚠️  Some jsParams were not received');
    }

    console.log();
    console.log('Security findings:');
    console.log('  ⚠️  IMPORTANT SECURITY IMPLICATIONS:');
    console.log();
    console.log('  1. jsParams are visible to the Lit Action in plaintext');
    console.log('  2. We need to verify if jsParams are encrypted in transit');
    console.log('  3. Consider: Are jsParams encrypted between client and Lit nodes?');
    console.log('  4. Consider: Can Lit node operators see jsParams?');
    console.log();
    console.log('Recommendations:');
    console.log('  - If sending sensitive data, encrypt it client-side BEFORE jsParams');
    console.log('  - Have the Lit Action decrypt using its PKP-derived key');
    console.log('  - Never send plaintext secrets via jsParams if nodes can see them');
    console.log();
    console.log('Further research needed:');
    console.log('  - Read Lit Protocol docs on jsParams encryption');
    console.log('  - Check if jsParams are E2E encrypted to the TEE');
    console.log('  - Verify threat model: who can see jsParams?');

  } catch (error) {
    console.error('\n❌ Error:', error);
    if (error instanceof Error) {
      console.error('Message:', error.message);
    }
    throw error;
  } finally {
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
