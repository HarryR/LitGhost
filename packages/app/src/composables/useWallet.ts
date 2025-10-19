import { ref, onUnmounted, shallowRef } from 'vue'
import { useEIP6963, type EIP1193Provider } from './eip6963'
import { Web3Provider } from '@ethersproject/providers';
import { Signer } from '@ethersproject/abstract-signer';

// State
const address = ref<string | null>(null)
const chainId = ref<number | null>(null)
const connected = ref(false)
const connecting = ref(false)
const provider = shallowRef<Web3Provider | null>(null)
const signer = shallowRef<Signer | null>(null)
const rawProvider = shallowRef<EIP1193Provider | null>(null)

let currentProvider: EIP1193Provider | null = null

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
  rawProvider.value = null
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
    provider.value = new Web3Provider(currentProvider, 'any')
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
  // Common logic to setup wallet state from provider and accounts
  function setupWalletState(walletProvider: any, accounts: string[], chainIdHex: string) {
    // Store provider reference
    currentProvider = walletProvider

    // Create ethers provider and signer
    const ethersProvider = new Web3Provider(walletProvider, 'any')

    // Update state
    address.value = accounts[0]
    chainId.value = parseInt(chainIdHex, 16)
    connected.value = true
    provider.value = ethersProvider
    signer.value = ethersProvider.getSigner()
    rawProvider.value = walletProvider

    // Setup event listeners
    setupEventListeners(walletProvider)
  }

  // Check for existing connection on mount
  async function checkExistingConnection() {
    try {
      const walletProvider = eip6963.getProvider()
      if (!walletProvider) return false

      // Check if already connected (don't request, just check)
      const accounts = await walletProvider.request({
        method: 'eth_accounts'
      })

      if (accounts.length === 0) return false

      // Get chain ID
      const chainIdHex = await walletProvider.request({
        method: 'eth_chainId'
      })

      setupWalletState(walletProvider, accounts, chainIdHex)
      console.log('Auto-connected to existing wallet session')
      return true
    } catch (error) {
      console.error('Failed to check existing connection:', error)
      return false
    }
  }

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

      setupWalletState(walletProvider, accounts, chainIdHex)
      return true
    }
    finally {
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

    await currentProvider.request({
      method: 'wallet_addEthereumChain',
      params: [chainParams]
    });

    return true
  }

  // Cleanup on unmount
  onUnmounted(() => {
    if (currentProvider) {
      removeEventListeners(currentProvider)
    }
  })

  return {
    // State
    address,
    chainId,
    connected,
    connecting,
    provider,
    signer,
    rawProvider,

    // Actions
    connect,
    disconnect,
    switchChain,
    addChain,
    checkExistingConnection,

    // EIP-6963
    availableProviders: eip6963.providers,
    getProviders: eip6963.getProviders
  }
}
