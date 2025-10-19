<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted } from 'vue'
import { useWallet } from './composables/useWallet'
import { useTokenBalance } from './composables/useTokenBalance'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
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

const count = ref(0)
const { address, chainId, connected, connecting, connect, disconnect, switchChain, rawProvider, provider, signer, availableProviders, getProviders, checkExistingConnection } = useWallet();
const gc = shallowRef();

// Auto-connect to wallet if already authorized
onMounted(() => {
  checkExistingConnection();
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
const { balance: pyusdBalance, loading: balanceLoading, error: balanceError } = useTokenBalance({
  provider,
  address,
  chainId,
  expectedChainId,
  tokenAddress: pyusd_token_address,
  pollInterval: 10000 // Poll every 10 seconds
});

const formattedBalance = computed(() => {
  if (balanceLoading.value) return 'Loading...';
  if (balanceError.value) return 'Error loading balance';
  if (pyusdBalance.value === null) return '--';

  // Format with browser's locale and 2 decimal places
  const num = parseFloat(pyusdBalance.value);
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
});

(async () => {
  const {GhostClient} = await import('./lit');
  const x = new GhostClient(true);
  await x.connect();;
  gc.value = x;
})();

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

function handleDisconnect() {
  disconnect();
}

function handleSwitchToSepolia() {
  // Convert decimal chain ID to hex
  const chainIdHex = '0x' + expectedChainId.toString(16);
  switchChain(chainIdHex);
}

async function handleAddPYUSD() {
  if (!rawProvider.value) return;

  try {
    // rawProvider.value is already the EIP-1193 provider
    await rawProvider.value.request({
      method: 'wallet_watchAsset',
      params: {
        type: 'ERC20',
        options: {
          address: pyusd_token_address,
          symbol: 'PYUSD',
          decimals: 6,
          image: 'https://s2.coinmarketcap.com/static/img/coins/64x64/27772.png'
        }
      }
    })
  } catch (error) {
    console.error('Failed to add PYUSD token:', error);
  }
}

const correctChainName = import.meta.env.VITE_CHAIN;

const isCorrectNetwork = () => chainId.value === expectedChainId;
</script>

<template>
  <div class="min-h-screen bg-background p-6">
    <div class="max-w-4xl mx-auto pt-12 space-y-8">
      <!-- Header -->
      <header class="text-center mb-12">
        <h1 class="text-5xl font-bold mb-3">
          Web3 Portal
        </h1>
        <p class="text-muted-foreground text-lg">Connect your wallet to get started</p>
      </header>

      <!-- Wallet Card -->
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <CardTitle class="flex items-center gap-2">
              <span class="text-3xl">🔐</span>
              Wallet
            </CardTitle>
            <Badge v-if="connected" variant="outline" class="border-emerald-400/50 text-emerald-400">
              <span class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse mr-2"></span>
              Connected
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
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
            <div class="space-y-2">
              <p class="text-sm text-muted-foreground">Wallet Address</p>
              <p class="font-mono text-sm break-all">{{ address }}</p>
            </div>

            <Separator />

            <div class="space-y-2">
              <p class="text-sm text-muted-foreground">Network</p>
              <div class="flex items-center gap-2">
                <Badge v-if="isCorrectNetwork()" variant="outline" class="border-emerald-400/50 text-emerald-400">
                  {{ correctChainName }} (Chain ID: {{ chainId }})
                </Badge>
                <Badge v-else variant="destructive">
                  Wrong Network (Chain ID: {{ chainId }})
                </Badge>
              </div>
              <p v-if="!isCorrectNetwork()" class="text-sm text-destructive">
                Please switch to {{ correctChainName }} (Chain ID: {{ expectedChainId }})
              </p>
            </div>

            <Separator />

            <div class="space-y-2">
              <p class="text-sm text-muted-foreground">PYUSD Balance</p>
              <div class="flex items-center gap-2">
                <p class="text-2xl font-bold">{{ formattedBalance }}</p>
                <span class="text-sm text-muted-foreground">PYUSD</span>
              </div>
            </div>

            <Separator />

            <div class="flex flex-col sm:flex-row gap-3 pt-2">
              <Button v-if="!isCorrectNetwork()" variant="secondary" @click="handleSwitchToSepolia" class="flex-1">
                Switch to {{ correctChainName }}
              </Button>
              <Button variant="outline" @click="handleAddPYUSD" class="flex-1">
                Add PYUSD Token
              </Button>
              <Button variant="destructive" @click="handleDisconnect">
                Disconnect
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Transfer Widget - Only visible when contract is available (correct network) -->
      <TransferWidget
        v-if="litGhostContract"
        :lit-ghost-contract="litGhostContract"
        :signer="signer"
        :pyusd-balance="pyusdBalance"
        :token-address="pyusd_token_address"
        :tee-public-key="teePublicKey"
        @error="handleTransferError"
        @success="handleTransferSuccess"
      />

      <!-- Demo Counter -->
      <Card>
        <CardHeader>
          <CardTitle class="text-center">Demo Counter</CardTitle>
        </CardHeader>
        <CardContent class="text-center space-y-4">
          <div class="text-6xl font-bold">
            {{ count }}
          </div>
          <Button @click="count++" size="lg" class="w-full sm:w-auto">
            Increment Counter
          </Button>
        </CardContent>
      </Card>
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

