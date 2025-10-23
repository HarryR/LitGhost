<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useWallet } from './composables/useWallet'
import { useTokenBalance } from './composables/useTokenBalance'
import { useGhostClient } from './composables/useGhostClient'
import { useSecretImport } from './composables/useSecretImport'
import { usePkpGas } from './composables/usePkpGas'
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
import { JsonRpcProvider } from '@ethersproject/providers';
import bootstrapData from '../../lit-action/bootstrap-development.json';

const { address, chainId, connected, connecting, connect, switchChain, provider, signer, availableProviders, getProviders, checkExistingConnection } = useWallet();

// Create a direct RPC provider for read operations (bypasses MetaMask caching)
// MetaMask aggressively caches eth_call results, causing stale balance reads
const rpcProvider = new JsonRpcProvider(import.meta.env.VITE_RPC_URL);

// Create read-only LitGhost contract instance (for balance reads)
const litGhostContractReadOnly = LitGhost.attach(import.meta.env.VITE_CONTRACT_LITGHOST).connect(rpcProvider);

// Secret import for LitGhost
const {
  username: litGhostUsername,
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
      const entropy = await contract.getEntropy();
      teePublicKey.value = entropy.teeEncPublicKey;
    } catch (error) {
      console.error('Failed to fetch TEE public key:', error);
      errorMessage.value = 'Failed to fetch TEE public key from contract. Make sure the contract is bootstrapped.';
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

// PKP Gas Management
const {
  pkpBalance,
  pkpBalanceLoading,
  totalGasNeeded,
  needsTopUp,
  canAffordTopUp,
  transactionsRemaining,
  formatEthBalance,
  topUpGas,
  NUM_TRANSACTIONS
} = usePkpGas({
  pkpAddress: bootstrapData.pkp.ethAddress,
  provider,
  signer,
  chainId,
  expectedChainId
});

// Gas top-up state management
type GasTopUpState = 'idle' | 'processing' | 'success' | 'error';
const gasTopUpState = ref<GasTopUpState>('idle');
const gasTopUpTxHash = ref<string | null>(null);
const gasTopUpError = ref<string>('');

// Handle gas top-up
async function handleTopUpGas() {
  gasTopUpState.value = 'processing';
  gasTopUpTxHash.value = null;
  gasTopUpError.value = '';

  const result = await topUpGas();

  if (result.success) {
    gasTopUpTxHash.value = result.txHash || null;
    gasTopUpState.value = 'success';
    // Auto-reset after 5 seconds
    setTimeout(() => {
      gasTopUpState.value = 'idle';
      gasTopUpTxHash.value = null;
    }, 5000);
  } else if (result.cancelled) {
    // User cancelled the transaction - reset to idle
    console.log('User cancelled gas top-up');
    gasTopUpState.value = 'idle';
  } else {
    gasTopUpError.value = result.error || 'Failed to top up gas';
    gasTopUpState.value = 'error';
  }
}

// Reset gas top-up state
function resetGasTopUpState() {
  gasTopUpState.value = 'idle';
  gasTopUpTxHash.value = null;
  gasTopUpError.value = '';
}

// Block explorer URL for gas top-up tx
const gasTopUpExplorerUrl = computed(() => {
  const baseUrl = import.meta.env.VITE_BLOCK_EXPLORER || 'https://etherscan.io';
  return gasTopUpTxHash.value ? `${baseUrl}/tx/${gasTopUpTxHash.value}` : '';
});

// Copy transaction hash to clipboard
async function copyGasTxHash() {
  if (!gasTopUpTxHash.value) return;

  try {
    await navigator.clipboard.writeText(gasTopUpTxHash.value);
  } catch (err) {
    console.error('Failed to copy:', err);
  }
}

// Truncate address for display
const truncatedAddress = computed(() => {
  if (!address.value) return '';
  // Ethereum address is 42 chars (0x + 40 hex chars)
  // Show first 6 chars (0x + 4 hex) and last 4 chars
  return `${address.value.slice(0, 10)}...${address.value.slice(-8)}`;
});

// Connection status variant and text
const connectionStatus = computed(() => {
  // Check if no Web3 provider is available
  if (!hasWeb3Provider.value) {
    return { variant: 'secondary', text: 'No Web3', class: 'border-gray-500 text-gray-500 bg-gray-500/10', dotClass: 'bg-gray-500' };
  }
  if (!connected.value) {
    return { variant: 'destructive', text: 'Connect', class: 'border-orange-500 text-orange-500 bg-orange-500/10', dotClass: 'bg-orange-500' };
  }
  if (!isCorrectNetwork()) {
    return { variant: 'default', text: `Wrong Network`, class: 'border-yellow-500 text-yellow-500 bg-yellow-500/10', dotClass: 'bg-yellow-500' };
  }
  return { variant: 'outline', text: correctChainName, class: 'border-emerald-400 text-emerald-400 bg-emerald-400/10', dotClass: 'bg-emerald-400' };
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
              <span class="w-2 h-2 rounded-full mr-2" :class="connectionStatus.dotClass"></span>
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

      <!-- Private Balance Login Card (when not logged in) -->
      <Card v-if="!litGhostSecret">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <span class="text-3xl">🔐</span>
            Private Balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div class="space-y-4">
            <div class="space-y-3">
              <Textarea
                v-model="secretInput"
                placeholder="Paste your username & secret here, exported / copied from the LitGhost Telegram Mini App"
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
                size="lg"
              >
                <span v-if="secretLoading">Importing...</span>
                <span v-else>Login</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Private Balance Manager (when logged in) -->
      <PrivateBalanceManager
        v-if="litGhostSecret"
        :ghost-client="gc"
        :private-key="litGhostSecret"
        :username="litGhostUsername"
        :provider="rpcProvider"
        :lit-ghost-contract="litGhostContractReadOnly"
        :tee-public-key="teePublicKey"
      />

      <!-- LitGhost Account Accordion (only when logged in) -->
      <div v-if="litGhostSecret">
        <Accordion type="single" collapsible class="w-full">
          <AccordionItem value="account">
            <AccordionTrigger class="text-left">
              <div class="flex items-center justify-between w-full pr-4">
                <span class="font-medium">LitGhost Account</span>
                <Badge variant="default" class="ml-2">
                  Logged In
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div class="space-y-4 pt-2">
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
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      <!-- Gas Top-Up Accordion (only when connected and on correct network) -->
      <div v-if="connected && isCorrectNetwork()">
        <Accordion type="single" collapsible class="w-full">
          <AccordionItem value="gas">
            <AccordionTrigger class="text-left">
              <div class="flex items-center justify-between w-full pr-4">
                <span class="font-medium">⛽ Top Up Bot Gas</span>
                <Badge
                  :variant="needsTopUp ? 'destructive' : 'outline'"
                  :class="needsTopUp ? 'bg-red-500/10 border-red-500 text-red-500' : ''"
                  class="ml-2"
                >
                  {{ needsTopUp ? 'Low Gas!' : `${transactionsRemaining} tx left` }}
                </Badge>
              </div>
            </AccordionTrigger>
            <AccordionContent>
              <div class="space-y-4 pt-2">
                <!-- PKP Balance Info -->
                <div class="bg-muted rounded-md p-4 space-y-2">
                  <div class="flex justify-between text-sm">
                    <span class="text-muted-foreground">Bot Balance:</span>
                    <span class="font-mono">{{ formatEthBalance(pkpBalance) }} ETH</span>
                  </div>
                  <div class="flex justify-between text-sm">
                    <span class="text-muted-foreground">Transactions Remaining:</span>
                    <span :class="transactionsRemaining < 20 ? 'text-orange-500 font-semibold' : ''">
                      ~{{ transactionsRemaining }}
                    </span>
                  </div>
                  <div class="flex justify-between text-sm">
                    <span class="text-muted-foreground">Top-up Amount:</span>
                    <span class="font-mono">{{ formatEthBalance(totalGasNeeded) }} ETH ({{ NUM_TRANSACTIONS }} tx)</span>
                  </div>
                </div>

                <!-- Processing State -->
                <div v-if="gasTopUpState === 'processing'" class="bg-muted rounded-md p-4 text-center">
                  <div class="w-12 h-12 mx-auto mb-3 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                  <p class="text-sm font-medium">Waiting for confirmation...</p>
                  <p class="text-xs text-muted-foreground mt-1">Please confirm the transaction in your wallet</p>
                </div>

                <!-- Success State -->
                <div v-else-if="gasTopUpState === 'success'" class="bg-emerald-500/10 border border-emerald-500/50 rounded-lg p-4">
                  <div class="flex items-start gap-3">
                    <div class="w-10 h-10 flex-shrink-0 bg-emerald-500/20 rounded-full flex items-center justify-center text-xl">
                      ✓
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-sm font-semibold text-emerald-700 dark:text-emerald-400 mb-2">
                        Top-up Complete!
                      </p>
                      <div v-if="gasTopUpTxHash" class="flex items-center gap-2">
                        <p class="text-xs font-mono text-muted-foreground truncate flex-1">{{ gasTopUpTxHash }}</p>
                        <Button
                          @click="copyGasTxHash"
                          variant="ghost"
                          size="sm"
                          class="h-7 px-2 flex-shrink-0"
                          title="Copy transaction hash"
                        >
                          📋
                        </Button>
                        <a
                          v-if="gasTopUpExplorerUrl"
                          :href="gasTopUpExplorerUrl"
                          target="_blank"
                          class="inline-flex items-center justify-center h-7 px-2 text-sm font-medium rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground flex-shrink-0"
                          title="View on explorer"
                        >
                          ↗
                        </a>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Error State -->
                <div v-else-if="gasTopUpState === 'error'" class="bg-red-500/10 border border-red-500/50 rounded-lg p-4">
                  <div class="flex items-start gap-3">
                    <div class="w-10 h-10 flex-shrink-0 bg-red-500/20 rounded-full flex items-center justify-center text-xl">
                      ❌
                    </div>
                    <div class="flex-1">
                      <p class="text-sm font-semibold text-red-700 dark:text-red-400 mb-1">
                        Top-up Failed
                      </p>
                      <p class="text-xs text-red-600 dark:text-red-300">{{ gasTopUpError }}</p>
                      <Button
                        @click="resetGasTopUpState"
                        variant="ghost"
                        size="sm"
                        class="mt-2 h-7 px-3 text-xs"
                      >
                        Dismiss
                      </Button>
                    </div>
                  </div>
                </div>

                <!-- Idle State: Warnings and Button -->
                <template v-else>
                  <!-- Warning if low gas -->
                  <div v-if="needsTopUp" class="bg-red-500/10 border border-red-500/50 rounded-lg p-4">
                    <p class="text-sm text-red-700 dark:text-red-400 font-medium">
                      ⚠️ The bot is running low on gas! Please top up to keep it running smoothly.
                    </p>
                  </div>

                  <!-- Warning if can't afford -->
                  <div v-if="needsTopUp && !canAffordTopUp" class="bg-yellow-500/10 border border-yellow-500/50 rounded-lg p-4">
                    <p class="text-sm text-yellow-700 dark:text-yellow-400">
                      You don't have enough ETH in your wallet to top up the bot. Please add more ETH to your wallet.
                    </p>
                  </div>

                  <!-- Top Up Button -->
                  <Button
                    @click="handleTopUpGas"
                    :disabled="pkpBalanceLoading || !canAffordTopUp"
                    :variant="needsTopUp ? 'default' : 'outline'"
                    class="w-full"
                    size="lg"
                  >
                    <span v-if="pkpBalanceLoading">Loading...</span>
                    <span v-else-if="needsTopUp">🚨 Top Up Gas Now</span>
                    <span v-else>🤝 Be Kind, Top Up Gas</span>
                  </Button>

                  <p class="text-xs text-muted-foreground text-center">
                    The bot pays gas for all Lit Action executions. Top ups help keep the demo running!
                  </p>
                </template>
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

