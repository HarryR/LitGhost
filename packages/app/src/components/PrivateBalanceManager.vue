<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import AmountInput from './inputs/AmountInput.vue'
import TelegramUsernameInput from './inputs/TelegramUsernameInput.vue'
import EthereumAddressInput from './inputs/EthereumAddressInput.vue'
import type { IGhostClient } from '../ighostclient'
import { Wallet } from '@ethersproject/wallet'
import { UserClient } from '@monorepo/core'
import { arrayify } from '@ethersproject/bytes'

interface Props {
  ghostClient: IGhostClient | null
  privateKey: string | null
  provider: any
  litGhostContract: any
  teePublicKey: string | null
  /** How often to automatically refresh balance (in milliseconds). Default: 5 minutes */
  refreshInterval?: number
  /** Minimum time between refresh requests (in milliseconds). Default: 10 seconds */
  minRefreshTime?: number
}

const props = withDefaults(defineProps<Props>(), {
  refreshInterval: 5 * 60 * 1000, // 5 minutes
  minRefreshTime: 10 * 1000 // 10 seconds
})

// Emit events for parent components
const emit = defineEmits<{
  transactionComplete: [txHash: string]
  balanceUpdate: [newBalance: string]
}>()

// State management
type ActionType = 'internal' | 'withdraw'
type ViewState = 'form' | 'processing' | 'success' | 'error'

const actionType = ref<ActionType>('internal')
const viewState = ref<ViewState>('form')
const username = ref<string>('')
const withdrawAddress = ref<string>('')
const amount = ref<string>('')
const txHash = ref<string | null>(null)
const errorMessage = ref<string>('')
const processedAmount = ref<string>('')
const processedDestination = ref<string>('')
const newBalance = ref<string | null>(null)

// Template refs for auto-focus
const usernameInputRef = ref<InstanceType<typeof TelegramUsernameInput> | null>(null)
const addressInputRef = ref<InstanceType<typeof EthereumAddressInput> | null>(null)

// Balance state
const balance = ref<number | null>(null)
const isRegistered = ref<boolean>(false)
const isLoadingBalance = ref(false)
const balanceError = ref<string | null>(null)
const lastRefreshTime = ref<number>(0)
const isRefreshing = ref(false)
const hasLoadedOnce = ref(false)

// Refresh balance with debouncing
async function refreshBalance(force: boolean = false): Promise<void> {
  const now = Date.now()

  // Check if we should skip this refresh
  if (!force && isRefreshing.value) {
    console.log('Balance refresh already in progress, skipping')
    return
  }

  if (!force && (now - lastRefreshTime.value) < props.minRefreshTime) {
    console.log(`Balance refreshed too recently (${Math.round((now - lastRefreshTime.value) / 1000)}s ago), skipping`)
    return
  }

  const { privateKey, litGhostContract, teePublicKey } = props

  if (!privateKey || !litGhostContract || !teePublicKey) {
    balance.value = null
    isRegistered.value = false
    return
  }

  isRefreshing.value = true
  isLoadingBalance.value = true
  balanceError.value = null

  try {
    // Create wallet from private key to get compressed public key
    const userWallet = new Wallet(privateKey)
    // Skip parity byte from compressed public key - we know it's always 0x02
    const userPublicKey = arrayify('0x' + userWallet._signingKey().compressedPublicKey.slice(4))
    const teePublicKeyBytes = arrayify(teePublicKey)

    // Create UserClient
    const userClient = new UserClient(
      arrayify(privateKey),
      userPublicKey,
      teePublicKeyBytes,
      litGhostContract
    )

    // Fetch balance and registration status
    const [bal, reg] = await Promise.all([
      userClient.getBalance(),
      userClient.isRegistered()
    ])

    balance.value = bal
    isRegistered.value = reg
    lastRefreshTime.value = Date.now()
    hasLoadedOnce.value = true
  } catch (error) {
    console.error('Failed to fetch balance:', error)
    balanceError.value = error instanceof Error ? error.message : 'Failed to fetch balance'
    balance.value = 0
    isRegistered.value = false
    hasLoadedOnce.value = true
  } finally {
    isRefreshing.value = false
    isLoadingBalance.value = false
  }
}

