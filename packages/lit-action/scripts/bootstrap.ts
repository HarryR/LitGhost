/**
 * Production Bootstrap Script
 *
 * This script:
 * 1. Uses the production Lit Action handler (with mock crypto)
 * 2. Mints a PKP restricted to the Lit Action IPFS CID
 * 3. Executes the bootstrap handler to generate, encrypt, and sign entropy
 * 4. Returns the encrypted data and signature for storage on-chain
 *
 * Usage:
 *   tsx scripts/bootstrap.ts --network <network> --mode <mode> --output <file>
 *
 * Options:
 *   --network  Lit network (see LIT_NETWORK_VALUES)
 *   --mode     Environment mode (development, production)
 *   --output   Output JSON file path
 */

import { ethers } from 'ethers';
import { LitContracts } from '@lit-protocol/contracts-sdk';
import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_NETWORK, LIT_RPC, AUTH_METHOD_SCOPE, AUTH_METHOD_TYPE, LIT_NETWORK_VALUES, LIT_ABILITY } from '@lit-protocol/constants';
import { LitGhost } from '@monorepo/core';
import {
  createSiweMessage,
  generateAuthSig,
  LitActionResource,
} from '@lit-protocol/auth-helpers';
import { getFundedTestWallet } from './utils/test-wallets';
import { createLitClient } from './utils/lit-client';

// @ts-ignore - ipfs-only-hash doesn't have type definitions
import Hash from 'ipfs-only-hash';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import FormData from 'form-data';

// ES module __dirname replacement
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command-line arguments
interface BootstrapConfig {
  network: LIT_NETWORK_VALUES;
  mode: 'development' | 'production';
  outputFile: string;
  debug: boolean;
  privateKey?: string;
  privateKeyEnvVar: string;
}

function parseArgs(): BootstrapConfig {
  const args = process.argv.slice(2);
  const config: Partial<BootstrapConfig> = {
    debug: false, // Default value
    privateKeyEnvVar: 'DEPLOYER_PRIVATE_KEY', // Default env var name
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    if (arg === '--network' && nextArg) {
      config.network = nextArg as LIT_NETWORK_VALUES;
      i++;
    } else if (arg === '--mode' && nextArg) {
      if (nextArg !== 'development' && nextArg !== 'production') {
        throw new Error(`Invalid mode: ${nextArg}. Must be 'development' or 'production'`);
      }
      config.mode = nextArg as 'development' | 'production';
      i++;
    } else if (arg === '--output' && nextArg) {
      config.outputFile = nextArg;
      i++;
    } else if (arg === '--private-key' && nextArg) {
      config.privateKey = nextArg;
      i++;
    } else if (arg === '--private-key-env' && nextArg) {
      config.privateKeyEnvVar = nextArg;
      i++;
    } else if (arg === '--debug') {
      config.debug = true;
    } else if (arg === '--help' || arg === '-h') {
      const validNetworks = Object.values(LIT_NETWORK).join(', ');
      console.log(`
Usage: tsx scripts/bootstrap.ts --network <network> --mode <mode> --output <file> [options]

Required Options:
  --network <network>     Lit network. Valid values: ${validNetworks}
  --mode <mode>           Environment mode (development, production)
  --output <file>         Output JSON file path

Optional:
  --private-key <key>     Private key for deployer wallet (for testing)
  --private-key-env <var> Env var name for private key (default: DEPLOYER_PRIVATE_KEY)
  --debug                 Enable debug logging (default: false)
  --help, -h              Show this help message

Environment Variables (from .env.{mode}):
  VITE_CHAIN              Chain name for RPC (e.g., sepolia, ethereum)
  VITE_CONTRACT_LITGHOST  LitGhost contract address
  DEPLOYER_PRIVATE_KEY    Private key for deployer wallet (or specify with --private-key-env)

Examples:
  tsx scripts/bootstrap.ts --network datil-dev --mode development --output bootstrap-output.json
  tsx scripts/bootstrap.ts --network datil --mode production --output output.json --debug
  tsx scripts/bootstrap.ts --network datil-dev --mode development --output test.json --private-key 0xabc...
      `);
      process.exit(0);
    }
  }

  // Validate required arguments
  if (!config.network) {
    throw new Error('Missing required argument: --network');
  }
  if (!config.mode) {
    throw new Error('Missing required argument: --mode');
  }
  if (!config.outputFile) {
    throw new Error('Missing required argument: --output');
  }

  // Validate network value
  const validNetworks = Object.values(LIT_NETWORK) as LIT_NETWORK_VALUES[];
  if (!validNetworks.includes(config.network)) {
    throw new Error(
      `Invalid network: ${config.network}. Must be one of: ${validNetworks.join(', ')}`
    );
  }

  return config as BootstrapConfig;
}

