import { GhostRequestSubmitDeposit, GhostResponse, SubmitDepositResponseData } from '../params';
import { type GhostContext } from '../context';
import { hexlify } from '@monorepo/core/sandboxed';

/**
 * Handle submit-deposit request - submits ERC-3009 deposit transaction and processes it
 *
 * Flow:
 * 1. Check bot has enough ETH for gas
 * 2. Estimate gas for depositERC3009 transaction
 * 3. Submit depositERC3009 transaction (bot pays gas)
 * 4. Wait for transaction confirmation
 * 5. Run manager.step() with 10s time budget to process the deposit
 * 6. Estimate gas and submit the update transaction
 *
 * @param request - The submit-deposit request with depositTo and auth3009 parameters
 * @param ctx - GhostContext with contracts and provider
 * @returns Response with both transaction hashes
 */
export async function handleSubmitDeposit(
  request: GhostRequestSubmitDeposit,
  ctx: GhostContext
): Promise<GhostResponse<SubmitDepositResponseData>> {
  try {
    // Initialize context (recover PKP keys from entropy signature)
    await ctx.entropy();

    const pkpEthAddress = ctx.pkpEthAddress;
    const pkpPublicKey = ctx.pkpPublicKey;

    // Step 1: Construct depositERC3009 transaction parameters
    const depositToSol = {
      rand: request.depositTo.rand,
      user: request.depositTo.user,
    };

    const auth3009Sol = {
      from: request.auth3009.from,
      value: request.auth3009.value,
      validAfter: request.auth3009.validAfter,
      validBefore: request.auth3009.validBefore,
      sig: {
        v: request.auth3009.sig.v,
        r: request.auth3009.sig.r,
        s: request.auth3009.sig.s,
      },
    };

    // Step 2: Estimate gas for deposit transaction
    const estimatedDepositGas = await ctx.ghost.estimateGas.depositERC3009(
      depositToSol,
      auth3009Sol,
      {
        from: pkpEthAddress
      }
    );

    // Add 20% buffer to gas estimate
    const depositGasLimit = estimatedDepositGas.mul(120).div(100);

    // Check bot has enough ETH balance for gas
    const feeData = await ctx.provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas;
    if (!maxFeePerGas) {
      return {
        ok: false,
        error: 'Could not get gas price from network',
      };
    }

    const estimatedDepositCost = depositGasLimit.mul(maxFeePerGas);
    const balance = await ctx.provider.getBalance(pkpEthAddress);

    if (balance.lt(estimatedDepositCost)) {
      return {
        ok: false,
        error: `Insufficient gas: bot has ${hexlify(balance)} wei, needs ${hexlify(estimatedDepositCost)} wei for deposit transaction`,
      };
    }

    // Step 3: Encode the depositERC3009 call data
    const depositCallData = ctx.ghost.interface.encodeFunctionData(
      'depositERC3009',
      [depositToSol, auth3009Sol]
    );

    // Get current nonce
    const nonce = await ctx.provider.getTransactionCount(pkpEthAddress, 'pending');

    // Construct the deposit transaction
    const depositTx = {
      to: ctx.ghost.address,
      nonce,
      gasLimit: hexlify(depositGasLimit),
      data: depositCallData,
      chainId: (await ctx.provider.getNetwork()).chainId,
      // EIP-1559 transaction
      maxFeePerGas: maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || undefined,
      type: 2,
    };

    const depositTxReceipt = await ctx.signAndSendTx(pkpPublicKey, depositTx);
    
    console.log('Deposit transaction sent:', depositTxReceipt.transactionHash);

    // Wait for deposit confirmation
    console.log('Deposit transaction confirmed!');

    // Step 5: Run manager.step() with 10s time budget to process the deposit
    const manager = await ctx.getManager();
    const { batch } = await manager.step(
      [], // no internal transactions
      [], // no payouts
      10, // max 10 deposits
      1000, // 1000 blocks per chunk
      10000 // 10 second time budget
    );

    // Step 6: Compute transcript
    const transcript = await manager.computeTranscriptForBatch(batch);

    // Encode doUpdate call for gas estimation
    const updateCallData = ctx.ghost.interface.encodeFunctionData('doUpdate', [
      batch.opStart,
      batch.opCount,
      batch.nextBlock,
      batch.updates,
      batch.newUsers,
      batch.payouts,
      transcript
    ]);

    // Estimate gas for update transaction
    const estimatedUpdateGas = await ctx.ghost.estimateGas.doUpdate(
      batch.opStart,
      batch.opCount,
      batch.nextBlock,
      batch.updates,
      batch.newUsers,
      batch.payouts,
      transcript,
      {
        from: pkpEthAddress
      }
    );

    // Add 20% buffer to gas estimate
    const updateGasLimit = estimatedUpdateGas.mul(120).div(100);

    // Check bot still has enough balance for update tx
    const updateFeeData = await ctx.provider.getFeeData();
    const updateMaxFeePerGas = updateFeeData.maxFeePerGas;
    if (!updateMaxFeePerGas) {
      return {
        ok: false,
        error: 'Could not get gas price for update transaction',
      };
    }

    const estimatedUpdateCost = updateGasLimit.mul(updateMaxFeePerGas);
    const balanceAfterDeposit = await ctx.provider.getBalance(pkpEthAddress);

    if (balanceAfterDeposit.lt(estimatedUpdateCost)) {
      return {
        ok: false,
        error: `Insufficient gas for update: bot has ${hexlify(balanceAfterDeposit)} wei, needs ${hexlify(estimatedUpdateCost)} wei`,
      };
    }

    // Get new nonce for update transaction
    const updateNonce = await ctx.provider.getTransactionCount(pkpEthAddress, 'pending');

    const updateTx = {
      to: ctx.ghost.address,
      nonce: updateNonce,
      gasLimit: hexlify(updateGasLimit),
      data: updateCallData,
      chainId: (await ctx.provider.getNetwork()).chainId,
      maxFeePerGas: updateMaxFeePerGas,
      maxPriorityFeePerGas: updateFeeData.maxPriorityFeePerGas || undefined,
      type: 2,
    };

    const updateReceipt = await ctx.signAndSendTx(pkpPublicKey, updateTx);

    return {
      ok: true,
      data: {
        depositTxHash: depositTxReceipt.transactionHash,
        updateTxHash: updateReceipt.transactionHash,
      },
    };

  } catch (error) {
    console.error('Submit deposit failed:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error during submit-deposit',
    };
  }
}
