// EIP-6963: Multi Injected Provider Discovery
// https://eips.ethereum.org/EIPS/eip-6963

import { ref } from 'vue'

// EIP-1193 Provider interface
export interface EIP1193Provider {
  request(args: { method: string; params?: any }): Promise<any>
  on?(event: string, handler: (...args: any[]) => void): void
  removeListener?(event: string, handler: (...args: any[]) => void): void
}

export interface EIP6963ProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo
  provider: EIP1193Provider
}

export interface EIP6963AnnounceProviderEvent extends CustomEvent {
  type: 'eip6963:announceProvider'
  detail: EIP6963ProviderDetail
}

// Discovered providers
const providers = ref<Map<string, EIP6963ProviderDetail>>(new Map())

let isListening = false

export function useEIP6963() {
  function startDiscovery() {
    if (isListening) return

    window.addEventListener('eip6963:announceProvider', handleProviderAnnounce as EventListener)

    // Request providers to announce themselves
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    isListening = true
  }

  function handleProviderAnnounce(event: EIP6963AnnounceProviderEvent) {
    const { detail } = event

    if (!providers.value.has(detail.info.uuid)) {
      providers.value.set(detail.info.uuid, detail)
    }
  }

  function stopDiscovery() {
    window.removeEventListener('eip6963:announceProvider', handleProviderAnnounce as EventListener)
    isListening = false
  }

  function getProvider(rdns?: string): EIP1193Provider | null {
    if (rdns) {
      // Find provider by RDNS
      for (const [, detail] of providers.value) {
        if (detail.info.rdns === rdns) {
          return detail.provider
        }
      }
      return null
    }

    // Fallback to window.ethereum
    return (window as any).ethereum || null
  }

  function getProviders(): EIP6963ProviderDetail[] {
    return Array.from(providers.value.values())
  }

  return {
    providers,
    startDiscovery,
    stopDiscovery,
    getProvider,
    getProviders
  }
}
