import { GhostRequestBootstrap, GhostResponse, BootstrapResponseData } from '../params';
import { type GhostContext, Entropy } from '../context';

import { arrayify, keccak256, concat, hexlify } from '@monorepo/core/sandboxed';

/**
 * Handle bootstrap request - generates entropy, encrypts it, and signs it
 * This initializes the system with a secret that only this Lit Action can decrypt
 *
 * IMPORTANT: This now calls setEntropy on-chain from within the TEE
 */
export async function handleBootstrap(request: GhostRequestBootstrap, ctx: GhostContext): Promise<GhostResponse<BootstrapResponseData>> {
  const accessControlConditions = ctx.litCidAccessControl();
  const currentCid = ctx.getCurrentIPFSCid();
  const encryptResult = await ctx.makeEntropy(request.pkpEthAddress, request.pkpPublicKey, request.tgApiSecret);

  // Get the manager to extract teePublicKey
  const manager = await ctx.getManager();
  const teeEncPublicKey = hexlify(manager.teePublicKey);

  const dataHashBytes = arrayify('0x'+encryptResult.dataToEncryptHash);
  const ciphertextBytes = new TextEncoder().encode(encryptResult.ciphertext);
  const cidBytes = new TextEncoder().encode(currentCid);
  const toSign = arrayify(keccak256(concat([dataHashBytes, ciphertextBytes, cidBytes])));
  const signature = ctx.litEcdsaSigToEthSig(await Lit.Actions.signAndCombineEcdsa({
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

  // Clear entropy and reload from chain to verify everything matches
  ctx.clearEntropy();

  // Fetch on-chain entropy FIRST (before attempting to decrypt)
  const onChainEntropy = await ctx.ghost.getEntropy() as Entropy;

  // Verify on-chain data matches what we sent (before attempting decrypt)
  const ciphertextMatches = onChainEntropy.ciphertext === encryptResult.ciphertext;
  const digestMatches = onChainEntropy.digest === ('0x' + encryptResult.dataToEncryptHash);
  const cidMatches = onChainEntropy.ipfsCid === currentCid;
  const sigVMatches = onChainEntropy.sig.v === signature.v;
  const sigRMatches = onChainEntropy.sig.r === signature.r;
  const sigSMatches = onChainEntropy.sig.s === signature.s;
  const teeEncPublicKeyOnChainMatches = onChainEntropy.teeEncPublicKey === teeEncPublicKey;

  if (!ciphertextMatches) {
    throw new Error('Verification failed: ciphertext mismatch');
  }
  if (!digestMatches) {
    throw new Error('Verification failed: digest mismatch');
  }
  if (!cidMatches) {
    throw new Error('Verification failed: ipfsCid mismatch');
  }
  if (!sigVMatches || !sigRMatches || !sigSMatches) {
    throw new Error('Verification failed: signature mismatch');
  }
  if (!teeEncPublicKeyOnChainMatches) {
    throw new Error('Verification failed: teeEncPublicKey mismatch');
  }

  // NOW attempt to decrypt and reload entropy
  let reloadedPrivateParams: any;
  let reloadedTeeEncPublicKey: string;

  try {
    reloadedPrivateParams = await ctx.getPrivateParams();
    const reloadedManager = await ctx.getManager();
    reloadedTeeEncPublicKey = hexlify(reloadedManager.teePublicKey);

    // Verify all reloaded values match
    const pkpPublicKeyMatches = ctx.pkpPublicKey === request.pkpPublicKey;
    const pkpEthAddressMatches = ctx.pkpEthAddress === request.pkpEthAddress;
    const teeEncPublicKeyReloadMatches = reloadedTeeEncPublicKey === teeEncPublicKey;
    const tgApiSecretMatches = reloadedPrivateParams.tgApiSecret === request.tgApiSecret;

    if (!pkpPublicKeyMatches) throw new Error('Verification failed: pkpPublicKey mismatch after reload');
    if (!pkpEthAddressMatches) throw new Error('Verification failed: pkpEthAddress mismatch after reload');
    if (!teeEncPublicKeyReloadMatches) throw new Error('Verification failed: teeEncPublicKey mismatch after reload');
    if (!tgApiSecretMatches) throw new Error('Verification failed: tgApiSecret mismatch after reload');
  } catch (error) {
    throw new Error('Failed to decrypt and reload entropy: ' + (error as any)?.message);
  }

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

  // Wait for the tx to be mined
  return await ctx.signAndSendTx(pkpPublicKey, tx, true);
}
