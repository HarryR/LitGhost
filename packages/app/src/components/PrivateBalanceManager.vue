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
import { keccak256 } from '@ethersproject/solidity'
import { defaultAbiCoder } from '@ethersproject/abi'
import type { TransferWithdrawOperation } from '@monorepo/lit-action/params'

interface Props {
  ghostClient: IGhostClient | null
  privateKey: string | null
  username: string | null
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

// Processing status tracking
const processingStatus = ref<string>('')

// Template refs for auto-focus and accessing parsed values
const usernameInputRef = ref<InstanceType<typeof TelegramUsernameInput> | null>(null)
const addressInputRef = ref<InstanceType<typeof EthereumAddressInput> | null>(null)
const amountInputRef = ref<InstanceType<typeof AmountInput> | null>(null)

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

// Get the current destination based on action type
// For internal transfers, we'll get the cleaned username from the input component ref
const destination = computed(() => {
  if (actionType.value === 'internal') {
    // cleanedValue is automatically unwrapped from ComputedRef by defineExpose
    return usernameInputRef.value?.cleanedValue || ''
  }
  return withdrawAddress.value
})

// Create signed operation for transfer/withdraw
async function createSignedOperation(
  fromUsername: string,
  privateKey: string,
  nonce: number,
  operationType: 'transfer' | 'withdraw',
  destination: string,
  amountCents: number
): Promise<TransferWithdrawOperation> {
  // Create wallet from private key
  const wallet = new Wallet(privateKey)

  // Construct message digest for signature
  // Message format: hash(fromTelegramUsername, nonce, operationType, destination, amountCents)
  // IMPORTANT: Must use defaultAbiCoder.encode (standard ABI encoding) to match verification in Lit Action
  const encodedMessage = defaultAbiCoder.encode(
    ['string', 'uint256', 'string', 'string', 'uint256'],
    [fromUsername, nonce, operationType, destination, amountCents]
  )
  const messageHash = keccak256(['bytes'], [encodedMessage])

  // Sign the raw digest (not using signMessage which adds Ethereum prefix)
  // @ts-ignore - _signDigest is not in the public API but we need it
  const signature = wallet._signingKey().signDigest(messageHash)
  const { v, r, s } = signature

  return {
    fromTelegramUsername: fromUsername,
    balanceLeafNonce: nonce,
    operationType,
    destination,
    amountCents,
    signature: { v, r, s }
  }
}

// Form validation - check if all required fields are filled and valid
// The actual validation is handled by the input components
const isFormValid = computed(() => {
  // For internal transfers, check username validity
  if (actionType.value === 'internal') {
    const usernameInput = usernameInputRef.value
    if (!usernameInput) return false
    // Exposed computed refs are automatically unwrapped by defineExpose
    if (!usernameInput.isValid) return false
    if (!usernameInput.cleanedValue) return false
  }

  // For withdrawals, check address validity (basic check)
  if (actionType.value === 'withdraw') {
    if (!withdrawAddress.value) return false
  }

  // Check if amount input has a valid parsed value
  const amountInput = amountInputRef.value
  if (!amountInput) return false
  // Exposed computed refs are automatically unwrapped by defineExpose
  if (!amountInput.isValid) return false
  if (!amountInput.parsedValue) return false

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
  if (!isFormValid.value || !props.ghostClient || !props.privateKey || !props.username) return

  // IMPORTANT: Capture values from refs BEFORE changing viewState
  // When viewState changes, the form is destroyed and refs become null
  const parsedAmount = amountInputRef.value?.parsedValue
  if (!parsedAmount) {
    throw new Error(`Invalid amount: ${parsedAmount}`)
  }

  viewState.value = 'processing'
  processedAmount.value = amount.value
  processedDestination.value = destination.value

  try {
    processingStatus.value = 'Preparing transaction...'

    // Get current balance nonce from contract
    const userWallet = new Wallet(props.privateKey)
    const userPublicKey = arrayify('0x' + userWallet._signingKey().compressedPublicKey.slice(4))
    const teePublicKeyBytes = arrayify(props.teePublicKey!)

    const userClient = new UserClient(
      arrayify(props.privateKey),
      userPublicKey,
      teePublicKeyBytes,
      props.litGhostContract
    )

    // Get leaf index and fetch leaf to get current nonce
    const leafIdx = await userClient.getLeafIndex()
    const leaves = await props.litGhostContract.getLeaves([leafIdx])
    const currentNonce = Number(leaves[0].nonce)

    // Convert amount from decimal (2 decimals) to cents (integer)
    const amountCents = Math.round(parsedAmount * 100)

    // Map actionType to operation type ('internal' -> 'transfer')
    const operationType: 'transfer' | 'withdraw' = actionType.value === 'internal' ? 'transfer' : 'withdraw'

    processingStatus.value = 'Signing operation...'

    // Create signed operation
    // Use processedDestination instead of destination.value because the form
    // has been destroyed at this point (viewState changed to 'processing')
    const operation = await createSignedOperation(
      props.username,
      props.privateKey,
      currentNonce,
      operationType,
      processedDestination.value,
      amountCents
    )

    processingStatus.value = 'Submitting to Lit Action...'

    // Call Lit Action
    const result = await props.ghostClient.transferWithdraw([operation])

    // Extract transaction hash
    txHash.value = result.updateTxHash

    processingStatus.value = 'Waiting for blockchain confirmation...'

    // Wait for transaction to be mined (with polling fallback)
    console.log('Waiting for transaction:', txHash.value)
    let receipt = null
    const maxAttempts = 30 // 30 attempts * 2 seconds = 60 seconds max
    for (let i = 0; i < maxAttempts; i++) {
      try {
        receipt = await props.provider.getTransactionReceipt(txHash.value)
        if (receipt) {
          console.log('Transaction mined! Receipt:', receipt)
          if (receipt.status === 0) {
            throw new Error('Transaction failed on-chain')
          }
          break
        }
      } catch (err) {
        console.error('Error fetching receipt:', err)
      }

      // Wait 2 seconds before next attempt
      await new Promise(resolve => setTimeout(resolve, 5000))
      console.log(`Polling for receipt... attempt ${i + 1}/${maxAttempts}`)
    }

    if (!receipt) {
      console.warn('Transaction not confirmed after 60s, but continuing anyway')
    }

    processingStatus.value = 'Refreshing balance...'

    // Refresh balance after successful transaction
    await refreshBalance(true)

    // Update newBalance for display
    newBalance.value = privateBalance.value

    viewState.value = 'success'

    // Emit events
    emit('transactionComplete', txHash.value)
    if (newBalance.value) {
      emit('balanceUpdate', newBalance.value)
    }

  } catch (err) {
    console.error('Transfer/withdraw error:', err)

    // Extract detailed error message from GhostClientError
    if (err instanceof Error && 'details' in err && err.details) {
      console.error('Error details:', err.details)
      // Show both the message and details
      errorMessage.value = `${err.message}\n\nDetails: ${JSON.stringify(err.details, null, 2)}`
    } else {
      errorMessage.value = err instanceof Error ? err.message : 'Failed to process transfer'
    }

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
  processingStatus.value = ''
}

// Copy transaction hash to clipboard
async function copyTxHash() {
  if (!txHash.value) return

  try {
    await navigator.clipboard.writeText(txHash.value)
    // Could show a toast notification here if desired
  } catch (err) {
    console.error('Failed to copy:', err)
    // Fallback: select and copy (for older browsers)
    const textArea = document.createElement('textarea')
    textArea.value = txHash.value
    textArea.style.position = 'fixed'
    textArea.style.left = '-999999px'
    document.body.appendChild(textArea)
    textArea.select()
    try {
      document.execCommand('copy')
    } catch (err2) {
      console.error('Fallback copy failed:', err2)
    }
    document.body.removeChild(textArea)
  }
}

// Create Telegram deep-link to notify recipient
const telegramNotifyLink = computed(() => {
  // Only create link for internal transfers (not withdrawals)
  if (actionType.value !== 'internal' || !processedDestination.value || !processedAmount.value) {
    return null
  }

  const username = processedDestination.value.startsWith('@')
    ? processedDestination.value.slice(1)
    : processedDestination.value

  const message = `I sent you ${processedAmount.value} PYUSD with @LitGhostBot`

  // URL encode the message
  const encodedMessage = encodeURIComponent(message)

  return `https://t.me/${username}?text=${encodedMessage}`
})

// Detect if we're running in Telegram
const isInTelegram = computed(() => {
  return typeof window !== 'undefined' && window.Telegram?.WebApp?.initData
})

// QR Code Scanner for Telegram usernames
async function scanQRCodeForUsername() {
  if (!isInTelegram.value) {
    console.error('QR scanner only available in Telegram')
    return
  }

  try {
    window.Telegram.WebApp.showScanQrPopup(
      {
        text: 'Scan a Telegram username QR code'
      },
      (scannedData: string) => {
        if (scannedData) {
          // The scanned data might be a URL like t.me/username or just @username or username
          let extractedUsername = scannedData

          // Handle t.me/username format
          if (scannedData.includes('t.me/')) {
            const match = scannedData.match(/t\.me\/([a-zA-Z0-9_]+)/)
            if (match && match[1]) {
              extractedUsername = match[1]
            }
          }
          // Handle @username format
          else if (scannedData.startsWith('@')) {
            extractedUsername = scannedData.slice(1)
          }

          // Set the username field
          username.value = extractedUsername

          // Close the scanner
          window.Telegram.WebApp.closeScanQrPopup()
          return true // Return true to close the popup
        }
        return false // Keep the popup open if no data
      }
    )
  } catch (err) {
    console.error('Failed to open QR scanner:', err)
  }
}

// QR Code Scanner for Ethereum addresses
async function scanQRCodeForAddress() {
  if (!isInTelegram.value) {
    console.error('QR scanner only available in Telegram')
    return
  }

  try {
    window.Telegram.WebApp.showScanQrPopup(
      {
        text: 'Scan an Ethereum address QR code'
      },
      (scannedData: string) => {
        if (scannedData) {
          // The scanned data might be just an address or an ethereum: URI
          let extractedAddress = scannedData

          // Handle ethereum:0x... format
          if (scannedData.toLowerCase().startsWith('ethereum:')) {
            const match = scannedData.match(/ethereum:(0x[a-fA-F0-9]{40})/i)
            if (match && match[1]) {
              extractedAddress = match[1]
            }
          }
          // Validate it looks like an Ethereum address (0x followed by 40 hex chars)
          else if (/^0x[a-fA-F0-9]{40}$/i.test(scannedData)) {
            extractedAddress = scannedData
          }
          // Try to extract address if it's embedded in a longer string
          else {
            const match = scannedData.match(/(0x[a-fA-F0-9]{40})/i)
            if (match && match[1]) {
              extractedAddress = match[1]
            }
          }

          // Set the address field
          withdrawAddress.value = extractedAddress

          // Close the scanner
          window.Telegram.WebApp.closeScanQrPopup()
          return true // Return true to close the popup
        }
        return false // Keep the popup open if no data
      }
    )
  } catch (err) {
    console.error('Failed to open QR scanner:', err)
  }
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
            <div v-if="actionType === 'internal'">
              <div class="flex gap-2 items-end">
                <div class="flex-1">
                  <TelegramUsernameInput
                    ref="usernameInputRef"
                    v-model="username"
                    label="To Username"
                    :required="true"
                  />
                </div>
                <Button
                  v-if="isInTelegram"
                  @click="scanQRCodeForUsername"
                  variant="outline"
                  size="icon"
                  type="button"
                  title="Scan QR Code"
                  class="h-10 w-10 shrink-0"
                >
                  <svg fill="currentColor" viewBox="0 0 24 24"><path d="M4 4h6v6H4zm16 0v6h-6V4zm-6 11h2v-2h-2v-2h2v2h2v-2h2v2h-2v2h2v3h-2v2h-2v-2h-3v2h-2v-4h3zm2 0v3h2v-3zM4 20v-6h6v6zM6 6v2h2V6zm10 0v2h2V6zM6 16v2h2v-2zm-2-5h2v2H4zm5 0h4v4h-2v-2H9zm2-5h2v4h-2zM2 2v4H0V2a2 2 0 0 1 2-2h4v2zm20-2a2 2 0 0 1 2 2v4h-2V2h-4V0zM2 18v4h4v2H2a2 2 0 0 1-2-2v-4zm20 4v-4h2v4a2 2 0 0 1-2 2h-4v-2z"/></svg>
                </Button>
              </div>
            </div>
            <div v-else>
              <div class="flex gap-2 items-end">
                <div class="flex-1">
                  <EthereumAddressInput
                    ref="addressInputRef"
                    v-model="withdrawAddress"
                    label="To Address"
                    :required="true"
                  />
                </div>
                <Button
                  v-if="isInTelegram"
                  @click="scanQRCodeForAddress"
                  variant="outline"
                  size="icon"
                  type="button"
                  title="Scan QR Code"
                  class="h-10 w-10 shrink-0"
                >
                  <svg fill="currentColor" viewBox="0 0 24 24"><path d="M4 4h6v6H4zm16 0v6h-6V4zm-6 11h2v-2h-2v-2h2v2h2v-2h2v2h-2v2h2v3h-2v2h-2v-2h-3v2h-2v-4h3zm2 0v3h2v-3zM4 20v-6h6v6zM6 6v2h2V6zm10 0v2h2V6zM6 16v2h2v-2zm-2-5h2v2H4zm5 0h4v4h-2v-2H9zm2-5h2v4h-2zM2 2v4H0V2a2 2 0 0 1 2-2h4v2zm20-2a2 2 0 0 1 2 2v4h-2V2h-4V0zM2 18v4h4v2H2a2 2 0 0 1-2-2v-4zm20 4v-4h2v4a2 2 0 0 1-2 2h-4v-2z"/></svg>
                </Button>
              </div>
            </div>

            <!-- Amount Input -->
            <AmountInput
              ref="amountInputRef"
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
            <h3 class="text-xl font-semibold">Processing {{ actionType === 'internal' ? 'Transfer' : 'Withdrawal' }}...</h3>
            <div class="space-y-2 text-sm text-muted-foreground">
              <p v-if="processingStatus">{{ processingStatus }}</p>
            </div>

            <!-- Transaction Hash Display (once available) -->
            <div v-if="txHash" class="mt-4 bg-muted rounded-md p-4">
              <div class="flex items-center justify-between gap-2">
                <div class="flex-1 min-w-0">
                  <p class="text-xs text-muted-foreground mb-1">Transaction ID</p>
                  <p class="font-mono text-xs truncate">{{ txHash }}</p>
                </div>
                <div class="flex gap-2">
                  <Button
                    @click="copyTxHash"
                    variant="ghost"
                    size="sm"
                    class="h-8 px-2"
                    title="Copy transaction hash"
                  >
                    📋
                  </Button>
                  <a
                    v-if="blockExplorerUrl"
                    :href="blockExplorerUrl"
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
                <span class="font-mono text-xs truncate">{{ processedDestination }}</span>
              </div>
              <div class="flex justify-between text-sm gap-2">
                <span class="text-muted-foreground shrink-0">Transaction:</span>
                <a
                  :href="blockExplorerUrl"
                  target="_blank"
                  class="font-mono text-xs text-primary hover:underline truncate"
                >
                  {{ txHash }} ↗
                </a>
              </div>
              <div v-if="newBalance" class="flex justify-between text-sm pt-2 border-t border-border">
                <span class="text-muted-foreground">New Balance:</span>
                <span class="font-semibold">{{ newBalance }} PYUSD</span>
              </div>
            </div>

            <!-- Notify recipient button (only for internal transfers) -->
            <a
              v-if="telegramNotifyLink"
              :href="telegramNotifyLink"
              target="_blank"
              class="block"
            >
              <Button variant="default" class="w-full">
                💬 Notify @{{ processedDestination }}
              </Button>
            </a>

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
