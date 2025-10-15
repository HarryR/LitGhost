/**
 * Experiment 07: Encryption and IPFS CID Access Control
 *
 * This script tests:
 * - Lit.Actions.encrypt() API
 * - Access control conditions with :currentActionIpfsId
 * - What's available in Lit.Auth namespace
 * - Decryption with IPFS CID restrictions
 *
 * Goals:
 * - Understand how to encrypt data that only a specific IPFS CID can decrypt
 * - Test if Lit.Auth.actionIpfsIds[0] actually works
 * - Generate realistic encrypted data for on-chain storage
 *
 * Run with: pnpm exp:07
 */

import { createLitClient, disconnectLitClient } from '../utils/lit-client';
import { getFundedTestWallet } from '../utils/test-wallets';
import { getSessionSigsForPKP } from '../utils/session-sigs';
import { loadPKP } from '../utils/pkp-storage';

async function main() {
  console.log('=== Experiment 07: Encryption and IPFS CID ===\n');

  let litClient;

  try {
    // Step 1: Load PKP
    console.log('Step 1: Load existing PKP');
    const pkp = await loadPKP();

    if (!pkp) {
      console.error('❌ No PKP found. Run experiment 02 first.');
      return;
    }

    console.log('  PKP Address:', pkp.ethAddress);
    console.log();

    // Step 2: Connect and setup
    console.log('Step 2: Connect to Lit Protocol');
    litClient = await createLitClient();
    const wallet = getFundedTestWallet();
    const sessionSigs = await getSessionSigsForPKP(litClient, wallet, pkp.tokenId);
    console.log();

    // Step 3: Inspect Lit.Auth namespace
    console.log('Step 3: Inspect Lit.Auth namespace');

    const inspectLitAuthCode = `
(async () => {
  // Try to directly dump Lit.Auth
  let authData;

  try {
    if (typeof Lit !== 'undefined' && Lit.Auth) {
      authData = Lit.Auth;
    } else {
      authData = { error: 'Lit.Auth not available' };
    }
  } catch (e) {
    authData = { error: e.message };
  }

  Lit.Actions.setResponse({
    response: JSON.stringify(authData, null, 2)
  });
})();
`;

    const result1 = await litClient.executeJs({
      code: inspectLitAuthCode,
      sessionSigs,
      jsParams: {
        publicKey: pkp.publicKey,
      },
    });

    let response1;
    if (typeof result1.response === 'string') {
      response1 = JSON.parse(result1.response);
    } else {
      response1 = result1.response;
    }

    console.log('  Lit.Auth inspection:');
    console.log(JSON.stringify(response1, null, 2));
    console.log();

    // Step 4: Test encryption with IPFS CID access control
    console.log('Step 4: Encrypt data with IPFS CID access control');

    const encryptionCode = `
(async () => {
  // Data to encrypt - simulate entropy for bootstrap
  const entropy = ethers.utils.randomBytes(32);
  const entropyHex = ethers.utils.hexlify(entropy);

  // Try to get current action IPFS CID
  let currentCid = 'unknown';
  try {
    if (typeof Lit !== 'undefined' && Lit.Auth && Lit.Auth.actionIpfsIds) {
      currentCid = Lit.Auth.actionIpfsIds[0] || 'not set';
    }
  } catch (e) {
    currentCid = 'error: ' + e.message;
  }

  // Access control: only THIS IPFS CID can decrypt
  const accessControlConditions = [
    {
      contractAddress: '',
      standardContractType: '',
      chain: 'ethereum',
      method: 'eth_getBalance',
      parameters: [':currentActionIpfsId', 'latest'],
      returnValueTest: {
        comparator: '==',
        value: currentCid,
      },
    },
  ];

  // Encrypt the data
  let encryptResult;
  try {
    encryptResult = await Lit.Actions.encrypt({
      accessControlConditions,
      to_encrypt: entropy,
    });
  } catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: 'Encryption failed: ' + error.message,
        currentCid,
        accessControlConditions
      })
    });
    return;
  }

  // Derive wallet from entropy for verification
  const wallet = new ethers.Wallet(entropy);

  // Convert ciphertext to base64 if it's a Uint8Array, otherwise keep as is
  let ciphertextStr;
  if (encryptResult.ciphertext instanceof Uint8Array) {
    // Convert to base64 for storage/transmission
    const binaryStr = Array.from(encryptResult.ciphertext)
      .map(byte => String.fromCharCode(byte))
      .join('');
    ciphertextStr = btoa(binaryStr);
  } else {
    ciphertextStr = encryptResult.ciphertext;
  }

  // Convert dataToEncryptHash similarly
  let dataHashStr;
  if (encryptResult.dataToEncryptHash instanceof Uint8Array) {
    dataHashStr = ethers.utils.hexlify(encryptResult.dataToEncryptHash);
  } else {
    dataHashStr = encryptResult.dataToEncryptHash;
  }

  Lit.Actions.setResponse({
    response: JSON.stringify({
      success: true,
      currentCid,
      ciphertext: ciphertextStr,
      dataToEncryptHash: dataHashStr,
      derivedAddress: wallet.address,
      entropyPreview: entropyHex.substring(0, 20) + '...',
      accessControlConditions,
      encryptResultKeys: Object.keys(encryptResult)
    })
  });
})();
`;

    const result2 = await litClient.executeJs({
      code: encryptionCode,
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

    console.log('  Encryption result:');
    if (response2.error) {
      console.log('  ❌ Error:', response2.error);
      console.log('  Current CID:', response2.currentCid);
    } else {
      console.log('  ✓ Success!');
      console.log('  Current CID:', response2.currentCid);
      console.log('  Ciphertext length:', response2.ciphertext?.length);
      console.log('  Data hash:', response2.dataToEncryptHash);
      console.log('  Derived address:', response2.derivedAddress);
      console.log('  Entropy preview:', response2.entropyPreview);
    }
    console.log();

    // Step 5: Test decryption with the same CID
    if (response2.success) {
      console.log('Step 5: Test decryption with matching CID');

      const decryptionCode = `
(async () => {
  // Get current CID
  let currentCid = 'unknown';
  try {
    if (typeof Lit !== 'undefined' && Lit.Auth && Lit.Auth.actionIpfsIds) {
      currentCid = Lit.Auth.actionIpfsIds[0] || 'not set';
    }
  } catch (e) {
    currentCid = 'error: ' + e.message;
  }

  // Access control conditions (same as encryption)
  const accessControlConditions = JSON.parse(accessControlConditionsJson);

  // Decrypt
  let decrypted;
  try {
    decrypted = await Lit.Actions.decryptToSingleNode({
      accessControlConditions,
      ciphertext: ciphertextHex,
      dataToEncryptHash: dataHashHex,
      authSig: null,
      chain: 'ethereum',
    });
  } catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: 'Decryption failed: ' + error.message,
        currentCid,
      })
    });
    return;
  }

  // Verify by deriving wallet
  const entropy = ethers.utils.arrayify(decrypted);
  const wallet = new ethers.Wallet(entropy);

  Lit.Actions.setResponse({
    response: JSON.stringify({
      success: true,
      currentCid,
      derivedAddress: wallet.address,
      matchesOriginal: wallet.address === originalAddress,
    })
  });
})();
`;

      const result3 = await litClient.executeJs({
        code: decryptionCode,
        sessionSigs,
        jsParams: {
          publicKey: pkp.publicKey,
          ciphertextHex: response2.ciphertext,
          dataHashHex: response2.dataToEncryptHash,
          accessControlConditionsJson: JSON.stringify(response2.accessControlConditions),
          originalAddress: response2.derivedAddress,
        },
      });

      let response3;
      if (typeof result3.response === 'string') {
        response3 = JSON.parse(result3.response);
      } else {
        response3 = result3.response;
      }

      console.log('  Decryption result:');
      if (response3.error) {
        console.log('  ❌ Error:', response3.error);
      } else {
        console.log('  ✓ Success!');
        console.log('  Derived address:', response3.derivedAddress);
        console.log('  Matches original:', response3.matchesOriginal ? '✓' : '✗');
      }
      console.log();
    }

    // Step 6: Test with hardcoded IPFS CID
    console.log('Step 6: Test encryption with hardcoded IPFS CID');

    const hardcodedCidCode = `
(async () => {
  const testCid = 'QmTest123456789'; // Fake CID for demonstration

  const accessControlConditions = [
    {
      contractAddress: '',
      standardContractType: '',
      chain: 'ethereum',
      method: 'eth_getBalance',
      parameters: [':currentActionIpfsId', 'latest'],
      returnValueTest: {
        comparator: '==',
        value: testCid,
      },
    },
  ];

  const testData = ethers.utils.toUtf8Bytes('test secret data');

  try {
    const encryptResult = await Lit.Actions.encrypt({
      accessControlConditions,
      to_encrypt: testData,
    });

    // Convert to base64/hex appropriately
    let ciphertextStr;
    if (encryptResult.ciphertext instanceof Uint8Array) {
      const binaryStr = Array.from(encryptResult.ciphertext)
        .map(byte => String.fromCharCode(byte))
        .join('');
      ciphertextStr = btoa(binaryStr).substring(0, 50) + '...';
    } else {
      ciphertextStr = String(encryptResult.ciphertext).substring(0, 50) + '...';
    }

    let dataHashStr;
    if (encryptResult.dataToEncryptHash instanceof Uint8Array) {
      dataHashStr = ethers.utils.hexlify(encryptResult.dataToEncryptHash);
    } else {
      dataHashStr = encryptResult.dataToEncryptHash;
    }

    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: true,
        hardcodedCid: testCid,
        ciphertext: ciphertextStr,
        dataToEncryptHash: dataHashStr,
      })
    });
  } catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        error: error.message,
        hardcodedCid: testCid,
      })
    });
  }
})();
`;

    const result4 = await litClient.executeJs({
      code: hardcodedCidCode,
      sessionSigs,
      jsParams: {},
    });

    let response4;
    if (typeof result4.response === 'string') {
      response4 = JSON.parse(result4.response);
    } else {
      response4 = result4.response;
    }

    console.log('  Hardcoded CID test:');
    if (response4.error) {
      console.log('  ❌ Error:', response4.error);
    } else {
      console.log('  ✓ Success!');
      console.log('  Hardcoded CID:', response4.hardcodedCid);
      console.log('  Ciphertext preview:', response4.ciphertext);
      console.log('  Data hash:', response4.dataToEncryptHash);
    }
    console.log();

    console.log('✅ Experiment complete!');
    console.log();
    console.log('Key Findings:');
    console.log('- Lit.Auth namespace availability:', response1.hasLitAuth ? '✓' : '✗');
    console.log('- Lit.Auth.actionIpfsIds:', response1.actionIpfsIds);
    console.log('- Encryption with :currentActionIpfsId:', response2.success ? '✓' : '✗');
    console.log('- Hardcoded CID encryption:', response4.success ? '✓' : '✗');
    console.log();
    console.log('Next Steps:');
    console.log('1. Use hardcoded IPFS CID in access control conditions');
    console.log('2. After uploading to IPFS, update code with actual CID');
    console.log('3. Store ciphertext + dataToEncryptHash in smart contract');
    console.log('4. Lit Action fetches from contract and decrypts');

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
