import { GhostRequestBootstrap, GhostResponse, BootstrapResponseData } from '../params';
import { type GhostContext, EntropySig, Entropy } from '../context';

import { arrayify, keccak256, concat, hexlify } from '@monorepo/core/sandboxed';

function litEcdsaSigToEthSig(sig: string): EntropySig {
  const sigObj = JSON.parse(sig) as EntropySig;
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
export async function handleBootstrap(request: GhostRequestBootstrap, ctx: GhostContext): Promise<GhostResponse<BootstrapResponseData>> {
  const accessControlConditions = ctx.litCidAccessControl();
  const currentCid = ctx.getCurrentIPFSCid();
  const encryptResult = await ctx.makeEntropy(request.pkpEthAddress, request.tgApiSecret);

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
  entropy: Entropy
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
    gasLimit: hexlify(1000000),
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
