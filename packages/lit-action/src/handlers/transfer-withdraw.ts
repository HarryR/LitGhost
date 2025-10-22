import { GhostRequestTransferWithdraw, GhostResponse, TransferWithdrawResponseData, TransferWithdrawOperation } from '../params';
import { type GhostContext } from '../context';
import {
  hexlify, isValidTelegramUsername, InternalTransaction,
  keccak256, defaultAbiCoder, recoverAddress, joinSignature,
  ManagerContext, computeAddress
} from '@monorepo/core/sandboxed';

/**
 * Handle transfer-withdraw request - processes internal transfers or withdrawals with signature verification
 *
 * Flow:
 * 1. For each operation, verify signature and validate parameters
 * 2. Build transactions/payouts arrays from valid operations
 * 3. Run manager.step() to process all operations
 * 4. Estimate gas and submit the update transaction
 *
 * @param request - The transfer-withdraw request with 1-10 operations
 * @param ctx - GhostContext with contracts and provider
 * @returns Response with update transaction hash and any skipped operations
 */
export async function handleTransferWithdraw(
  request: GhostRequestTransferWithdraw,
  ctx: GhostContext
): Promise<GhostResponse<TransferWithdrawResponseData>> {
  try {
    // Initialize context (recover PKP keys from entropy signature)
    await ctx.entropy();

    const pkpEthAddress = ctx.pkpEthAddress;
    const pkpPublicKey = ctx.pkpPublicKey;

    // Get manager for signature verification and processing
    const manager = await ctx.getManager();

    // Arrays to collect valid operations
    const internalTransactions: InternalTransaction[] = [];
    const payouts: Array<{ telegramUsername: string; toAddress: string; amount: bigint }> = [];
    const validationErrors: Array<{ index: number; reason: string }> = [];

    // Process each operation
    for (let i = 0; i < request.operations.length; i++) {
      const op = request.operations[i];

      // Validate and process operation
      const result = await validateAndProcessOperation(op, i, manager);

      if (!result.valid) {
        validationErrors.push({ index: i, reason: result.error! });
        continue;
      }

      // Add to appropriate array based on operation type
      if (result.internalTransaction) {
        internalTransactions.push(result.internalTransaction);
      }
      if (result.payout) {
        payouts.push(result.payout);
      }
    }

    // If all operations failed validation, return error
    if (validationErrors.length === request.operations.length) {
      return {
        ok: false,
        error: 'All operations failed validation',
        details: validationErrors,
      };
    }

    // Step: Run manager.step() to process all valid operations
    const { batch } = await manager.step(
      internalTransactions,
      payouts,
      10, // max 10 deposits
      1000, // 1000 blocks per chunk
      10000 // 10 second time budget
    );

    // Compute transcript
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

    // Check bot has enough balance for update tx
    const updateFeeData = await ctx.provider.getFeeData();
    const updateMaxFeePerGas = updateFeeData.maxFeePerGas;
    if (!updateMaxFeePerGas) {
      return {
        ok: false,
        error: 'Could not get gas price for update transaction',
      };
    }

    const estimatedUpdateCost = updateGasLimit.mul(updateMaxFeePerGas);
    const balance = await ctx.provider.getBalance(pkpEthAddress);

    if (balance.lt(estimatedUpdateCost)) {
      return {
        ok: false,
        error: `Insufficient gas: bot has ${hexlify(balance)} wei, needs ${hexlify(estimatedUpdateCost)} wei`,
      };
    }

    // Get nonce for update transaction
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

    const updateTxHash = await ctx.signAndSendTx(pkpPublicKey, updateTx);

    return {
      ok: true,
      data: {
        updateTxHash,
        skippedOperations: validationErrors.length > 0 ? validationErrors : undefined,
      },
    };

  } catch (error) {
    console.error('Transfer-withdraw failed:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error during transfer-withdraw',
    };
  }
}

/**
 * Validate and process a single operation
 * Returns either a valid transaction/payout or an error
 */
async function validateAndProcessOperation(
  op: TransferWithdrawOperation,
  _index: number,
  manager: ManagerContext
): Promise<{
  valid: boolean;
  error?: string;
  internalTransaction?: InternalTransaction;
  payout?: { telegramUsername: string; toAddress: string; amount: bigint };
}> {
  try {
    // Step 1: Derive user keypair from telegram username
    const ukp = manager.getUserKeypair(op.fromTelegramUsername);
    const expectedAddress = computeAddress(ukp.publicKey);

    // Step 2: Construct message digest for signature verification
    // Message format: hash(fromTelegramUsername, nonce, operationType, destination, amountCents)
    const messageHash = keccak256(
      defaultAbiCoder.encode(
        ['string', 'uint256', 'string', 'string', 'uint256'],
        [
          op.fromTelegramUsername,
          op.balanceLeafNonce,
          op.operationType,
          op.destination,
          op.amountCents
        ]
      )
    );

    // Step 3: Recover address from signature
    const signature = joinSignature({
      v: op.signature.v,
      r: op.signature.r,
      s: op.signature.s
    });
    const recoveredAddress = recoverAddress(messageHash, signature);

    // Verify signature matches expected address
    if (recoveredAddress.toLowerCase() !== expectedAddress.toLowerCase()) {
      return {
        valid: false,
        error: `Signature verification failed: expected ${expectedAddress}, got ${recoveredAddress}`
      };
    }

    // Step 4: Validate destination format based on operation type
    if (op.operationType === 'transfer') {
      if (!isValidTelegramUsername(op.destination)) {
        return {
          valid: false,
          error: `Invalid telegram username: ${op.destination}`
        };
      }

      // Return internal transaction
      return {
        valid: true,
        internalTransaction: {
          from: op.fromTelegramUsername,
          to: op.destination,
          amount: op.amountCents
        }
      };
    } else {
      // Withdraw - validate ethereum address
      if (!/^0x[0-9a-fA-F]{40}$/.test(op.destination)) {
        return {
          valid: false,
          error: `Invalid ethereum address: ${op.destination}`
        };
      }

      // Convert cents (2 decimals) to token decimals (6 decimals)
      // Multiply by 10^4 to go from 2 decimals to 6 decimals
      const amountFullDecimals = BigInt(op.amountCents) * 10000n;

      // Return payout
      return {
        valid: true,
        payout: {
          telegramUsername: op.fromTelegramUsername,
          toAddress: op.destination,
          amount: amountFullDecimals
        }
      };
    }

  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error'
    };
  }
}
