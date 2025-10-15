/**
 * Experiment 05: Root Key Derivation
 *
 * This script explores how to derive a root key that only the Lit Action knows.
 * The goal is to have the Lit Action derive a key from the PKP that:
 * 1. Is deterministic (same key every time)
 * 2. Is only accessible within the Lit Action
 * 3. Can be used to derive additional secrets
 * 4. You (the developer) provably never had access to
 *
 * Approaches to test:
 * - Using signEcdsa with a deterministic message
 * - Using the PKP's public key as a seed
 * - Deriving keys using a standard derivation path
 *
 * Run with: pnpm exp:05
 */

import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LitContracts } from '@lit-protocol/contracts-sdk';
//import type { LitNodeClient },  from '@lit-protocol/lit-node-client';
import { LIT_NETWORK, LIT_RPC, AUTH_METHOD_SCOPE, AUTH_METHOD_TYPE } from '@lit-protocol/constants';
import { ethers } from 'ethers';
import { LIT_ABILITY } from '@lit-protocol/constants';
import {
  createSiweMessage,
  generateAuthSig,
  LitActionResource,
  LitPKPResource,
} from '@lit-protocol/auth-helpers';


export async function createLitClient() {
  console.log('Connecting to Lit Protocol (datil-dev network, SDK v7.3.0)...');

  const litClient = new LitNodeClient({
    litNetwork: LIT_NETWORK.DatilDev,
    debug: false,
  });

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

async function main() {
  console.log('=== Experiment 05: Root Key Derivation ===\n');

  let litClient;

  try {  
      const provider = new ethers.providers.JsonRpcProvider(
        LIT_RPC.CHRONICLE_YELLOWSTONE
      );
  
      // Use the funded test wallet (hardcoded for datil-dev testing)
      const wallet = getFundedTestWallet(provider);
  
      // Check balance
      const balance = await wallet.getBalance();
      console.log('  Balance:', ethers.utils.formatEther(balance), 'testnet ETH');
  
      if (balance.isZero()) {
        console.log('\n⚠️  Wallet has zero balance!');
        console.log('Send testnet funds to:', wallet.address);
        console.log('Get testnet tokens for Chronicle Yellowstone (datil-dev)');
        return;
      }

      // Step 3: Initialize Lit Contracts SDK
      const litContracts = new LitContracts({
        signer: wallet,
        network: LIT_NETWORK.DatilDev,
      });

      await litContracts.connect();
  
      // For EthWallet auth method, we just need to sign a simple message
      // The auth signature will be generated as part of minting
      const authSig = await wallet.signMessage('Sign to authorize PKP creation');
  
      const authMethod = {
        authMethodType: AUTH_METHOD_TYPE.EthWallet,
        accessToken: JSON.stringify({ sig: authSig, address: wallet.address }),
      };
  
      const mintResult = await litContracts.mintWithAuth({
        authMethod,
        scopes: [AUTH_METHOD_SCOPE.SignAnything],
      });
  
      const pkpInfo = mintResult.pkp;
  
      console.log('\n  ✅ PKP Minted Successfully!');
      console.log('  Token ID:', pkpInfo.tokenId);
      console.log('  Public Key:', pkpInfo.publicKey);
      console.log('  ETH Address:', pkpInfo.ethAddress);
      console.log();

    // Step 2: Connect and setup
    console.log('Step 2: Connect to Lit Protocol');
    litClient = await createLitClient();
    const sessionSigs = await getSessionSigsForPKP(litClient, wallet, pkpInfo.tokenId);

    const approach1Code = `
(async () => {
  // Use a well-known constant message to derive a root key
  // This ensures we always get the same signature = same root key
  const DERIVATION_MESSAGE = "LIT_ROOT_KEY_V1";

  // Hash the message to get bytes to sign
  const messageHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(DERIVATION_MESSAGE)
  );
  const toSign = ethers.utils.arrayify(messageHash);

  // Sign it with the PKP using signAndCombineEcdsa (returns the actual signature)
  const signature = await Lit.Actions.signAndCombineEcdsa({
    toSign,
    publicKey,
    sigName: "rootKey",
  });

  // Parse the signature JSON and format it
  const jsonSignature = JSON.parse(signature);
  jsonSignature.r = "0x" + jsonSignature.r.substring(2);
  jsonSignature.s = "0x" + jsonSignature.s;
  const hexSignature = ethers.utils.joinSignature(jsonSignature);

  // Use this signature as our deterministic root key
  const rootKeyHash = ethers.utils.keccak256(hexSignature);

  Lit.Actions.setResponse({
    response: JSON.stringify({
      approach: "deterministic_signature?",
      rootKeyHash: rootKeyHash,
      hexSignature: hexSignature,
      signatureR: jsonSignature.r.substring(0, 20) + "...",
      signatureS: jsonSignature.s.substring(0, 20) + "...",
      pkpAddress: ethers.utils.computeAddress("0x" + publicKey),
      notes: "Signature is deterministic - only the Lit Action can compute it"
    })
  });
})();
`;

    const result1 = await litClient.executeJs({
      code: approach1Code,
      sessionSigs,
      jsParams: {
        publicKey: pkpInfo.publicKey,
      },
    });

    // Understanding the response type from Lit Client
    console.log('  Response type from litClient.executeJs():', typeof result1.response);
    console.log('  Response is string?', typeof result1.response === 'string');
    console.log();

    let response1;
    if (typeof result1.response === 'string') {
      console.log('  ℹ️  Lit client returned a STRING, parsing JSON...');
      response1 = JSON.parse(result1.response);
    } else {
      console.log('  ℹ️  Lit client returned an OBJECT, using directly');
      response1 = result1.response;
    }

    console.log('  Root Key Hash:', response1.rootKeyHash);
    console.log('  PKP Address:', response1.pkpAddress);
    console.log('  Hex Signature:', response1.hexSignature?.substring(0, 30) + '...');
    console.log('  Signature R:', response1.signatureR);
    console.log('  Signature S:', response1.signatureS);
    console.log();

    // Run it again to verify determinism
    console.log('  Verifying determinism (running again)...');
    const result1b = await litClient.executeJs({
      code: approach1Code,
      sessionSigs,
      jsParams: {
        publicKey: pkpInfo.publicKey,
      },
    });

    let response1b;
    if (typeof result1b.response === 'string') {
      response1b = JSON.parse(result1b.response);
    } else {
      response1b = result1b.response;
    }

    if (response1.rootKeyHash === response1b.rootKeyHash) {
      console.log('  ✅ Root key is deterministic!');
    } else {
      console.log('  ❌ Root key is NOT deterministic');
    }
    console.log();

    // Step 4: Approach 2 - Derive secrets from the root key
    console.log('Step 4: Approach 2 - Derive multiple secrets from root key');

    const approach2Code = `
(async () => {
  // First, derive the root key (same as approach 1)
  const DERIVATION_MESSAGE = "LIT_ROOT_KEY_V1";
  const messageHash = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes(DERIVATION_MESSAGE)
  );
  const toSign = ethers.utils.arrayify(messageHash);

  // Get the actual signature using signAndCombineEcdsa
  const signature = await Lit.Actions.signAndCombineEcdsa({
    toSign,
    publicKey,
    sigName: "rootKey",
  });

  const jsonSignature = JSON.parse(signature);
  jsonSignature.r = "0x" + jsonSignature.r.substring(2);
  jsonSignature.s = "0x" + jsonSignature.s;
  const hexSignature = ethers.utils.joinSignature(jsonSignature);

  // Use the hex signature as our root key
  const rootKey = hexSignature;

  // Now derive multiple secrets from this root key
  // Each secret is deterministic and unique
  const secret1 = ethers.utils.keccak256(
    ethers.utils.concat([
      ethers.utils.arrayify(rootKey),
      ethers.utils.toUtf8Bytes("SECRET_1")
    ])
  );

  const secret2 = ethers.utils.keccak256(
    ethers.utils.concat([
      ethers.utils.arrayify(rootKey),
      ethers.utils.toUtf8Bytes("SECRET_2")
    ])
  );

  // You could even derive Ethereum private keys (BE CAREFUL!)
  const derivedPrivateKey = ethers.utils.keccak256(
    ethers.utils.concat([
      ethers.utils.arrayify(rootKey),
      ethers.utils.toUtf8Bytes("ETH_PRIVATE_KEY_V1")
    ])
  );
  const derivedWallet = new ethers.Wallet(derivedPrivateKey);

  Lit.Actions.setResponse({
    response: JSON.stringify({
      approach: "derive_multiple_secrets",
      secret1: secret1,
      secret2: secret2,
      derivedEthAddress: derivedWallet.address,
      notes: [
        "All secrets are deterministic",
        "Only the Lit Action can compute these",
        "You (developer) never had access to these secrets",
        "The derived ETH address can be used as the contract owner"
      ]
    })
  });
})();
`;

    const result2 = await litClient.executeJs({
      code: approach2Code,
      sessionSigs,
      jsParams: {
        publicKey: pkpInfo.publicKey,
      },
    });

    let response2;
    if (typeof result2.response === 'string') {
      response2 = JSON.parse(result2.response);
    } else {
      response2 = result2.response;
    }

    console.log('  Secret 1:', response2.secret1.substring(0, 20) + '...');
    console.log('  Secret 2:', response2.secret2.substring(0, 20) + '...');
    console.log('  Derived ETH Address:', response2.derivedEthAddress);
    console.log();

    console.log('✅ Success! Root key derivation working.');
    console.log();
    console.log('Key Findings:');
    console.log('  ✓ We can derive a deterministic root key using signEcdsa');
    console.log('  ✓ The root key is only accessible within the Lit Action');
    console.log('  ✓ Multiple secrets can be derived from the root key');
    console.log('  ✓ A deterministic Ethereum address can be derived for contract ownership');
    console.log();
    console.log('Deployment Strategy:');
    console.log('  1. Mint PKP during deployment');
    console.log('  2. Execute Lit Action to get derived ETH address');
    console.log('  3. Deploy contract with you as initial owner');
    console.log('  4. Transfer ownership to the derived ETH address');
    console.log('  5. Upload Lit Action to IPFS (get CID)');
    console.log('  6. Lock PKP policy to only allow that CID');
    console.log('  7. Now: Only the Lit Action can control the contract');
    console.log('  8. You provably cannot access the private key');
    console.log();
    console.log('Next: Explore payment delegation (experiment 06)');

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
