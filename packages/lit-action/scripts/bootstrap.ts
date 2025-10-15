/**
 * Production Bootstrap Script
 *
 * This script:
 * 1. Uses the production Lit Action handler (with mock crypto)
 * 2. Mints a PKP restricted to the Lit Action IPFS CID
 * 3. Executes the bootstrap handler to generate, encrypt, and sign entropy
 * 4. Returns the encrypted data and signature for storage on-chain
 *
 * Run with: pnpm bootstrap
 */

import { ethers } from 'ethers';
import { LitContracts } from '@lit-protocol/contracts-sdk';
import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_NETWORK, LIT_RPC, AUTH_METHOD_SCOPE, AUTH_METHOD_TYPE, LIT_ABILITY } from '@lit-protocol/constants';
import {
  createSiweMessage,
  generateAuthSig,
  LitActionResource,
  LitPKPResource,
} from '@lit-protocol/auth-helpers';
import { getFundedTestWallet } from './utils/test-wallets';
import { createLitClient } from './utils/lit-client';

// @ts-ignore - ipfs-only-hash doesn't have type definitions
import Hash from 'ipfs-only-hash';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ES module __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read the built Lit Action code
const litActionPath = path.join(__dirname, '../dist/lit-action.development.js');

const network = LIT_NETWORK.DatilDev;

