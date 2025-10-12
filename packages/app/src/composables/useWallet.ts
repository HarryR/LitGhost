import { ref, readonly, onUnmounted } from 'vue'
import { ethers } from 'ethers'
import { useEIP6963 } from './eip6963'

// State
const address = ref<string | null>(null)
const chainId = ref<number | null>(null)
const connected = ref(false)
const connecting = ref(false)
const provider = ref<ethers.providers.Web3Provider | null>(null)
const signer = ref<ethers.Signer | null>(null)

let currentProvider: any = null // EIP-1193 provider

const eip6963 = useEIP6963()

// Initialize EIP-6963 discovery
eip6963.startDiscovery()

// Helper to clear wallet state
function clearWalletState() {
  if (currentProvider) {
    removeEventListeners(currentProvider)
    currentProvider = null
  }
  address.value = null
  chainId.value = null
  connected.value = false
  provider.value = null
  signer.value = null
}

// Event handlers
function handleAccountsChanged(accounts: string[]) {
  if (accounts.length === 0) {
    // Disconnected
    clearWalletState()
  } else {
    address.value = accounts[0]
    if (provider.value) {
      signer.value = provider.value.getSigner()
    }
  }
}

function handleChainChanged(chainIdHex: string) {
  chainId.value = parseInt(chainIdHex, 16)

  // Recreate provider and signer with new chain
  if (currentProvider) {
    provider.value = new ethers.providers.Web3Provider(currentProvider, 'any')
    signer.value = provider.value.getSigner()
  }
}

function handleDisconnect() {
  clearWalletState()
}

function setupEventListeners(walletProvider: any) {
  walletProvider.on('accountsChanged', handleAccountsChanged)
  walletProvider.on('chainChanged', handleChainChanged)
  walletProvider.on('disconnect', handleDisconnect)
}

function removeEventListeners(walletProvider: any) {
  if (!walletProvider) return

  walletProvider.removeListener?.('accountsChanged', handleAccountsChanged)
  walletProvider.removeListener?.('chainChanged', handleChainChanged)
  walletProvider.removeListener?.('disconnect', handleDisconnect)
}

export function useWallet() {
  async function connect(rdns?: string) {
    connecting.value = true

    try {
      // Get provider (EIP-6963 or window.ethereum)
      const walletProvider = eip6963.getProvider(rdns)

      if (!walletProvider) {
        throw new Error('No wallet provider found')
      }

      // Request accounts
      const accounts = await walletProvider.request({
        method: 'eth_requestAccounts'
      })

      if (accounts.length === 0) {
        throw new Error('No accounts available')
      }

      // Get chain ID
      const chainIdHex = await walletProvider.request({
        method: 'eth_chainId'
      })

      // Store provider reference
      currentProvider = walletProvider

      // Create ethers provider and signer
      const ethersProvider = new ethers.providers.Web3Provider(walletProvider, 'any')

      // Update state
      address.value = accounts[0]
      chainId.value = parseInt(chainIdHex, 16)
      connected.value = true
      provider.value = ethersProvider
      signer.value = ethersProvider.getSigner()

      // Setup event listeners
      setupEventListeners(walletProvider)

      return true
    } catch (error) {
      console.error('Failed to connect wallet:', error)
      return false
    } finally {
      connecting.value = false
    }
  }

  function disconnect() {
    clearWalletState()
  }

  async function switchChain(chainIdHex: string) {
    if (!currentProvider) return false

    try {
      await currentProvider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }]
      })
      return true
    } catch (error: any) {
      // Chain not added to wallet
      if (error.code === 4902) {
        console.error('Chain not added to wallet. Use addChain() to add it first.')
      }
      console.error('Failed to switch chain:', error)
      return false
    }
  }

  async function addChain(chainParams: {
    chainId: string
    chainName: string
    nativeCurrency: { name: string; symbol: string; decimals: number }
    rpcUrls: string[]
    blockExplorerUrls?: string[]
  }) {
    if (!currentProvider) return false

    try {
      await currentProvider.request({
        method: 'wallet_addEthereumChain',
        params: [chainParams]
      })
      return true
    } catch (error) {
      console.error('Failed to add chain:', error)
      return false
    }
  }

  // Cleanup on unmount
  onUnmounted(() => {
    if (currentProvider) {
      removeEventListeners(currentProvider)
    }
  })

  return {
    // State
    address: readonly(address),
    chainId: readonly(chainId),
    connected: readonly(connected),
    connecting: readonly(connecting),
    provider: readonly(provider),
    signer: readonly(signer),

    // Actions
    connect,
    disconnect,
    switchChain,
    addChain,

    // EIP-6963
    availableProviders: eip6963.providers,
    getProviders: eip6963.getProviders
  }
}