function loadEnvFile(mode: 'development' | 'production') {
  const envPath = path.join(__dirname, `../.env.${mode}`);
  const envLocalPath = path.join(__dirname, `../.env.${mode}.local`);

  if (fs.existsSync(envPath)) {
    console.log(`Loading environment from: .env.${mode}`);
    config({ path: envPath });
  } else {
    console.warn(`Warning: .env.${mode} file not found at ${envPath}`);
  }

  // Load .env.{mode}.local to override/add secrets (e.g., Pinata API keys)
  if (fs.existsSync(envLocalPath)) {
    console.log(`Loading local environment overrides from: .env.${mode}.local`);
    config({ path: envLocalPath, override: true });
  }
}

/**
 * Update the app's .env.{mode} file with the IPFS CID
 */
function updateAppEnvFile(mode: string, ipfsCid: string) {
  const appEnvPath = path.join(__dirname, `../../app/.env.${mode}`);

  if (!fs.existsSync(appEnvPath)) {
    console.log(`  ⚠️  App .env.${mode} file not found at ${appEnvPath}`);
    return;
  }

  try {
    let envContent = fs.readFileSync(appEnvPath, 'utf8');
    const varName = 'VITE_GHOST_IPFSCID';
    const newLine = `${varName}=${ipfsCid}`;

    // Check if the variable already exists
    const regex = new RegExp(`^${varName}=.*$`, 'm');
    if (regex.test(envContent)) {
      // Replace existing value
      envContent = envContent.replace(regex, newLine);
      console.log(`  ✓ Updated ${varName} in packages/app/.env.${mode}`);
    } else {
      // Add new line
      envContent = envContent.trim() + '\n' + newLine + '\n';
      console.log(`  ✓ Added ${varName} to packages/app/.env.${mode}`);
    }

    fs.writeFileSync(appEnvPath, envContent, 'utf8');
  } catch (error: any) {
    console.log(`  ❌ Failed to update app .env file:`, error.message);
  }
}

/**
 * Pin Lit Action to IPFS using Pinata's dedicated gateway
 * Uses standard IPFS HTTP API to ensure CID matches ipfs-only-hash
 * Requires PINATA_JWT environment variable
 */
async function pinToIPFS(code: string, mode: string): Promise<string | null> {
  const pinataJwt = process.env.PINATA_JWT;

  if (!pinataJwt) {
    console.log('  ⚠️  Skipping IPFS pinning: PINATA_JWT not set in .env.{mode}.local');
    return null;
  }

  console.log('  Pinning Lit Action to IPFS via Pinata...');

  // Add to IPFS using Pinata's API with form-data
  const form = new FormData();
  form.append('file', Buffer.from(code, 'utf8'), {
    filename: `lit-action-${mode}.js`,
    contentType: 'application/javascript',
  });

  // Use a Promise-based approach with form-data's submit method
  const addData: any = await new Promise((resolve, reject) => {
    form.submit({
      protocol: 'https:',
      host: 'api.pinata.cloud',
      path: '/pinning/pinFileToIPFS',
      headers: {
        'Authorization': `Bearer ${pinataJwt}`,
      },
    }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }

      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(JSON.parse(data));
        }
      });
      res.on('error', reject);
    });
  });

  const cid = addData.IpfsHash;

  console.log('  ✅ Pinned to IPFS!');
  console.log('    CID:', cid);
  console.log('    Pinata URL:', `https://gateway.pinata.cloud/ipfs/${cid}`);

  return cid;
}

