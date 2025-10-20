<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useWallet } from './composables/useWallet'
import { useTokenBalance } from './composables/useTokenBalance'
import { useGhostClient } from './composables/useGhostClient'
import { useSecretImport } from './composables/useSecretImport'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { LitGhost } from '@monorepo/core';
import TransferWidget from './components/TransferWidget.vue';
import PrivateBalanceManager from './components/PrivateBalanceManager.vue';

const { address, chainId, connected, connecting, connect, switchChain, provider, signer, availableProviders, getProviders, checkExistingConnection } = useWallet();

// Secret import for LitGhost
const {
  privateKey: litGhostSecret,
  isLoading: secretLoading,
  error: secretError,
  importSecret,
  logout: logoutSecret,
  checkUrlHash
} = useSecretImport();

const secretInput = ref('');

function handleImportSecret() {
  const success = importSecret(secretInput.value);
  if (success) {
    secretInput.value = ''; // Clear input on success
  }
}

function handleLogout() {
  logoutSecret();
  secretInput.value = '';
}

// GhostClient - auto-connects on mount
const {
  client: gc,
  isLoading: gcLoading,
  status: gcStatus
} = useGhostClient({ debug: true });

// Auto-connect to wallet if already authorized
// Also check URL hash for secret key
onMounted(() => {
  checkExistingConnection();

  // Check if there's a secret key in the URL hash and auto-import it
  checkUrlHash();
});

// Expected chain ID from environment
const expectedChainId = parseInt(import.meta.env.VITE_CHAIN_ID);

// LitGhost contract - automatically reconnects when signer changes
// Only creates contract instance if on the correct network
const litGhostContract = computed(() => {
  if (!signer.value) return null;

  // Check if we're on the correct network
  if (chainId.value !== expectedChainId) {
    console.warn(`Wrong network: expected chain ID ${expectedChainId} (${import.meta.env.VITE_CHAIN}), got ${chainId.value}`);
    return null;
  }

  console.log('Connecting to LitGhost contract', import.meta.env.VITE_CONTRACT_LITGHOST);
  return LitGhost.attach(import.meta.env.VITE_CONTRACT_LITGHOST).connect(signer.value);
});

// TEE public key - fetched from contract
const teePublicKey = ref<string | null>(null);

// Fetch TEE public key when contract becomes available
watch(litGhostContract, async (contract) => {
  if (contract) {
    try {
      const pubKey = await contract.getTeePublicKey();
      teePublicKey.value = pubKey;
    } catch (error) {
      console.error('Failed to fetch TEE public key:', error);
      errorMessage.value = 'Failed to fetch TEE public key from contract';
      showErrorDialog.value = true;
    }
  } else {
    teePublicKey.value = null;

    // If we have a signer but no contract, it means wrong network
    if (signer.value && chainId.value !== expectedChainId) {
      console.warn(`Contract not available: wrong network (expected ${expectedChainId}, got ${chainId.value})`);
    }
  }
}, { immediate: true });

// Error dialog state
const showErrorDialog = ref(false);
const errorMessage = ref('');

// Success message state
const showSuccessMessage = ref(false);
const successMessage = ref('');

function handleTransferError(message: string) {
  errorMessage.value = message;
  showErrorDialog.value = true;
}

function handleTransferSuccess(message: string) {
  successMessage.value = message;
  showSuccessMessage.value = true;
  // Auto-hide success message after 5 seconds
  setTimeout(() => {
    showSuccessMessage.value = false;
  }, 5000);
}

// Check if any Web3 provider is available
const hasWeb3Provider = computed(() => {
  return getProviders().length > 0 || availableProviders.value.size > 0;
});

const pyusd_token_address = import.meta.env.VITE_PYUSD_TOKEN_ADDRESS;

// PYUSD token balance
const { balance: pyusdBalance, formattedBalance, isRefreshing, refresh: refreshBalance } = useTokenBalance({
  provider,
  address,
  chainId,
  expectedChainId,
  tokenAddress: pyusd_token_address,
  pollInterval: 5 * 60 * 1000 // Poll every 5 minutes
});

async function handleConnect() {
  try {
    const success = await connect();
    if (!success) {
      errorMessage.value = 'Failed to connect to wallet. Please try again.';
      showErrorDialog.value = true;
    }
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : 'An unknown error occurred while connecting to your wallet.';
    showErrorDialog.value = true;
  }
}

