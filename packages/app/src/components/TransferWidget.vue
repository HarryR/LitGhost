<script setup lang="ts">
import { ref, computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import AmountInput from './inputs/AmountInput.vue';
import TelegramUsernameInput from './inputs/TelegramUsernameInput.vue';
import { createDepositTo } from '@monorepo/core';
import type { Signer } from '@ethersproject/abstract-signer';
import { Contract } from '@ethersproject/contracts';
import { keccak256 as solidityKeccak256 } from '@ethersproject/solidity';
import type { IGhostClient } from '../ighostclient';

const props = defineProps<{
  litGhostContract: Contract | null;
  signer: Signer | null;
  pyusdBalance: string | null;
  tokenAddress: string;
  teePublicKey: string | null;
  ghostClient: IGhostClient;
}>();

// State management
type ViewState = 'form' | 'processing' | 'success' | 'error';

// Form state
const recipientUsername = ref('');
const amount = ref('');
const viewState = ref<ViewState>('form');
const processingStatus = ref<string>('');
const depositTxHash = ref<string | null>(null);
const updateTxHash = ref<string | null>(null);
const errorMessage = ref<string>('');
const processedAmount = ref<string>('');
const processedRecipient = ref<string>('');

// Template refs to access parsed/cleaned values from input components
const usernameInputRef = ref<InstanceType<typeof TelegramUsernameInput> | null>(null);
const amountInputRef = ref<InstanceType<typeof AmountInput> | null>(null);

// Form validation - child components handle all validation and cleaning
const canTransfer = computed(() => {
  if (!props.litGhostContract || !props.signer || !props.teePublicKey) return false;

  const usernameInput = usernameInputRef.value;
  const amountInput = amountInputRef.value;

  // Check if username input has a valid cleaned value
  // Exposed computed refs are automatically unwrapped by defineExpose
  if (!usernameInput?.isValid) return false;
  if (!usernameInput?.cleanedValue) return false;

  // Check if amount input has a valid parsed value
  if (!amountInput?.isValid) return false;
  if (!amountInput?.parsedValue) return false;

  return true;
});

// Block explorer URLs
const depositExplorerUrl = computed(() => {
  const baseUrl = import.meta.env.VITE_BLOCK_EXPLORER || 'https://etherscan.io';
  return depositTxHash.value ? `${baseUrl}/tx/${depositTxHash.value}` : '';
});

const updateExplorerUrl = computed(() => {
  const baseUrl = import.meta.env.VITE_BLOCK_EXPLORER || 'https://etherscan.io';
  return updateTxHash.value ? `${baseUrl}/tx/${updateTxHash.value}` : '';
});

// Reset to form view
function resetToForm() {
  viewState.value = 'form';
  recipientUsername.value = '';
  amount.value = '';
  depositTxHash.value = null;
  updateTxHash.value = null;
  errorMessage.value = '';
  processedAmount.value = '';
  processedRecipient.value = '';
  processingStatus.value = '';
}

// Copy transaction hash to clipboard
async function copyTxHash(txHash: string) {
  if (!txHash) return;

  try {
    await navigator.clipboard.writeText(txHash);
  } catch (err) {
    console.error('Failed to copy:', err);
    // Fallback: select and copy (for older browsers)
    const textArea = document.createElement('textarea');
    textArea.value = txHash;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
    } catch (err2) {
      console.error('Fallback copy failed:', err2);
    }
    document.body.removeChild(textArea);
  }
}

// Create and sign EIP-3009 authorization for token transfer
async function signTransferAuthorization(
  tokenContract: Contract,
  signer: Signer,
  destinationUsername: string,
  amountInUnits: number,
  teePublicKeyBytes: Uint8Array
): Promise<{
  depositTo: { rand: string; user: string };
  auth3009: {
    from: string;
    value: string;
    validAfter: number;
    validBefore: number;
    sig: { v: number; r: string; s: string };
  };
}> {
  // Create encrypted DepositTo structure for the recipient
  const { depositTo } = await createDepositTo(destinationUsername, teePublicKeyBytes);
  const depositToSol = {
    rand: '0x' + Buffer.from(depositTo.rand).toString('hex'),
    user: '0x' + Buffer.from(depositTo.user).toString('hex'),
  };

  // Get signer address and chain ID for EIP-712
  const signerAddress = await signer.getAddress();
  const chainId = await signer.getChainId();

  // Calculate nonce for EIP-3009 (hash of depositTo + callerIncentive=0)
  const nonceBytes = solidityKeccak256(
    ['bytes32', 'bytes32', 'uint256'],
    [depositToSol.rand, depositToSol.user, 0]
  );

  // EIP-3009 parameters
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 3600; // Valid for 1 hour

  // Get token name for EIP-712 domain
  const tokenName = await tokenContract.name();

  // EIP-712 domain
  const domain = {
    name: tokenName,
    version: '1',
    chainId: chainId,
    verifyingContract: tokenContract.address,
  };

  // EIP-712 types for ReceiveWithAuthorization
  const types = {
    ReceiveWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };

  // Value to sign
  const value = {
    from: signerAddress,
    to: props.litGhostContract!.address,
    value: amountInUnits.toString(),
    validAfter: validAfter,
    validBefore: validBefore,
    nonce: nonceBytes,
  };

  // Sign the EIP-712 message
  // @ts-ignore - _signTypedData exists on JsonRpcSigner
  const signature = await signer._signTypedData(domain, types, value);

  // Parse signature into v, r, s (signature is 0x + 65 bytes hex)
  const sig = {
    r: '0x' + signature.slice(2, 66),
    s: '0x' + signature.slice(66, 130),
    v: parseInt(signature.slice(130, 132), 16)
  };

  // Construct Auth3009 struct
  const auth3009 = {
    from: signerAddress,
    value: amountInUnits.toString(),
    validAfter: validAfter,
    validBefore: validBefore,
    sig: {
      v: sig.v,
      r: sig.r,
      s: sig.s,
    },
  };

  return { depositTo: depositToSol, auth3009 };
}

