/**
 * Experiment 03: Derive Keys Using PKP
 *
 * This script executes a Lit Action that uses the PKP to sign data and
 * demonstrates that the PKP can consistently derive the same Ethereum address.
 *
 * What we're testing:
 * - Can we execute a Lit Action that calls Lit.Actions.signEcdsa()?
 * - What does the PKP's Ethereum address look like?
 * - Is the derived key consistent across multiple executions?
 * - Can the Lit Action access the PKP's private key material?
 *
 * Run with: pnpm exp:03
 */

import { createLitClient, disconnectLitClient } from '../utils/lit-client';
import { getFundedTestWallet } from '../utils/test-wallets';
import { getSessionSigsForPKP } from '../utils/session-sigs';
import { loadPKP } from '../utils/pkp-storage';
import { ethers } from 'ethers';

async function main() {
  console.log('=== Experiment 03: Derive Keys with PKP ===\n');

  let litClient;

  try {
    // Step 1: Load the PKP we created in experiment 02
    console.log('Step 1: Load existing PKP');
    const pkp = await loadPKP();

    if (!pkp) {
      console.error('❌ No PKP found. Run experiment 02 first to mint a PKP.');
      return;
    }

    console.log('  Token ID:', pkp.tokenId);
    console.log('  ETH Address:', pkp.ethAddress);
    console.log();

    // Step 2: Connect to Lit Protocol
    console.log('Step 2: Connect to Lit Protocol');
    litClient = await createLitClient();
    console.log();

    // Step 3: Generate session signatures for PKP signing
    // Use the funded test wallet since that's the authorized wallet for this PKP
    console.log('Step 3: Generate session signatures');
    const wallet = getFundedTestWallet();
    console.log('  Using authorized wallet (same wallet that minted the PKP)');
    const sessionSigs = await getSessionSigsForPKP(litClient, wallet, pkp.tokenId);
    console.log();

    // Step 4: Define a Lit Action that signs some data
    console.log('Step 4: Execute Lit Action to sign data');

    const litActionCode = `
(async () => {
  // Sign some test data with the PKP
  const dataToSign = ethers.utils.arrayify(
    ethers.utils.keccak256([1, 2, 3, 4, 5])
  );

  const sigShare = await Lit.Actions.signEcdsa({
    toSign: dataToSign,
    publicKey,
    sigName: "testSig",
  });

  // Return the signature and public key info
  Lit.Actions.setResponse({
    response: JSON.stringify({
      signature: sigShare,
      publicKey: publicKey,
      pkpEthAddress: ethers.utils.computeAddress("0x" + publicKey)
    })
  });
})();
`;

    // Execute the Lit Action
    const result = await litClient.executeJs({
      code: litActionCode,
      sessionSigs,
      jsParams: {
        publicKey: pkp.publicKey,
      },
    });

    console.log('  ✓ Lit Action executed');
    console.log();

    // Step 5: Inspect the results
    console.log('Step 5: Inspect results');

    // Handle response - might be string or object
    let response;
    if (typeof result.response === 'string') {
      response = JSON.parse(result.response);
    } else {
      response = result.response;
    }

    console.log('  Raw response type:', typeof result.response);
    console.log('  Response:', JSON.stringify(response, null, 2).substring(0, 300) + '...');

    console.log('  PKP Public Key:', response.publicKey.substring(0, 50) + '...');
    console.log('  PKP ETH Address:', response.pkpEthAddress);
    console.log('  Signature:', JSON.stringify(response.signature, null, 2).substring(0, 200) + '...');

    // Verify the address matches what we stored
    if (response.pkpEthAddress.toLowerCase() === pkp.ethAddress.toLowerCase()) {
      console.log('\n  ✅ Address matches stored PKP address!');
    } else {
      console.log('\n  ⚠️  Address mismatch!');
      console.log('    Expected:', pkp.ethAddress);
      console.log('    Got:', response.pkpEthAddress);
    }

    // Step 6: Run it again to verify consistency
    console.log('\nStep 6: Run again to verify consistency');
    const result2 = await litClient.executeJs({
      code: litActionCode,
      sessionSigs,
      jsParams: {
        publicKey: pkp.publicKey,
      },
    });

    let response2;
    if (typeof result2.response === 'string') {
      response2 = JSON.parse(result2.response);
    } else {
      response2 = result2.response;
    }

    console.log('  Second execution address:', response2.pkpEthAddress);

    if (response.pkpEthAddress === response2.pkpEthAddress) {
      console.log('  ✅ Consistent across executions!');
    }

    console.log('\n✅ Success! Key derivation working.');
    console.log('\nFindings:');
    console.log('- PKP can sign data using Lit.Actions.signEcdsa()');
    console.log('- The PKP derives a consistent Ethereum address');
    console.log('- The Lit Action has access to the PKP\'s signing capability');
    console.log('\nNext steps:');
    console.log('- Test what data can be accessed in jsParams (experiment 04)');
    console.log('- Figure out how to derive a root key only the Lit Action knows');

  } catch (error) {
    console.error('\n❌ Error:', error);
    if (error instanceof Error) {
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
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
