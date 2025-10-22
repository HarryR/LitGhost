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

const emit = defineEmits<{
  error: [message: string];
  success: [message: string];
}>();

// Form state
const recipientUsername = ref('');
const amount = ref('');
const isTransferring = ref(false);

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

async function handleTransfer() {
  if (!canTransfer.value || !props.litGhostContract || !props.signer || !props.teePublicKey) return;

  isTransferring.value = true;

  try {
    // Get the cleaned username from the input component (already validated and cleaned)
    // cleanedValue is automatically unwrapped from ComputedRef by defineExpose
    const cleanedUsername = usernameInputRef.value?.cleanedValue;
    if (!cleanedUsername) {
      throw new Error(`Invalid username: ${cleanedUsername}`);
    }

    // Get the parsed amount from the input component (already validated)
    // parsedValue is automatically unwrapped from ComputedRef by defineExpose
    const parsedAmount = amountInputRef.value?.parsedValue;
    if (!parsedAmount) {
      throw new Error(`Invalid amount: ${parsedAmount}`);
    }

    // Parse amount to token units (6 decimals for PYUSD)
    const amountInUnits = Math.floor(parsedAmount * 1_000_000);

    // Create encrypted DepositTo structure for the recipient
    const teePublicKeyBytes = new Uint8Array(
      props.teePublicKey.replace('0x', '').match(/.{2}/g)!.map((byte: string) => parseInt(byte, 16))
    );

    const { depositTo } = await createDepositTo(cleanedUsername, teePublicKeyBytes);
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