export async function getSessionSigsForPKP(
  litNodeClient: LitNodeClient,
  wallet: ethers.Wallet,
  pkpTokenId: string,
  ipfsCid: string
) {
  console.log('Generating session signatures for PKP signing...');

  const sessionSigs = await litNodeClient.getSessionSigs({
    chain: 'ethereum',
    expiration: new Date(Date.now() + 1000 * 60 * 10).toISOString(), // 10 minutes
    resourceAbilityRequests: [
      {
        resource: new LitActionResource(ipfsCid),
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

async function mintRestricted (litContracts:LitContracts, ipfsCid:string) {
  const ipfsCidBytes = ethers.utils.base58.decode(ipfsCid);
  const mintCost = await litContracts.pkpNftContract.read.mintCost();

  console.log('  Mint cost:', ethers.utils.formatEther(mintCost), 'ETH');

  const tx = await litContracts.pkpHelperContract.write.mintNextAndAddAuthMethods(
    2, // keyType (ECDSA)
    [AUTH_METHOD_TYPE.LitAction],
    [ipfsCidBytes],
    ['0x'],
    [[AUTH_METHOD_SCOPE.SignAnything]],
    false,
    false,
    { value: mintCost }
  );

  console.log('  Transaction hash:', tx.hash);
  const receipt = await tx.wait();
  console.log('  ✓ Transaction confirmed');

  // Extract PKP info
  const transferEvents = receipt.events?.filter((e: any) => {
    return e.topics && e.topics[0] === ethers.utils.id('Transfer(address,address,uint256)');
  });

  if (!transferEvents || transferEvents.length === 0) {
    throw new Error('Could not find any Transfer events in transaction receipt');
  }

  const pkpTransfer = transferEvents[transferEvents.length - 1];
  const tokenId = ethers.BigNumber.from(pkpTransfer.topics[3]).toHexString()
  const publicKey = await litContracts.pkpNftContract.read.getPubkey(tokenId);
  const ethAddress = ethers.utils.computeAddress(publicKey);  

  return {
    tokenId: ethers.utils.hexZeroPad(tokenId, 32),
    publicKey: publicKey.slice(2),
    ethAddress
  }
}

async function main() {
  console.log('=== Production Bootstrap Script ===\n');

  let litClient: LitNodeClient | null = null;

  try {
    // Step 1: Read and compute IPFS CID of the Lit Action
    console.log('Step 1: Load Lit Action code');

    if (!fs.existsSync(litActionPath)) {
      throw new Error(`Lit Action not built. Run 'pnpm build' first. Looking for: ${litActionPath}`);
    }

    // Step 2: Setup Ethereum wallet
    console.log('Step 2: Setup Ethereum wallet');
    const provider = new ethers.providers.JsonRpcProvider(LIT_RPC.CHRONICLE_YELLOWSTONE);
    const wallet = getFundedTestWallet(provider);
    const balance = await wallet.getBalance();

    console.log('  Wallet Address:', wallet.address);
    console.log('  Balance:', ethers.utils.formatEther(balance), 'testnet ETH');

    if (balance.isZero()) {
      console.log('\n⚠️  Wallet has zero balance!');
      console.log('Send testnet funds to:', wallet.address);
      return;
    }
    console.log();

    // Step 3: Initialize Lit Contracts SDK
    console.log('Step 3: Initialize Lit Contracts SDK');
    const litContracts = new LitContracts({signer: wallet, network: network});
    await litContracts.connect();
    console.log('  ✓ Connected to Lit Contracts');

    const litActionCode = fs.readFileSync(litActionPath, 'utf8');
    const ipfsCid = await Hash.of(litActionCode);    
    console.log('  Lit Action path:', litActionPath);
    console.log('  Lit Action size:', litActionCode.length, 'bytes');
    console.log('  IPFS CID:', ipfsCid);
    console.log();

    const pkp = await mintRestricted(litContracts, ipfsCid);

    console.log('  ✅ PKP Minted!');
    console.log('    Token ID:', pkp.tokenId);
    console.log('    Public Key:', pkp.publicKey);
    console.log('    ETH Address:', pkp.ethAddress);
    console.log('    Restricted to IPFS CID:', ipfsCid);
    console.log();

    // Step 5: Connect to Lit Protocol
    console.log('Step 5: Connect to Lit Protocol');
    litClient = await createLitClient(network, true);

    // Step 6: Get session signatures
    console.log('Step 6: Get session signatures');
    const sessionSigs = await getSessionSigsForPKP(litClient, wallet, pkp.tokenId, ipfsCid);
    console.log('  ✓ Session signatures obtained');
    console.log();

    // Step 7: Execute the bootstrap Lit Action
    console.log('Step 7: Execute bootstrap Lit Action');

    const result = await litClient.executeJs({
      code: litActionCode,
      sessionSigs,
      jsParams: {
        ///*
        ghostRequest: {
          type: 'bootstrap',
          pkpPublicKey: pkp.publicKey,
        },
        //*/
        //publicKey: pkp.publicKey,
      },
    });

    let response;
    if (typeof result.response === 'string') {
      response = JSON.parse(result.response);
    } else {
      response = result.response;
    }

    if (!response.ok) {
      console.log('  ❌ Error:', response.error);
      if (response.details) {
        console.log('  Details:', response.details);
      }
      return;
    }

    const data = response.data;

    console.log('  ✅ Success!');
    console.log();
    console.log('  Results:');
    console.log('    Current CID:', data.currentCid);
    console.log('    Matches expected:', data.currentCid === ipfsCid);
    console.log('    Entropy preview:', data.entropyPreview);
    console.log('    Ciphertext length:', data.ciphertext.length, 'chars');
    console.log('    Data hash:', data.dataToEncryptHash);
    console.log('    Signature:', data.signature);
    console.log('    Warning:', data.warning);
    console.log();

    console.log('✅ Bootstrap complete!\n');
    console.log('='.repeat(80));
    console.log('PKP INFORMATION (save this):');
    console.log('='.repeat(80));
    console.log('Token ID:', pkp.tokenId);
    console.log('Public Key:', pkp.publicKey);
    console.log('ETH Address:', pkp.ethAddress);
    console.log('IPFS CID:', ipfsCid);
    console.log();
    console.log('='.repeat(80));
    console.log('ENCRYPTED ENTROPY (store on-chain):');
    console.log('='.repeat(80));
    console.log('Ciphertext:', data.ciphertext);
    console.log('Data Hash:', data.dataToEncryptHash);
    console.log('Signature:', data.signature);
    console.log('Signature R:', data.signatureR);
    console.log('Signature S:', data.signatureS);
    console.log('Signature V:', data.signatureV);
    console.log('='.repeat(80));
    console.log();

  }
  finally {
    if (litClient) {
      console.log('\nCleaning up...');
      litClient.disconnect();
      console.log('✓ Disconnected from Lit Protocol');
    }
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
