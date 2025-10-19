import { ref, shallowRef, computed, onUnmounted } from 'vue'
import type { IGhostClient } from '../ighostclient'

export interface UseGhostClientOptions {
  /**
   * Whether to enable debug logging for Lit Protocol
   * @default false
   */
  debug?: boolean
}

export interface GhostClientStatus {
  /** Display text for the status badge */
  text: string
  /** CSS class for the status dot (includes animation if needed) */
  dotClass: string
  /** CSS class for the status badge */
  class: string
}

/**
 * Composable for managing GhostClient connection and state
 *
 * Handles async loading of the GhostClient module and connection management,
 * providing reactive state for the client instance and connection status.
 *
 * Automatically connects on mount.
 *
 * @example
 * ```ts
 * const { client, isConnected, isLoading, error, retry } = useGhostClient({ debug: true })
 *
 * // Client will auto-connect on mount
 * // Use in template: v-if="client"
 * ```
 */
export function useGhostClient(options: UseGhostClientOptions = {}) {
  const { debug = false } = options

  // Use shallowRef for client to avoid deep reactivity on the complex object
  const client = shallowRef<IGhostClient | null>(null)

  const isLoading = ref(false)
  const isConnecting = ref(false)
  const isConnected = ref(false)
  const error = ref<Error | null>(null)

  let connectionPromise: Promise<void> | null = null
  let isDestroyed = false

  /**
   * Connect to the GhostClient
   * Safe to call multiple times - will reuse existing connection promise
   */
  async function connect(): Promise<void> {
    // If already connecting, return the existing promise
    if (connectionPromise) {
      return connectionPromise
    }

    // If already connected, do nothing
    if (client.value && isConnected.value) {
      return
    }

    // If component was unmounted, don't connect
    if (isDestroyed) {
      return
    }

    connectionPromise = (async () => {
      try {
        isLoading.value = true
        isConnecting.value = true
        error.value = null

        // Dynamically import the GhostClient module
        const { GhostClient } = await import('../ghostclient')

        // Check if component was unmounted during import
        if (isDestroyed) {
          return
        }

        // Create and connect the client
        const ghostClient = new GhostClient(debug)
        await ghostClient.connect()

        // Check again if component was unmounted during connection
        if (isDestroyed) {
          return
        }

        client.value = ghostClient
        isConnected.value = true

        console.log('GhostClient connected successfully')
      } catch (err) {
        console.error('Failed to connect GhostClient:', err)
        error.value = err instanceof Error ? err : new Error(String(err))
        client.value = null
        isConnected.value = false
      } finally {
        isLoading.value = false
        isConnecting.value = false
        connectionPromise = null
      }
    })()

    return connectionPromise
  }

  /**
   * Retry connection after an error
   */
  async function retry(): Promise<void> {
    error.value = null
    connectionPromise = null
    await connect()
  }

  /**
   * Clean up resources
   */
  function destroy() {
    if( client.value ) {
      client.value.disconnect();
    }    
    isDestroyed = true
    connectionPromise = null
    client.value = null
    isConnected.value = false
    isConnecting.value = false
    isLoading.value = false
  }

  // Computed status for UI display
  const status = computed<GhostClientStatus>(() => {
    if (error.value) {
      return {
        text: 'Lit',
        dotClass: 'bg-red-500',
        class: 'border-red-500 text-red-500 bg-red-500/10'
      }
    }
    // Connected
    if (client.value) {
      return {
        text: 'Lit',
        dotClass: 'bg-emerald-400',
        class: 'border-emerald-400 text-emerald-400 bg-emerald-400/10'
      }
    }
    if (isConnecting.value) {
      return {
        text: 'Lit',
        dotClass: 'bg-yellow-500 animate-pulse',
        class: 'border-yellow-500 text-yellow-500 bg-yellow-500/10'
      }
    }
    // isLoading or initial state
    return {
      text: 'Lit',
      dotClass: 'bg-gray-500 animate-pulse',
      class: 'border-gray-500 text-gray-500 bg-gray-500/10'
    }
  })

  // Auto-connect on mount
  connect()

  // Cleanup on unmount
  onUnmounted(() => {
    destroy()
  })

  return {
    /** The GhostClient instance (null until connected) */
    client,

    /** Whether the initial module load and connection is in progress */
    isLoading,

    /** Whether a connection attempt is currently in progress */
    isConnecting,

    /** Whether the client is connected and ready to use */
    isConnected,

    /** Error that occurred during connection (null if no error) */
    error,

    /** Status object for UI display (badge classes and text) */
    status,

    /** Retry connection after an error */
    retry,
  }
}
