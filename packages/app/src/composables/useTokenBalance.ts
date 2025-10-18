import { ref, watch, onUnmounted } from 'vue'
import type { Ref } from 'vue'

import { Contract } from '@ethersproject/contracts';
import { formatUnits } from '@ethersproject/units';
import { Web3Provider } from '@ethersproject/providers';

// ERC20 ABI - just the functions we need
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
]

interface UseTokenBalanceOptions {
  provider: Ref<Web3Provider | null>
  address: Ref<string | null>
  tokenAddress: string
  pollInterval?: number // in milliseconds
}

export function useTokenBalance(options: UseTokenBalanceOptions) {
  const { provider, address, tokenAddress, pollInterval = 10000 } = options

  const balance = ref<string | null>(null)
  const decimals = ref<number | null>(null)
  const symbol = ref<string | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let contract: Contract | null = null

  async function fetchTokenInfo() {
    if (!provider.value) return

    try {
      // Create contract instance
      if (!contract || contract.provider !== provider.value) {
        contract = new Contract(tokenAddress, ERC20_ABI, provider.value)
      }

      // Fetch decimals and symbol (these don't change)
      const [fetchedDecimals, fetchedSymbol] = await Promise.all([
        contract.decimals(),
        contract.symbol()
      ])

      decimals.value = fetchedDecimals
      symbol.value = fetchedSymbol
    } catch (err: any) {
      console.error('Failed to fetch token info:', err)
      decimals.value = null
      symbol.value = null
    }
  }

  async function fetchBalance() {
    // Don't fetch if not connected or no provider
    if (!provider.value || !address.value) {
      balance.value = null
      error.value = null
      return
    }

    // Fetch token info if we don't have it yet
    if (decimals.value === null) {
      await fetchTokenInfo()
    }

    // If still no decimals, can't format balance
    if (decimals.value === null) {
      error.value = 'Could not fetch token decimals'
      return
    }

    loading.value = true
    error.value = null

    try {
      // Create contract instance if needed
      if (!contract || contract.provider !== provider.value) {
        contract = new Contract(tokenAddress, ERC20_ABI, provider.value)
      }

      const rawBalance = await contract.balanceOf(address.value)

      // Format balance with proper decimals
      balance.value = formatUnits(rawBalance, decimals.value)
    } catch (err: any) {
      console.error('Failed to fetch token balance:', err)
      error.value = err.message || 'Failed to fetch balance'
      balance.value = null
    } finally {
      loading.value = false
    }
  }

  function startPolling() {
    stopPolling()

    // Fetch immediately
    fetchBalance()

    // Then poll at interval
    if (pollInterval > 0) {
      pollTimer = setInterval(fetchBalance, pollInterval)
    }
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  // Watch for provider changes to refetch token info
  watch(provider, (newProvider) => {
    if (newProvider) {
      // Reset token info when provider changes
      decimals.value = null
      symbol.value = null
      contract = null

      // Refetch if we have an address
      if (address.value) {
        fetchBalance()
      }
    } else {
      stopPolling()
      balance.value = null
      decimals.value = null
      symbol.value = null
      error.value = null
    }
  })

  // Watch for address changes
  watch(address, (newAddress) => {
    if (provider.value && newAddress) {
      startPolling()
    } else {
      stopPolling()
      balance.value = null
      error.value = null
    }
  }, { immediate: true })

  // Cleanup on unmount
  onUnmounted(() => {
    stopPolling()
  })

  return {
    balance,
    decimals,
    symbol,
    loading,
    error,
    refresh: fetchBalance
  }
}