export async function getSessionSigsForAction(
  litNodeClient: LitNodeClient,
  wallet: ethers.Wallet,
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
      // XXX: This is weird... an empty LitAction resource ability is required!
      //      Otherwise decryption fails in the 'bootstrap' LitAction handler
      {
        resource: new LitActionResource(''),
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
  console.log('=== Bootstrap Script ===\n');

  let litClient: LitNodeClient | null = null;

  try {
    // Parse command-line arguments
    const bootstrapConfig = parseArgs();
    console.log('Configuration:');
    console.log('  Network:', bootstrapConfig.network);
    console.log('  Mode:', bootstrapConfig.mode);
    console.log('  Output File:', bootstrapConfig.outputFile);
    console.log('  Debug:', bootstrapConfig.debug);
    console.log();

    // Load environment file
    loadEnvFile(bootstrapConfig.mode);

    // Determine lit action path based on mode
    const litActionPath = path.join(__dirname, `../dist/lit-action.${bootstrapConfig.mode}.js`);

    if (!fs.existsSync(litActionPath)) {
      throw new Error(`Lit Action not built. Run 'pnpm build' first. Looking for: ${litActionPath}`);
    }
  
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

    // Initialize Lit Contracts SDK
    const litContracts = new LitContracts({signer: wallet, network: bootstrapConfig.network});
    await litContracts.connect();

    const litActionCode = fs.readFileSync(litActionPath, 'utf8');
    const ipfsCid = await Hash.of(litActionCode);
    console.log('  Lit Action path:', litActionPath);
    console.log('  Lit Action size:', litActionCode.length, 'bytes');
    console.log('  IPFS CID:', ipfsCid);
    console.log();

    // Step 4: Pin to IPFS via Pinata (optional) and update app .env
    console.log('Step 4: Pin Lit Action to IPFS and update app config');
    const pinataCid = await pinToIPFS(litActionCode, bootstrapConfig.mode);
    if (pinataCid && pinataCid !== ipfsCid) {
      console.log('  ⚠️  Warning: Pinata CID does not match computed CID!');
      console.log('    Computed:', ipfsCid);
      console.log('    Pinata:', pinataCid);
    }

    // Update app's .env file with the IPFS CID
    updateAppEnvFile(bootstrapConfig.mode, ipfsCid);
    console.log();

    // Step 5: Mint PKP restricted to Lit Action
    console.log('Step 5: Mint PKP restricted to Lit Action');
    const pkp = await mintRestricted(litContracts, ipfsCid);

    console.log('  ✅ PKP Minted!');
    console.log('    Token ID:', pkp.tokenId);
    console.log('    Public Key:', pkp.publicKey);
    console.log('    ETH Address:', pkp.ethAddress);
    console.log('    Restricted to IPFS CID:', ipfsCid);
    console.log();

    // Step 6: Connect to Lit Protocol
    console.log('Step 6: Connect to Lit Protocol');
    litClient = await createLitClient(bootstrapConfig.network, bootstrapConfig.debug);

    // Step 7: Get session signatures
    console.log('Step 7: Get session signatures');
    const sessionSigs = await getSessionSigsForAction(litClient, wallet, ipfsCid);
    console.log('  ✓ Session signatures obtained');
    console.log();

    // Step 8: Execute the bootstrap Lit Action
    console.log('Step 8: Execute bootstrap Lit Action');

    const result = await litClient.executeJs({
      code: litActionCode,
      sessionSigs,
      jsParams: {
        ghostRequest: {
          type: 'bootstrap',
          pkpPublicKey: pkp.publicKey,
        },
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
    console.log('          Current CID:', data.currentCid);
    console.log('     Matches expected:', data.currentCid === ipfsCid);
    console.log('    Ciphertext length:', data.ciphertext.length, 'chars');
    console.log('            Data hash:', data.dataToEncryptHash);
    console.log('            Signature:', data.signature);
    console.log('       Access Control:', data.accessControlConditions);
    console.log();

    // Verify signature
    console.log('  Verifying signature...');
    try {
      const sig = data.signature;

      // Reconstruct the message that was signed (same as in handler.ts)
      const dataHashBytes = ethers.utils.arrayify('0x' + data.dataToEncryptHash);
      // Ciphertext is base64-encoded, decode it to bytes (same as handler.ts)
      const ciphertextBytes = new TextEncoder().encode(data.ciphertext);
      const cidBytes = new TextEncoder().encode(data.currentCid);
      const messageBytes = ethers.utils.concat([dataHashBytes, ciphertextBytes, cidBytes]);
      const messageHash = ethers.utils.keccak256(messageBytes);

      // Recover the signer address from the signature
      const recoveredAddress = ethers.utils.recoverAddress(messageHash, {
        r: sig.r,
        s: sig.s,
        v: sig.v,
      });

      console.log('    Recovered Address:', recoveredAddress);
      console.log('    Expected Address:', pkp.ethAddress);
      console.log('    Signature Valid:', recoveredAddress.toLowerCase() === pkp.ethAddress.toLowerCase());

      if (recoveredAddress.toLowerCase() !== pkp.ethAddress.toLowerCase()) {
        throw new Error(`Signature verification failed! Recovered ${recoveredAddress} but expected ${pkp.ethAddress}`);
      }

      console.log('  ✅ Signature verified successfully!');
    } catch (error: any) {
      console.log('  ❌ Signature verification error:', error.message);
      throw error;
    }
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
    console.log('Signature:', JSON.stringify(data.signature));
    console.log('='.repeat(80));
    console.log();

    // Step 9: Store entropy on LitGhost contract
    console.log('Step 9: Store entropy on LitGhost contract');

    // Get chain and contract address from env
    const chainName = process.env.VITE_CHAIN;
    const litGhostAddress = process.env.VITE_CONTRACT_LITGHOST;

    if (!chainName || !litGhostAddress) {
      console.log('  ⚠️  Skipping on-chain storage: VITE_CHAIN or VITE_CONTRACT_LITGHOST not set in .env.' + bootstrapConfig.mode);
      console.log();
    } else {
      // Construct RPC URL
      const rpcUrl = `https://1rpc.io/${chainName}`;
      console.log('  Chain:', chainName);
      console.log('  RPC URL:', rpcUrl);
      console.log('  LitGhost Address:', litGhostAddress);

      // Get deployer wallet
      let deployerPrivateKey = bootstrapConfig.privateKey || process.env[bootstrapConfig.privateKeyEnvVar];
      if (!deployerPrivateKey) {
        console.log('  ⚠️  Skipping on-chain storage: No private key provided (use --private-key or set ' + bootstrapConfig.privateKeyEnvVar + ')');
        console.log();
      } else {
        try {
          // Create provider and wallet
          const chainProvider = new ethers.providers.JsonRpcProvider(rpcUrl);
          const deployerWallet = new ethers.Wallet(deployerPrivateKey, chainProvider);
          console.log('  Deployer Address:', deployerWallet.address);

          // Connect LitGhost contract
          const litGhostContract = LitGhost.connect(deployerWallet).attach(litGhostAddress);

          // The signature from signAndCombineEcdsa uses SECG compressed point format
          // r comes as 03/02 (compression byte) + 32 bytes (x coordinate, which is the actual r value)
          // v is the parity bit (0 or 1)
          // s is the standard s value
          const sig = data.signature;
          console.log('  Signature from Lit:', JSON.stringify(sig));

          // Convert ciphertext ASCII string to bytes using TextEncoder
          // The ciphertext is an ASCII string (implementation detail: currently base64)
          // We encode it as bytes for the contract
          //const ciphertextBytes = new TextEncoder().encode(data.ciphertext);
          //const ciphertextHex = ethers.utils.hexlify(ciphertextBytes);

          // Call setEntropy with individual parameters (avoids struct encoding issues)
          // Manual gas limit needed because estimation fails for SSTORE operations
          // The ciphertext storage alone needs ~20k per 32 bytes, plus struct overhead
          console.log('  Calling setEntropy...');
          const tx = await litGhostContract.setEntropy({
            ciphertext: data.ciphertext,
            digest: '0x' + data.dataToEncryptHash,
            ipfsCid,
            sig,
            }, { gasLimit: 450000 } // XXX: gas estimation fails?
          );
          console.log('  Transaction hash:', tx.hash);

          const receipt = await tx.wait();
          console.log('  ✓ Transaction confirmed in block:', receipt.blockNumber);
          console.log('  Gas used:', receipt.gasUsed.toString());
          console.log();

          // Step 9: Write output to JSON file
          console.log('Step 9: Write bootstrap data to file');
          const outputData = {
            network: bootstrapConfig.network,
            mode: bootstrapConfig.mode,
            timestamp: new Date().toISOString(),
            pkp: {
              tokenId: pkp.tokenId,
              publicKey: pkp.publicKey,
              ethAddress: pkp.ethAddress,
            },
            litAction: {
              ipfsCid,
              path: litActionPath,
              size: litActionCode.length,
            },
            encryptedData: {
              ciphertext: data.ciphertext,
              dataHash: data.dataToEncryptHash,
              signature: data.signature,
              accessControlConditions: data.accessControlConditions,
            },
            onchain: {
              chain: chainName,
              rpcUrl,
              litGhostAddress,
              setEntropyTx: {
                hash: tx.hash,
                blockNumber: receipt.blockNumber,
                gasUsed: receipt.gasUsed.toString(),
              },
            },
          };

          fs.writeFileSync(bootstrapConfig.outputFile, JSON.stringify(outputData, null, 2), 'utf8');
          console.log('  ✓ Bootstrap data written to:', bootstrapConfig.outputFile);
          console.log();
        } catch (error: any) {
          console.log('  ❌ Error storing entropy on-chain:', error.message);
          console.log('  Bootstrap failed - entropy must be stored on-chain to complete bootstrap');
          throw error;
        }
      }
    }

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
