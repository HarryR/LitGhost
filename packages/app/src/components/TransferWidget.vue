<script setup lang="ts">
import { ref, computed } from 'vue';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createDepositTo, isValidTelegramUsername } from '@monorepo/core';
import type { Signer } from '@ethersproject/abstract-signer';
import type { Contract } from '@ethersproject/contracts';
import { keccak256 as solidityKeccak256 } from '@ethersproject/solidity';

const props = defineProps<{
  litGhostContract: Contract | null;
  signer: Signer | null;
  pyusdBalance: string | null;
  tokenAddress: string;
  teePublicKey: string | null;
}>();

const emit = defineEmits<{
  error: [message: string];
  success: [message: string];
}>();

// Form state
const recipientUsername = ref('');
const amount = ref('');
const isTransferring = ref(false);

// Validation
const isValidUsername = computed(() => {
  if (!recipientUsername.value) return true; // Don't show error for empty
  return isValidTelegramUsername(recipientUsername.value);
});

const isValidAmount = computed(() => {
  if (!amount.value) return true;
  const num = parseFloat(amount.value);
  return !isNaN(num) && num > 0 && /^\d+(\.\d{1,2})?$/.test(amount.value);
});

const canTransfer = computed(() => {
  if (!props.litGhostContract || !props.signer || !props.teePublicKey) return false;
  if (!recipientUsername.value || !amount.value) return false;
  if (!isValidUsername.value || !isValidAmount.value) return false;

  // Check sufficient balance
  if (props.pyusdBalance) {
    const balance = parseFloat(props.pyusdBalance);
    const transferAmount = parseFloat(amount.value);
    return transferAmount <= balance;
  }

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
    const { Contract } = await import('@ethersproject/contracts');
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
    const auth = {
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

    // Call depositERC3009 on LitGhost contract
    const tx = await props.litGhostContract['depositERC3009((bytes32,bytes32),(address,uint256,uint256,uint256,(uint8,bytes32,bytes32)))'](
      depositToSol,
      auth
    );

    emit('success', `Transfer initiated! Tx: ${tx.hash}`);

    await tx.wait();

    emit('success', `Transfer confirmed! Sent ${amount.value} PYUSD to @${recipientUsername.value}`);

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
      <CardDescription>
        Send PYUSD to a Telegram user privately
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="space-y-2">
        <Label for="recipient">Recipient Telegram Username</Label>
        <Input
          id="recipient"
          v-model="recipientUsername"
          placeholder="alice"
          :class="{ 'border-destructive': !isValidUsername }"
        />
        <p v-if="!isValidUsername" class="text-sm text-destructive">
          Invalid Telegram username (1-32 chars, letters/numbers/underscores, must start with letter)
        </p>
      </div>

      <div class="space-y-2">
        <Label for="amount">Amount (PYUSD)</Label>
        <Input
          id="amount"
          v-model="amount"
          type="number"
          step="0.01"
          min="0"
          placeholder="10.00"
          :class="{ 'border-destructive': !isValidAmount }"
        />
        <p v-if="!isValidAmount" class="text-sm text-destructive">
          Enter a valid amount with up to 2 decimal places
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