// Fetch balance when dependencies are available
watch(
  () => [props.privateKey, props.litGhostContract, props.teePublicKey],
  () => {
    // Reset loaded state when dependencies change (e.g., switching accounts)
    hasLoadedOnce.value = false
    // Force refresh when dependencies change
    refreshBalance(true)
  },
  { immediate: true }
)

// Set up automatic polling
let refreshIntervalId: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  // Start polling
  refreshIntervalId = setInterval(() => {
    refreshBalance(false)
  }, props.refreshInterval)
})

onUnmounted(() => {
  // Clean up interval on component unmount
  if (refreshIntervalId) {
    clearInterval(refreshIntervalId)
    refreshIntervalId = null
  }
})

// Format balance for display (2 internally)
const privateBalance = computed(() => {
  if (balance.value === null) return '...'
  return (balance.value / 1_00).toFixed(2)
})

// Computed property to check if we have everything needed
const isReady = computed(() => props.ghostClient && props.privateKey && hasLoadedOnce.value && balance.value !== null)

// Clean username (strip @ and whitespace) for internal transfers
const cleanedUsername = computed(() => {
  let cleaned = username.value.trim()
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.slice(1)
  }
  return cleaned
})

// Get the current destination based on action type
const destination = computed(() => {
  return actionType.value === 'internal' ? cleanedUsername.value : withdrawAddress.value
})

// Form validation - check if all required fields are filled
// The actual validation is handled by the input components
const isFormValid = computed(() => {
  if (!amount.value || !destination.value) return false
  return true
})

// Block explorer URL from environment
const blockExplorerUrl = computed(() => {
  const baseUrl = import.meta.env.VITE_BLOCK_EXPLORER || 'https://etherscan.io'
  return txHash.value ? `${baseUrl}/tx/${txHash.value}` : ''
})

// Toggle between internal transfer and withdraw
async function setActionType(type: ActionType) {
  actionType.value = type
  // Clear inputs when switching types
  username.value = ''
  withdrawAddress.value = ''
  amount.value = ''

  // Auto-focus the appropriate input after DOM updates
  await nextTick()
  if (type === 'internal' && usernameInputRef.value) {
    // Focus the input element inside the TelegramUsernameInput component
    const inputEl = usernameInputRef.value.$el?.querySelector('input')
    inputEl?.focus()
  } else if (type === 'withdraw' && addressInputRef.value) {
    // Focus the input element inside the EthereumAddressInput component
    const inputEl = addressInputRef.value.$el?.querySelector('input')
    inputEl?.focus()
  }
}

// Handle form submission
async function handleSend() {
  if (!isFormValid.value || !props.ghostClient || !props.privateKey) return

  viewState.value = 'processing'
  processedAmount.value = amount.value
  processedDestination.value = destination.value

  try {
    // TODO: Call Lit Action to process transfer/withdrawal
    // const result = await props.ghostClient.processStep({
    //   privateKey: props.privateKey,
    //   actionType: actionType.value,
    //   destination: destination.value,
    //   amount: amount.value
    // })

    // Placeholder for testing - simulate API call
    await new Promise(resolve => setTimeout(resolve, 2000))

    // TODO: Replace with actual response
    txHash.value = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    newBalance.value = (parseFloat(privateBalance.value) - parseFloat(amount.value)).toFixed(2)

    viewState.value = 'success'

    // Emit events
    emit('transactionComplete', txHash.value)
    if (newBalance.value) {
      emit('balanceUpdate', newBalance.value)
    }

  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : 'Failed to process transfer'
    viewState.value = 'error'
  }
}

// Reset to form view
function resetToForm() {
  viewState.value = 'form'
  username.value = ''
  withdrawAddress.value = ''
  amount.value = ''
  txHash.value = null
  errorMessage.value = ''
  processedAmount.value = ''
  processedDestination.value = ''
  newBalance.value = null
}
</script>

