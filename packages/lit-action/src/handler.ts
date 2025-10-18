/**
 * Main request handler for Lit Action
 * Pattern matches on ghostRequest type and executes appropriate logic
 */

import './lit-interfaces'; // Import to ensure global type definitions are loaded
import { type JsParams, GhostRequestEcho, GhostRequestBootstrap, GhostResponse } from './params';
import type { GhostContext } from './context';
import { randomBytes, arrayify, keccak256, concat, hexlify } from '@monorepo/core/sandboxed';
/**
 * Main request handler
 * Takes validated jsParams and context, returns a response
 * Does NOT call Lit.Actions.setResponse - that's done in main()
 *
 * @param jsParams - Validated parameters passed to the Lit Action
 * @param _ctx - Runtime context with provider and contract instances (unused for now)
 */
export async function handleRequest(
  {ghostRequest}: JsParams,
  ctx: GhostContext
): Promise<GhostResponse> {
  try {
    switch( ghostRequest.type ) {
      case 'echo': return handleEcho(ghostRequest as GhostRequestEcho);
      case 'bootstrap': return await handleBootstrap(ghostRequest as GhostRequestBootstrap, ctx);
      default: return { ok: false, error: `Unknown request type: ${(ghostRequest as any).type}` };
    }
  } catch (error) {
    console.error('Error in handleRequest:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Individual Request Handlers
// ============================================================================

/**
 * Handle echo request - simple test that returns the message
 */
function handleEcho(request: GhostRequestEcho): GhostResponse {
  return {
    ok: true,
    data: {
      echo: request.message,
      timestamp: Date.now(),
    },
  };
}

interface Sig {
  v: number;
  r: string;
  s: string;
}

function litEcdsaSigToEthSig(sig: string): Sig {
  const sigObj = JSON.parse(sig) as Sig;
  return {
    v: sigObj.v + 27,
    r: '0x' + sigObj.r.slice(2),  // Lit returns SECG prefixed compressed public key! So 0x02 or 0x03 prefix,
    s: '0x' + sigObj.s
  }
}

/**
 * Handle bootstrap request - generates entropy, encrypts it, and signs it
 * This initializes the system with a secret that only this Lit Action can decrypt
 *
 * IMPORTANT: This now calls setEntropy on-chain from within the TEE
 */
async function handleBootstrap(request: GhostRequestBootstrap, ctx: GhostContext): Promise<GhostResponse> {
  const currentCid = ctx.getCurrentIPFSCid();
  const accessControlConditions = ctx.litCidAccessControl(currentCid);

  const encryptResultJson = await Lit.Actions.runOnce({waitForResponse: true, name: "generate-entropy"}, async () => {
    const entropy = hexlify(randomBytes(32));
    let encryptResult = await Lit.Actions.encrypt({
      accessControlConditions,
      to_encrypt: new TextEncoder().encode(entropy),
    });
    return JSON.stringify({encryptResult, entropy});
  });
  const {entropy,encryptResult} = JSON.parse(encryptResultJson!);

  const decrypted = await Lit.Actions.decryptAndCombine({
    accessControlConditions,
    ciphertext: encryptResult.ciphertext,
    dataToEncryptHash: encryptResult.dataToEncryptHash,
    authSig: null,
    chain: 'ethereum'
  });
  if( decrypted !== entropy ) {
    throw new Error("Could not decrypt entropy, round-trip fails!");
  }
  ctx.setEntropy(decrypted, request.pkpEthAddress);

  // Get the manager to extract teePublicKey
  const manager = await ctx.getManager();
  const teeEncPublicKey = hexlify(manager.teePublicKey);

  const dataHashBytes = arrayify('0x'+encryptResult.dataToEncryptHash);
  const ciphertextBytes = new TextEncoder().encode(encryptResult.ciphertext);
  const cidBytes = new TextEncoder().encode(currentCid);
  const toSign = arrayify(keccak256(concat([dataHashBytes, ciphertextBytes, cidBytes])));
  const signature = litEcdsaSigToEthSig(await Lit.Actions.signAndCombineEcdsa({
    toSign,
    publicKey: request.pkpPublicKey,
    sigName: 'bootstrap-sig',
  }));

  // Construct and sign the setEntropy transaction
  const txHash = await sendSetEntropyTransaction(
    ctx,
    request.pkpPublicKey,
    request.pkpEthAddress,
    {
      ciphertext: encryptResult.ciphertext,
      digest: '0x' + encryptResult.dataToEncryptHash,
      ipfsCid: currentCid,
      sig: signature,
      teeEncPublicKey: teeEncPublicKey,
    }
  );

  return {
    ok: true,
    data: {
      pkp: request.pkpPublicKey,
      accessControlConditions,
      dataToEncryptHash: encryptResult.dataToEncryptHash,
      ciphertext: encryptResult.ciphertext,
      encryptResult: encryptResult,
      signature: signature,
      currentCid,
      teeEncPublicKey,
      setEntropyTxHash: txHash,
    },
  }
}

/**
 * Construct, sign, and broadcast setEntropy transaction from within the TEE
 */
async function sendSetEntropyTransaction(
  ctx: GhostContext,
  pkpPublicKey: string,
  pkpEthAddress: string,
  entropy: {
    ciphertext: string;
    digest: string;
    ipfsCid: string;
    sig: { v: number; r: string; s: string };
    teeEncPublicKey: string;
  }
): Promise<string> {
  // Get current nonce and gas price
  const nonce = await ctx.provider.getTransactionCount(pkpEthAddress, 'pending');
  const feeData = await ctx.provider.getFeeData();

  // Encode the setEntropy call data using the contract's interface
  const setEntropyData = ctx.ghost.interface.encodeFunctionData('setEntropy', [entropy]);

  // Construct the transaction
  const tx = {
    to: ctx.ghost.address,
    nonce,
    gasLimit: hexlify(450000), // Same as bootstrap script
    data: setEntropyData,
    chainId: (await ctx.provider.getNetwork()).chainId,
    // EIP-1559 transaction
    maxFeePerGas: feeData.maxFeePerGas || undefined,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
    type: 2,
  };

  // Serialize the transaction for signing (without signature)
  const ethers = (globalThis as any).ethers;
  const unsignedTx = ethers.utils.serializeTransaction(tx);
  const txHash = keccak256(unsignedTx);

  // Sign the transaction hash with the PKP
  const signature = litEcdsaSigToEthSig(await Lit.Actions.signAndCombineEcdsa({
    toSign: arrayify(txHash),
    publicKey: pkpPublicKey,
    sigName: 'setEntropy-tx-sig',
  }));

  // Serialize the signed transaction
  const signedTx = ethers.utils.serializeTransaction(tx, signature);

  // Broadcast the transaction
  const txResponse = await ctx.provider.sendTransaction(signedTx);

  console.log('setEntropy transaction sent:', txResponse.hash);

  // Wait for confirmation
  await txResponse.wait();

  console.log('setEntropy transaction confirmed!');

  return txResponse.hash;
}