function doSwitchToCorrectNetwork() {
  // Convert decimal chain ID to hex
  const chainIdHex = '0x' + expectedChainId.toString(16);
  switchChain(chainIdHex);
}

const correctChainName = import.meta.env.VITE_CHAIN;

const isCorrectNetwork = () => chainId.value === expectedChainId;

// Truncate address for display
const truncatedAddress = computed(() => {
  if (!address.value) return '';
  // Ethereum address is 42 chars (0x + 40 hex chars)
  // Show first 6 chars (0x + 4 hex) and last 4 chars
  return `${address.value.slice(0, 10)}...${address.value.slice(-8)}`;
});

// Connection status variant and text
const connectionStatus = computed(() => {
  if (!connected.value) {
    return { variant: 'destructive', text: 'Not Connected', class: 'border-red-500 text-red-500 bg-red-500/10' };
  }
  if (!isCorrectNetwork()) {
    return { variant: 'default', text: `Wrong Network`, class: 'border-yellow-500 text-yellow-500 bg-yellow-500/10' };
  }
  return { variant: 'outline', text: correctChainName, class: 'border-emerald-400 text-emerald-400 bg-emerald-400/10' };
});

</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Top Bar -->
    <div class="border-b border-border bg-card">
      <div class="max-w-4xl mx-auto px-6 py-4">
        <div class="flex items-center justify-between">
          <!-- Logo -->
          <div class="flex items-center gap-2">
            <span class="text-3xl">🔥👻</span>
          </div>

          <!-- Status Badges -->
          <div class="flex items-center gap-2">
            <!-- Connection Status -->
            <Badge
              variant="outline"
              :class="[
                connectionStatus.class,
                'px-3 py-1.5 font-medium transition-all',
                { 'cursor-pointer hover:opacity-80': connected && !isCorrectNetwork() }
              ]"
              @click="connected && !isCorrectNetwork() && doSwitchToCorrectNetwork()"
            >
              <span v-if="connected" class="w-2 h-2 rounded-full mr-2" :class="isCorrectNetwork() ? 'bg-emerald-400' : 'bg-yellow-500'"></span>
              <span v-else class="w-2 h-2 bg-red-500 rounded-full mr-2"></span>
              {{ connectionStatus.text }}
            </Badge>

            <!-- Lit Status -->
            <Badge
              variant="outline"
              :class="[gcStatus.class, 'px-3 py-1.5 font-medium']"
            >
              <span class="w-2 h-2 rounded-full mr-2" :class="gcStatus.dotClass"></span>
              {{ gcStatus.text }}
            </Badge>
          </div>
        </div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <!-- Wallet Info Section -->
      <div class="bg-card border border-border rounded-lg p-6">
        <!-- Not Connected State -->
        <div v-if="!connected" class="text-center py-8">
          <div class="w-20 h-20 mx-auto bg-primary/10 rounded-full flex items-center justify-center text-4xl mb-4">
            👛
          </div>
          <p class="text-muted-foreground mb-6">No wallet connected</p>

          <!-- Show connect button if provider is available -->
          <Button
            v-if="hasWeb3Provider"
            @click="handleConnect"
            :disabled="connecting"
            size="lg"
            class="w-full sm:w-auto"
          >
            <span v-if="connecting">Connecting...</span>
            <span v-else>Connect Wallet</span>
          </Button>

          <!-- Show message if no provider detected -->
          <div v-else class="space-y-4">
            <p class="text-destructive font-medium">No Web3 wallet detected</p>
            <p class="text-sm text-muted-foreground max-w-md mx-auto">
              Please install a Web3 wallet browser extension (like MetaMask, Coinbase Wallet, or Rabby) to connect.
            </p>
          </div>
        </div>

        <!-- Connected State -->
        <div v-else class="space-y-4">
          <!-- Wallet Address and Balance Row -->
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div class="flex-1">
              <p class="text-sm text-muted-foreground mb-1">Wallet Address</p>
              <p class="font-mono text-lg">{{ truncatedAddress }}</p>
            </div>
            <div class="text-left sm:text-right">
              <div class="flex items-center justify-start sm:justify-end gap-2 mb-1">
                <p class="text-sm text-muted-foreground">PYUSD Balance</p>
                <Button
                  variant="ghost"
                  size="sm"
                  @click="refreshBalance"
                  :disabled="isRefreshing"
                  class="h-6 w-6 p-0"
                >
                  <span :class="{ 'animate-spin': isRefreshing }">🔄</span>
                </Button>
              </div>
              <p class="text-2xl font-bold">{{ formattedBalance }} <span class="text-sm font-normal text-muted-foreground">PYUSD</span></p>
            </div>
          </div>

          <!-- Wrong Network Warning & Actions -->
          <div v-if="!isCorrectNetwork()" class="pt-4 border-t border-border">
            <div class="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-4 mb-4">
              <p class="text-sm text-yellow-700 dark:text-yellow-400 font-medium">
                ⚠️ Please switch to {{ correctChainName }}
              </p>
            </div>
            <Button @click="doSwitchToCorrectNetwork" class="w-full" size="lg">
              Switch to {{ correctChainName }}
            </Button>
          </div>
        </div>
      </div>

      <!-- Loading state for transfer functionality -->
      <Card v-if="litGhostContract && !gc && gcLoading">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <span class="text-3xl">💸</span>
            Transfer PYUSD
          </CardTitle>
        </CardHeader>
        <CardContent class="text-center py-8">
          <div class="w-16 h-16 mx-auto mb-4 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          <p class="text-muted-foreground">Loading transfer functionality...</p>
        </CardContent>
      </Card>

      <!-- Transfer Widget - Only visible when contract and ghost client are available -->
      <TransferWidget
        v-if="litGhostContract && gc"
        :lit-ghost-contract="litGhostContract"
        :signer="signer"
        :pyusd-balance="pyusdBalance"
        :token-address="pyusd_token_address"
        :tee-public-key="teePublicKey"
        :ghost-client="gc"
        @error="handleTransferError"
        @success="handleTransferSuccess"
      />

      <!-- Private Balance Manager -->
      <PrivateBalanceManager
        :ghost-client="gc"
        :private-key="litGhostSecret"
      />

      <!-- Login with Secret Accordion -->
      <div>
        <Accordion type="single" collapsible class="w-full">
          <AccordionItem value="login-secret">
            <AccordionTrigger class="text-left">
              <div class="flex items-center justify-between w-full pr-4">
                <span class="font-medium">Login with LitGhost Secret</span>
                <Badge v-if="litGhostSecret" variant="default" class="ml-2">
                  Logged In
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div class="space-y-4 pt-2">
                <!-- Not logged in state -->
                <div v-if="!litGhostSecret">
                  <p class="text-sm text-muted-foreground mb-4">
                    Paste your LitGhost secret (exported from the Telegram Mini App) to view and manage your private balance.
                  </p>

                  <div class="space-y-3">
                    <Textarea
                      v-model="secretInput"
                      placeholder="Paste your private key here (with or without 0x prefix, spaces allowed)"
                      class="font-mono text-xs min-h-[100px]"
                      :disabled="secretLoading"
                    />

                    <!-- Error message -->
                    <p v-if="secretError" class="text-xs text-destructive">
                      {{ secretError }}
                    </p>

                    <Button
                      @click="handleImportSecret"
                      :disabled="secretLoading || !secretInput.trim()"
                      class="w-full"
                    >
                      <span v-if="secretLoading">Importing...</span>
                      <span v-else>Import Secret</span>
                    </Button>
                  </div>
                </div>

                <!-- Logged in state -->
                <div v-else class="space-y-3">
                  <div class="bg-emerald-500/10 border border-emerald-500/50 rounded-lg p-4">
                    <p class="text-sm text-emerald-700 dark:text-emerald-400 font-medium">
                      ✓ LitGhost secret imported successfully
                    </p>
                  </div>

                  <Button
                    @click="handleLogout"
                    variant="outline"
                    class="w-full"
                  >
                    Logout (Clear Secret)
                  </Button>

                  <p class="text-xs text-muted-foreground text-center">
                    Your secret is only stored in memory and will be cleared when you close this tab.
                  </p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      <!-- Footer -->
      <div class="text-center text-sm text-muted-foreground">
        Made with 🤎 @ ETH Global Online 2025
      </div>
    </div>

    <!-- Error Dialog -->
    <AlertDialog v-model:open="showErrorDialog">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Error</AlertDialogTitle>
          <AlertDialogDescription>
            {{ errorMessage }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction @click="showErrorDialog = false">
            OK
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- Success Message -->
    <div
      v-if="showSuccessMessage"
      class="fixed bottom-4 right-4 bg-emerald-500 text-white px-6 py-4 rounded-lg shadow-lg animate-in slide-in-from-bottom-5"
    >
      <p class="font-medium">{{ successMessage }}</p>
    </div>
  </div>
</template>