async function handleTransfer() {
  if (!canTransfer.value || !props.litGhostContract || !props.signer || !props.teePublicKey) return;

  // IMPORTANT: Capture values from refs BEFORE changing viewState
  // When viewState changes, the form is destroyed and refs become null
  const cleanedUsername = usernameInputRef.value?.cleanedValue;
  if (!cleanedUsername) {
    throw new Error(`Invalid username: ${cleanedUsername}`);
  }

  const parsedAmount = amountInputRef.value?.parsedValue;
  if (!parsedAmount) {
    throw new Error(`Invalid amount: ${parsedAmount}`);
  }

  viewState.value = 'processing';
  processedAmount.value = amount.value;
  processedRecipient.value = cleanedUsername;

  try {
    processingStatus.value = 'Preparing transfer...';

    // Parse amount to token units (6 decimals for PYUSD)
    const amountInUnits = Math.floor(parsedAmount * 1_000_000);

    // Create encrypted DepositTo structure for the recipient
    const teePublicKeyBytes = new Uint8Array(
      props.teePublicKey.replace('0x', '').match(/.{2}/g)!.map((byte: string) => parseInt(byte, 16))
    );

    // Create token contract instance
    const tokenABI = ['function name() view returns (string)'];
    const tokenContract = new Contract(props.tokenAddress, tokenABI, props.signer);

    processingStatus.value = 'Signing authorization...';

    // Sign the transfer authorization
    const { depositTo, auth3009 } = await signTransferAuthorization(
      tokenContract,
      props.signer,
      cleanedUsername,
      amountInUnits,
      teePublicKeyBytes
    );

    processingStatus.value = 'Submitting to Lit Action...';

    // Submit deposit via Lit Action (gas-less for user - bot pays gas)
    const result = await props.ghostClient.submitDeposit({
      depositTo: depositTo,
      auth3009: auth3009,
    });

    // Store transaction hashes
    depositTxHash.value = result.depositTxHash;
    updateTxHash.value = result.updateTxHash;

    processingStatus.value = 'Waiting for blockchain confirmation...';

    // Wait for update transaction to be mined (with polling fallback)
    console.log('Waiting for update transaction:', updateTxHash.value);
    let receipt = null;
    const maxAttempts = 30; // 30 attempts * 5 seconds = 150 seconds max
    for (let i = 0; i < maxAttempts; i++) {
      try {
        receipt = await props.litGhostContract!.provider.getTransactionReceipt(updateTxHash.value);
        if (receipt) {
          console.log('Update transaction mined! Receipt:', receipt);
          if (receipt.status === 0) {
            throw new Error('Update transaction failed on-chain');
          }
          break;
        }
      } catch (err) {
        console.error('Error fetching receipt:', err);
      }

      // Wait 5 seconds before next attempt
      await new Promise(resolve => setTimeout(resolve, 5000));
      console.log(`Polling for receipt... attempt ${i + 1}/${maxAttempts}`);
    }

    if (!receipt) {
      console.warn('Update transaction not confirmed after 150s, but continuing anyway');
    }

    processingStatus.value = 'Transfer complete!';

    // Show success view
    viewState.value = 'success';

  } catch (error) {
    console.error('Transfer failed:', error);
    errorMessage.value = error instanceof Error ? error.message : 'Transfer failed';
    viewState.value = 'error';
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        <span class="text-3xl">💸</span>
        Transfer PYUSD
      </CardTitle>
    </CardHeader>
    <CardContent class="space-y-4">
      <!-- Form View -->
      <div v-if="viewState === 'form'" class="space-y-4">
        <TelegramUsernameInput
          ref="usernameInputRef"
          v-model="recipientUsername"
          label="Recipient Telegram Username"
          :required="true"
        />

        <AmountInput
          ref="amountInputRef"
          v-model="amount"
          label="Amount"
          :balance="pyusdBalance"
          token-symbol="PYUSD"
          :required="true"
        />

        <Button
          @click="handleTransfer"
          :disabled="!canTransfer"
          class="w-full"
          size="lg"
        >
          Send Transfer
        </Button>
      </div>

      <!-- Processing View -->
      <div v-else-if="viewState === 'processing'" class="space-y-4 py-8 text-center">
        <div class="w-16 h-16 mx-auto mb-4 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <h3 class="text-xl font-semibold">Processing Transfer...</h3>
        <div class="space-y-2 text-sm text-muted-foreground">
          <p v-if="processingStatus">{{ processingStatus }}</p>
        </div>

        <!-- Deposit Transaction Hash Display (once available) -->
        <div v-if="depositTxHash" class="mt-4 bg-muted rounded-md p-4">
          <div class="flex items-center justify-between gap-2">
            <div class="flex-1 min-w-0">
              <p class="text-xs text-muted-foreground mb-1">Deposit Transaction</p>
              <p class="font-mono text-xs truncate">{{ depositTxHash }}</p>
            </div>
            <div class="flex gap-2">
              <Button
                @click="copyTxHash(depositTxHash)"
                variant="ghost"
                size="sm"
                class="h-8 px-2"
                title="Copy transaction hash"
              >
                📋
              </Button>
              <a
                v-if="depositExplorerUrl"
                :href="depositExplorerUrl"
                target="_blank"
                class="inline-flex items-center justify-center h-8 px-2 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
                title="View on explorer"
              >
                ↗
              </a>
            </div>
          </div>
        </div>

        <!-- Update Transaction Hash Display (once available) -->
        <div v-if="updateTxHash" class="mt-2 bg-muted rounded-md p-4">
          <div class="flex items-center justify-between gap-2">
            <div class="flex-1 min-w-0">
              <p class="text-xs text-muted-foreground mb-1">Update Transaction</p>
              <p class="font-mono text-xs truncate">{{ updateTxHash }}</p>
            </div>
            <div class="flex gap-2">
              <Button
                @click="copyTxHash(updateTxHash)"
                variant="ghost"
                size="sm"
                class="h-8 px-2"
                title="Copy transaction hash"
              >
                📋
              </Button>
              <a
                v-if="updateExplorerUrl"
                :href="updateExplorerUrl"
                target="_blank"
                class="inline-flex items-center justify-center h-8 px-2 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground"
                title="View on explorer"
              >
                ↗
              </a>
            </div>
          </div>
        </div>
      </div>

      <!-- Success View -->
      <div v-else-if="viewState === 'success'" class="space-y-4 py-6 text-center">
        <div class="w-16 h-16 mx-auto bg-emerald-500/10 rounded-full flex items-center justify-center text-3xl mb-4">
          ✓
        </div>
        <h3 class="text-xl font-semibold text-emerald-600 dark:text-emerald-400">Transfer Complete</h3>

        <div class="bg-muted rounded-md p-4 space-y-2 text-left">
          <div class="flex justify-between text-sm">
            <span class="text-muted-foreground">Sent:</span>
            <span class="font-semibold">{{ processedAmount }} PYUSD</span>
          </div>
          <div class="flex justify-between text-sm gap-2">
            <span class="text-muted-foreground shrink-0">To:</span>
            <span class="font-mono text-xs">@{{ processedRecipient }}</span>
          </div>
          <div v-if="depositTxHash" class="flex justify-between text-sm gap-2 pt-2 border-t border-border">
            <span class="text-muted-foreground shrink-0">Deposit Tx:</span>
            <a
              :href="depositExplorerUrl"
              target="_blank"
              class="font-mono text-xs text-primary hover:underline truncate"
            >
              {{ depositTxHash }} ↗
            </a>
          </div>
          <div v-if="updateTxHash" class="flex justify-between text-sm gap-2">
            <span class="text-muted-foreground shrink-0">Update Tx:</span>
            <a
              :href="updateExplorerUrl"
              target="_blank"
              class="font-mono text-xs text-primary hover:underline truncate"
            >
              {{ updateTxHash }} ↗
            </a>
          </div>
        </div>

        <Button @click="resetToForm" variant="outline" class="w-full">
          Send Another
        </Button>
      </div>

      <!-- Error View -->
      <div v-else-if="viewState === 'error'" class="space-y-4 py-6 text-center">
        <div class="w-16 h-16 mx-auto bg-destructive/10 rounded-full flex items-center justify-center text-3xl mb-4">
          ❌
        </div>
        <h3 class="text-xl font-semibold text-destructive">Transfer Failed</h3>
        <p class="text-sm text-muted-foreground max-w-md mx-auto">
          {{ errorMessage }}
        </p>
        <Button @click="resetToForm" variant="outline" class="w-full">
          Try Again
        </Button>
      </div>
    </CardContent>
  </Card>
</template>
