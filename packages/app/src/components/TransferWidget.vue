<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createDepositTo, isValidTelegramUsername } from '@monorepo/core';
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

const emit = defineEmits<{
  error: [message: string];
  success: [message: string];
}>();

// Form state
const recipientUsername = ref('');
const amount = ref('');
const isTransferring = ref(false);

// Auto-strip '@' symbol from username
watch(recipientUsername, (newValue) => {
  if (newValue.startsWith('@')) {
    recipientUsername.value = newValue.slice(1);
  }
});

// Validation
const isValidUsername = computed(() => {
  if (!recipientUsername.value) return true; // Don't show error for empty
  return isValidTelegramUsername(recipientUsername.value);
});

const isValidAmount = computed(() => {
  if (!amount.value) return true;
  const num = parseFloat(amount.value);

  // Check if it's a valid number
  if (isNaN(num)) return false;

  // Check if it's positive
  if (num <= 0) return false;

  // Check decimal places (max 2 decimals for PYUSD which has 6 decimals, but we limit UI to 2)
  if (!/^\d+(\.\d{1,6})?$/.test(amount.value)) return false;

  // Check if it exceeds balance
  if (props.pyusdBalance) {
    const balance = parseFloat(props.pyusdBalance);
    if (num > balance) return false;
  }

  return true;
});

const amountErrorMessage = computed(() => {
  if (!amount.value || isValidAmount.value) return '';

  const num = parseFloat(amount.value);

  if (isNaN(num) || num <= 0) {
    return 'Amount must be greater than 0';
  }

  if (!/^\d+(\.\d{1,6})?$/.test(amount.value)) {
    return 'Enter a valid amount with up to 6 decimal places';
  }

  if (props.pyusdBalance) {
    const balance = parseFloat(props.pyusdBalance);
    if (num > balance) {
      return `Insufficient balance. Available: ${props.pyusdBalance} PYUSD`;
    }
  }

  return 'Invalid amount';
});

const canTransfer = computed(() => {
  if (!props.litGhostContract || !props.signer || !props.teePublicKey) return false;
  if (!recipientUsername.value || !amount.value) return false;
  if (!isValidUsername.value || !isValidAmount.value) return false;
  return true;
});

async function handleTransfer() {
  if (!canTransfer.value || !props.litGhostContract || !props.signer || !props.teePublicKey) return;

  isTransferring.value = true;

  try {
    // Parse amount to token units (6 decimals for PYUSD)
    const amountInUnits = Math.floor(parseFloat(amount.value) * 1_000_000);

    // Create encrypted DepositTo structure for the recipient
    const teePublicKeyBytes = new Uint8Array(
      props.teePublicKey.replace('0x', '').match(/.{2}/g)!.map((byte: string) => parseInt(byte, 16))
    );

    const { depositTo } = await createDepositTo(recipientUsername.value, teePublicKeyBytes);
    const depositToSol = {
      rand: '0x' + Buffer.from(depositTo.rand).toString('hex'),
      user: '0x' + Buffer.from(depositTo.user).toString('hex'),
    };

    // Get signer address and chain ID for EIP-712
    const signerAddress = await props.signer.getAddress();
    const chainId = await props.signer.getChainId();

    // Calculate nonce for EIP-3009 (hash of depositTo + callerIncentive=0)
    const nonceBytes = solidityKeccak256(
      ['bytes32', 'bytes32', 'uint256'],
      [depositToSol.rand, depositToSol.user, 0]
    );

    // EIP-3009 parameters
    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + 3600; // Valid for 1 hour

    // Get token name for EIP-712 domain
    const tokenABI = ['function name() view returns (string)'];
    const tokenContract = new Contract(props.tokenAddress, tokenABI, props.signer);
    const tokenName = await tokenContract.name();

    // EIP-712 domain
    const domain = {
      name: tokenName,
      version: '1',
      chainId: chainId,
      verifyingContract: props.tokenAddress,
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
      to: props.litGhostContract.address,
      value: amountInUnits.toString(),
      validAfter: validAfter,
      validBefore: validBefore,
      nonce: nonceBytes,
    };

    // Sign the EIP-712 message
    // @ts-ignore - _signTypedData exists on JsonRpcSigner
    const signature = await props.signer._signTypedData(domain, types, value);

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

    // Submit deposit via Lit Action (gas-less for user - bot pays gas)
    emit('success', 'Submitting transfer via Lit Action...');

    const result = await props.ghostClient.submitDeposit({
      depositTo: depositToSol,
      auth3009: auth3009,
    });

    emit('success', `Transfer submitted! Deposit tx: ${result.depositTxHash.slice(0, 10)}...`);
    emit('success', `Transfer confirmed! Update tx: ${result.updateTxHash.slice(0, 10)}... Sent ${amount.value} PYUSD to @${recipientUsername.value}`);

    // Clear form
    recipientUsername.value = '';
    amount.value = '';
  } catch (error) {
    console.error('Transfer failed:', error);
    const message = error instanceof Error ? error.message : 'Transfer failed';
    emit('error', message);
  } finally {
    isTransferring.value = false;
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
      <div class="space-y-2">
        <Label for="recipient" :class="{ 'text-destructive': !isValidUsername }">
          Recipient Telegram Username
        </Label>
        <Input
          id="recipient"
          v-model="recipientUsername"
          placeholder="alice (without @)"
          :class="{
            '!border-red-500 focus-visible:!ring-red-500': !isValidUsername,
            '!border-emerald-500 focus-visible:!ring-emerald-500': recipientUsername && isValidUsername
          }"
        />
        <p v-if="!isValidUsername" class="text-sm text-destructive font-medium">
          Invalid Telegram username (1-32 chars, letters/numbers/underscores, must start with letter)
        </p>
      </div>

      <div class="space-y-2">
        <Label for="amount" :class="{ 'text-destructive': !isValidAmount }">
          Amount (PYUSD)
        </Label>
        <Input
          id="amount"
          v-model="amount"
          type="number"
          step="0.01"
          min="0"
          placeholder="10.00"
          :class="{
            '!border-red-500 focus-visible:!ring-red-500': !isValidAmount,
            '!border-emerald-500 focus-visible:!ring-emerald-500': amount && isValidAmount
          }"
        />
        <p v-if="amountErrorMessage" class="text-sm text-destructive font-medium">
          {{ amountErrorMessage }}
        </p>
        <p v-else-if="pyusdBalance" class="text-sm text-muted-foreground">
          Available: {{ pyusdBalance }} PYUSD
        </p>
      </div>

      <Button
        @click="handleTransfer"
        :disabled="!canTransfer || isTransferring"
        class="w-full"
        size="lg"
      >
        <span v-if="isTransferring">Transferring...</span>
        <span v-else>Send Transfer</span>
      </Button>
    </CardContent>
  </Card>
</template>
