/**
 * Experiment 02: Mint a PKP (Programmable Key Pair)
 *
 * This script mints a PKP on the datil-dev network and stores its information
 * for use in future experiments.
 *
 * What we're testing:
 * - Can we mint a PKP on datil-dev?
 * - What information do we get back (tokenId, publicKey, ethAddress)?
 * - Can we save and reload this information?
 *
 * Note: On datil-dev, minting should be gasless for testing.
 *
 * Run with: pnpm exp:02
 */

import { ethers } from 'ethers';
import { LitContracts } from '@lit-protocol/contracts-sdk';
import { LIT_NETWORK, LIT_RPC, AUTH_METHOD_SCOPE, AUTH_METHOD_TYPE } from '@lit-protocol/constants';
import { savePKP, loadPKP } from '../utils/pkp-storage';
import { getFundedTestWallet } from '../utils/test-wallets';

async function main() {
  console.log('=== Experiment 02: Mint a PKP ===\n');

  try {
    // Check if we already have a PKP stored
    console.log('Step 1: Check for existing PKP');
    const existingPKP = await loadPKP();

    if (existingPKP) {
      console.log('  Found existing PKP:');
      console.log('    Token ID:', existingPKP.tokenId);
      console.log('    Public Key:', existingPKP.publicKey.substring(0, 50) + '...');
      console.log('    ETH Address:', existingPKP.ethAddress);
      console.log('    Created:', existingPKP.createdAt);
      console.log('\n  To mint a new PKP, delete the .data/pkp.json file first.');
      return;
    }

    console.log('  No existing PKP found. Minting a new one...\n');

    // Step 2: Setup Ethereum wallet with funds
    console.log('Step 2: Setup Ethereum wallet');

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

    console.log();

    // Step 3: Initialize Lit Contracts SDK
    console.log('Step 3: Initialize Lit Contracts SDK');
    const litContracts = new LitContracts({
      signer: wallet,
      network: LIT_NETWORK.DatilDev,
    });

    await litContracts.connect();
    console.log('  ✓ Connected to Lit Contracts');
    console.log();

    // Step 4: Create auth method
    // We'll use the EthWallet auth method with the wallet we're using to mint
    console.log('Step 4: Create authentication method');

    // For EthWallet auth method, we just need to sign a simple message
    // The auth signature will be generated as part of minting
    const authSig = await wallet.signMessage('Sign to authorize PKP creation');

    const authMethod = {
      authMethodType: AUTH_METHOD_TYPE.EthWallet,
      accessToken: JSON.stringify({ sig: authSig, address: wallet.address }),
    };

    console.log('  ✓ Auth method created (EthWallet)');
    console.log('  ✓ This wallet will be able to use the PKP');
    console.log();

    // Step 5: Mint the PKP with auth method
    console.log('Step 5: Minting PKP with auth method (this may take a minute)...');
    console.log('  Scopes: SignAnything (allows signing any data)');

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

    // Step 6: Save PKP info for future experiments
    console.log('Step 6: Save PKP information');
    await savePKP({
      tokenId: pkpInfo.tokenId,
      publicKey: pkpInfo.publicKey,
      ethAddress: pkpInfo.ethAddress,
    });

    console.log('\n✅ Success! PKP minted and saved with auth method.');
    console.log('\nFindings:');
    console.log('- PKP minting with auth method works on datil-dev');
    console.log('- Auth method type: EthWallet (our test wallet can use it)');
    console.log('- Scope: SignAnything (can sign any data)');
    console.log('- We have a PKP token ID, public key, and derived ETH address');
    console.log('\nNext steps:');
    console.log('- Run experiment 03 to derive keys using this PKP');
    console.log('- The PKP is now authorized to sign with our wallet');

  } catch (error) {
    console.error('\n❌ Error:', error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Stack:', error.stack);
    }
    throw error;
  }
}

// Run the experiment
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