<template>
  <div class="space-y-6">
    <!-- Private Balance Card -->
    <Card v-if="isReady">
      <CardContent class="pt-6">
        <div class="space-y-4">
          <!-- Balance Display -->
          <div class="text-center py-2">
            <div class="flex items-center justify-center gap-2 mb-2">
              <p class="text-sm text-muted-foreground">Your Private Balance</p>
              <Badge v-if="!isRegistered" variant="outline" class="text-xs">
                Not on-chain yet
              </Badge>
              <Button
                @click="() => refreshBalance(false)"
                variant="ghost"
                size="sm"
                :disabled="isRefreshing"
                class="h-6 px-2 text-xs"
                title="Refresh balance"
              >
                <span :class="{ 'animate-spin': isRefreshing }">🔄</span>
              </Button>
            </div>
            <p class="text-4xl font-bold">
              {{ privateBalance }} <span class="text-lg font-normal text-muted-foreground">PYUSD</span>
            </p>
            <p v-if="balanceError" class="text-xs text-destructive mt-2">
              {{ balanceError }}
            </p>
          </div>

          <!-- Form View -->
          <div v-if="viewState === 'form'" class="space-y-4">
            <!-- Transfer Type Toggle -->
            <div>
              <div class="flex gap-2 justify-center">
                <Badge
                  :variant="actionType === 'internal' ? 'default' : 'outline'"
                  class="cursor-pointer px-4 py-2 text-sm"
                  @click="setActionType('internal')"
                >
                  🔄 Transfer
                </Badge>
                <Badge
                  :variant="actionType === 'withdraw' ? 'default' : 'outline'"
                  class="cursor-pointer px-4 py-2 text-sm"
                  @click="setActionType('withdraw')"
                >
                  💸 Withdraw
                </Badge>
              </div>
            </div>

            <!-- Destination Input (conditional based on type) -->
            <TelegramUsernameInput
              v-if="actionType === 'internal'"
              ref="usernameInputRef"
              v-model="username"
              label="To Username"
              :required="true"
            />
            <EthereumAddressInput
              v-else
              ref="addressInputRef"
              v-model="withdrawAddress"
              label="To Address"
              :required="true"
            />

            <!-- Amount Input -->
            <AmountInput
              v-model="amount"
              label="Amount"
              :balance="privateBalance"
              token-symbol="PYUSD"
              :required="true"
            />

            <!-- Send Button -->
            <Button
              @click="handleSend"
              :disabled="!isFormValid"
              class="w-full"
              size="lg"
            >
              Send →
            </Button>
          </div>

          <!-- Processing View -->
          <div v-else-if="viewState === 'processing'" class="space-y-4 py-8 text-center">
            <div class="w-16 h-16 mx-auto mb-4 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            <h3 class="text-xl font-semibold">Processing Transfer...</h3>
            <div class="space-y-2 text-sm text-muted-foreground">
              <p>• Submitting to Lit Action...</p>
              <p>• Waiting for blockchain...</p>
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
              <div class="flex justify-between text-sm">
                <span class="text-muted-foreground">To:</span>
                <span class="font-mono text-xs">{{ processedDestination }}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-muted-foreground">Transaction:</span>
                <a
                  :href="blockExplorerUrl"
                  target="_blank"
                  class="font-mono text-xs text-primary hover:underline"
                >
                  {{ txHash?.slice(0, 10) }}...{{ txHash?.slice(-8) }} ↗
                </a>
              </div>
              <div v-if="newBalance" class="flex justify-between text-sm pt-2 border-t border-border">
                <span class="text-muted-foreground">New Balance:</span>
                <span class="font-semibold">{{ newBalance }} PYUSD</span>
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
        </div>
      </CardContent>
    </Card>

    <!-- Not Ready State (Connecting to Lit Network) -->
    <Card v-else>
      <CardContent class="text-center py-8">
        <div class="w-16 h-16 mx-auto mb-4 mt-4 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
        <p class="text-muted-foreground">
          Connecting to Lit Network...
        </p>
      </CardContent>
    </Card>
  </div>
</template>
