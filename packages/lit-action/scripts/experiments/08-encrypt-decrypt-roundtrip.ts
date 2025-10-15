/**
 * Experiment 08: Encrypt and Decrypt Roundtrip with IPFS CID Policy
 *
 * This experiment verifies the complete encryption/decryption flow:
 * 1. Generate entropy (32 random bytes)
 * 2. Encrypt entropy with access control locked to current IPFS CID
 * 3. Decrypt the ciphertext in the same action
 * 4. Verify the decrypted data matches the original entropy
 *
 * This proves:
 * - Encryption works with :currentActionIpfsId policy
 * - Decryption works when executed from the matching IPFS CID
 * - The round-trip is lossless (original data === decrypted data)
 */

import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { loadPKP } from '../utils/pkp-storage.js';
import { createLitClient } from '../utils/lit-client.js';
import { getSessionSigsForPKP } from '../utils/session-sigs.js';
import { getFundedTestWallet } from '../utils/test-wallets.js';

async function main() {
  let litClient: LitNodeClient | null = null;

  try {
    console.log('=== Experiment 08: Encrypt/Decrypt Roundtrip with IPFS CID Policy ===\n');

    // Step 1: Load PKP
    console.log('Step 1: Load existing PKP');
    const pkp = await loadPKP();
    if (!pkp) {
      throw new Error('No PKP found. Run experiment 02 first to mint a PKP.');
    }
    console.log('✓ Loaded existing PKP:', pkp.ethAddress);
    console.log('  PKP Address:', pkp.ethAddress);
    console.log();

    // Step 2: Connect and setup
    console.log('Step 2: Connect to Lit Protocol');
    litClient = await createLitClient();
    const wallet = getFundedTestWallet();
    const sessionSigs = await getSessionSigsForPKP(litClient, wallet, pkp.tokenId);
    console.log();

    // Step 3: Encrypt and then decrypt with IPFS CID policy
    console.log('Step 3: Encrypt entropy with IPFS CID policy, then decrypt');

    const encryptDecryptCode = `
(async () => {
  const results = {
    step1_getCurrentCid: null,
    step2_generateEntropy: null,
    step3_encrypt: null,
    step4_decrypt: null,
    step5_verify: null,
  };

  //try {
    // Step 1: Get current action IPFS CID
    const currentCid = Lit.Auth.actionIpfsIds[0];
    results.step1_getCurrentCid = {
      success: true,
      cid: currentCid
    };

    // Step 2: Generate entropy (32 random bytes)
    const entropy = ethers.utils.randomBytes(32);
    const entropyHex = ethers.utils.hexlify(entropy);
    results.step2_generateEntropy = {
      success: true,
      entropyPreview: entropyHex.substring(0, 20) + '...',
      entropyLength: entropy.length
    };

    // Step 3: Encrypt with access control locked to current IPFS CID
    // When method is empty, it uses check_condition_via_signature which does string comparison
    const accessControlConditions = [
      {
        contractAddress: '',
        standardContractType: '',
        chain: 'ethereum',
        method: '',
        parameters: [':currentActionIpfsId'],
        returnValueTest: {
          comparator: '=',
          value: currentCid,
        },
      },
    ];

    const encryptResult = await Lit.Actions.encrypt({
      accessControlConditions,
      to_encrypt: entropy,
    });

    // Convert ciphertext to base64 for transmission
    let ciphertextStr;
    if (encryptResult.ciphertext instanceof Uint8Array) {
      const binaryStr = Array.from(encryptResult.ciphertext)
        .map(byte => String.fromCharCode(byte))
        .join('');
      ciphertextStr = btoa(binaryStr);
    } else {
      ciphertextStr = encryptResult.ciphertext;
    }

    // Convert dataToEncryptHash to hex
    let dataHashStr;
    if (encryptResult.dataToEncryptHash instanceof Uint8Array) {
      dataHashStr = ethers.utils.hexlify(encryptResult.dataToEncryptHash);
    } else {
      dataHashStr = encryptResult.dataToEncryptHash;
    }

    results.step3_encrypt = {
      success: true,
      ciphertextLength: ciphertextStr.length,
      ciphertextPreview: ciphertextStr.substring(0, 30) + '...',
      dataToEncryptHash: dataHashStr,
    };

    // Step 4: Decrypt using decryptAndCombine
    // Note: In production, you'd fetch ciphertext + dataToEncryptHash from the smart contract
    // Here we're using the original encrypt result formats (not the converted strings)

    const decryptResult = await Lit.Actions.decryptAndCombine({
      accessControlConditions,
      ciphertext: encryptResult.ciphertext,  // Use original format
      dataToEncryptHash: encryptResult.dataToEncryptHash,  // Use original format
      authSig: null,
      chain: 'ethereum',
    });

    // Convert decrypted result to hex for comparison
    let decryptedHex;
    if (decryptResult instanceof Uint8Array) {
      decryptedHex = ethers.utils.hexlify(decryptResult);
    } else if (typeof decryptResult === 'string') {
      decryptedHex = decryptResult;
    } else {
      decryptedHex = 'unknown format';
    }

    results.step4_decrypt = {
      success: true,
      decryptedDataPreview: decryptedHex.substring(0, 20) + '...',
      decryptedLength: decryptResult.length,
    };

    // Step 5: Verify original matches decrypted
    const matches = entropyHex === decryptedHex;
    results.step5_verify = {
      success: true,
      matches,
      originalPreview: entropyHex.substring(0, 20) + '...',
      decryptedPreview: decryptedHex.substring(0, 20) + '...',
    };

    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: true,
        currentCid,
        results,
      }, null, 2)
    });
/*
  } catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: false,
        error: error.message,
        results,
      }, null, 2)
    });
  }
  */
})();
`;

    const result = await litClient.executeJs({
      code: encryptDecryptCode,
      sessionSigs,
      jsParams: {
        publicKey: pkp.publicKey,
      },
    });

    let response;
    if (typeof result.response === 'string') {
      response = JSON.parse(result.response);
    } else {
      response = result.response;
    }

    console.log('  Results:');
    if (response.success) {
      console.log('  ✓ Overall: SUCCESS');
      console.log('  Current CID:', response.currentCid);
      console.log();

      console.log('  Step 1 - Get Current CID:');
      console.log('    ✓', response.results.step1_getCurrentCid.cid);
      console.log();

      console.log('  Step 2 - Generate Entropy:');
      console.log('    ✓ Length:', response.results.step2_generateEntropy.entropyLength, 'bytes');
      console.log('    ✓ Preview:', response.results.step2_generateEntropy.entropyPreview);
      console.log();

      console.log('  Step 3 - Encrypt:');
      console.log('    ✓ Ciphertext length:', response.results.step3_encrypt.ciphertextLength);
      console.log('    ✓ Ciphertext preview:', response.results.step3_encrypt.ciphertextPreview);
      console.log('    ✓ Data hash:', response.results.step3_encrypt.dataToEncryptHash);
      console.log();

      console.log('  Step 4 - Decrypt:');
      console.log('    ✓ Decrypted length:', response.results.step4_decrypt.decryptedLength, 'bytes');
      console.log('    ✓ Decrypted preview:', response.results.step4_decrypt.decryptedDataPreview);
      console.log();

      console.log('  Step 5 - Verify:');
      if (response.results.step5_verify.matches) {
        console.log('    ✓ VERIFIED: Original entropy matches decrypted data!');
        console.log('    ✓ Original:', response.results.step5_verify.originalPreview);
        console.log('    ✓ Decrypted:', response.results.step5_verify.decryptedPreview);
      } else {
        console.log('    ❌ MISMATCH: Original and decrypted data do not match!');
        console.log('    Original:', response.results.step5_verify.originalPreview);
        console.log('    Decrypted:', response.results.step5_verify.decryptedPreview);
      }
    } else {
      console.log('  ❌ Error:', response.error);
      console.log('  Results:', JSON.stringify(response.results, null, 2));
    }
    console.log();

    console.log('✅ Experiment complete!\n');
    console.log('Key Findings:');
    if (response.success && response.results.step5_verify?.matches) {
      console.log('- ✓ Encryption with IPFS CID policy works');
      console.log('- ✓ Decryption from same IPFS CID works');
      console.log('- ✓ Round-trip is lossless (original === decrypted)');
      console.log('- ✓ Ready for on-chain bootstrap pattern!');
    } else {
      console.log('- ❌ Something went wrong - see results above');
    }
    console.log();

    console.log('Next Steps:');
    console.log('1. Implement bootstrap Lit Action that encrypts entropy');
    console.log('2. Store ciphertext + dataToEncryptHash in smart contract');
    console.log('3. Implement main Lit Action that decrypts from contract');
    console.log('4. Deploy and verify end-to-end flow');
    console.log();

  } catch (error) {
    console.error('❌ Error:', error);
    if (error instanceof Error) {
      console.error('Message:', error.message);
      console.error('Stack:', error.stack);
    }
    throw error;
  } finally {
    if (litClient) {
      console.log('Cleaning up...');
      litClient.disconnect();
      console.log('✓ Disconnected from Lit Protocol');
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
