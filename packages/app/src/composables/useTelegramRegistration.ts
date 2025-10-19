import { ref, type Ref } from 'vue';
import type { IGhostClient } from '../ighostclient';
import '@/vendor/telegram-web-app.d.ts';

const STORAGE_KEY = 'telegram_private_key';

export interface TelegramRegistrationState {
  privateKey: string | null;
  username: string | null;
  isLoading: boolean;
  error: string | null;
  wasRegistered: boolean;
  storageType: 'secure' | 'device' | null;
}

/**
 * Storage API type (SecureStorage or DeviceStorage have the same interface)
 */
type StorageAPI = {
  getItem: (key: string, callback: (error: string | null, value: string | null) => void) => void;
  setItem: (key: string, value: string, callback?: (error: string | null) => void) => void;
  removeItem: (key: string, callback?: (error: string | null) => void) => void;
};

/**
 * Cached storage selection - null means not yet determined
 * 'secure' = SecureStorage works, 'device' = DeviceStorage fallback
 */
let storageType: 'secure' | 'device' | null = null;

/**
 * Get the working storage API by testing SecureStorage first, falling back to DeviceStorage
 * Caches the result to avoid repeated tests
 */
function getStorageAPI(): StorageAPI {
  if (storageType === 'secure') {
    return window.Telegram.WebApp.SecureStorage;
  }
  if (storageType === 'device') {
    return window.Telegram.WebApp.DeviceStorage;
  }

  // Default: try SecureStorage first (will test on first use)
  return window.Telegram.WebApp.SecureStorage;
}

/**
 * Composable for managing Telegram registration and private key storage
 * Tries SecureStorage first (encrypted keychain), falls back to DeviceStorage if unsupported
 * NEVER uses CloudStorage to avoid uploading private keys to Telegram servers
 */
export function useTelegramRegistration(ghostClient: Ref<IGhostClient | null>) {
  const privateKey = ref<string | null>(null);
  const username = ref<string | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);
  const wasRegistered = ref(false); // true if registration was performed, false if loaded from storage
  const activeStorageType = ref<'secure' | 'device' | null>(null); // which storage is actually being used

  /**
   * Load private key from storage (SecureStorage or DeviceStorage)
   */
  async function loadFromStorage(): Promise<string | null> {
    return new Promise((resolve) => {
      const storage = getStorageAPI();
      storage.getItem(STORAGE_KEY, (err, value) => {
        if (err === 'UNSUPPORTED' && storageType !== 'device') {
          // SecureStorage not supported, try DeviceStorage
          storageType = 'device';
          activeStorageType.value = 'device';
          window.Telegram.WebApp.DeviceStorage.getItem(STORAGE_KEY, (err2, value2) => {
            if (err2) {
              resolve(null);
            } else {
              // Even if value2 is null/empty, we successfully used DeviceStorage
              resolve(value2);
            }
          });
        } else if (err) {
          resolve(null);
        } else {
          // Success (even if value is null) - we successfully used this storage
          if (storageType === null) {
            storageType = 'secure';
            activeStorageType.value = 'secure';
          }
          resolve(value);
        }
      });
    });
  }

  /**
   * Save private key to storage (SecureStorage or DeviceStorage)
   */
  async function saveToStorage(key: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const storage = getStorageAPI();
      storage.setItem(STORAGE_KEY, key, (err) => {
        if (err === 'UNSUPPORTED' && storageType !== 'device') {
          // SecureStorage not supported, try DeviceStorage
          console.log('SecureStorage unsupported, falling back to DeviceStorage');
          storageType = 'device';
          activeStorageType.value = 'device';
          window.Telegram.WebApp.DeviceStorage.setItem(STORAGE_KEY, key, (err2) => {
            if (err2) {
              console.error('Failed to save to DeviceStorage:', err2);
              reject(new Error(err2));
            } else {
              console.log('Private key saved to DeviceStorage');
              resolve();
            }
          });
        } else if (err) {
          console.error('Failed to save to storage:', err);
          reject(new Error(err));
        } else {
          // Success - cache the storage type
          if (storageType === null) {
            storageType = 'secure';
            activeStorageType.value = 'secure';
            console.log('Private key saved to SecureStorage');
          }
          resolve();
        }
      });
    });
  }

  /**
   * Register with Telegram and store the private key
   * First checks SecureStorage, then registers if needed
   */
  async function register(): Promise<void> {
    error.value = null;
    isLoading.value = true;

    try {
      // Wait for ghost client to be available
      if (!ghostClient.value) {
        throw new Error('Ghost client not connected');
      }

      // Try to load from storage first
      const stored = await loadFromStorage();
      if (stored) {
        console.log('Loaded private key from storage');
        privateKey.value = stored;
        wasRegistered.value = false; // Loaded from storage, not newly registered

        // Get username from Telegram
        const telegramUser = window.Telegram.WebApp.initDataUnsafe.user;
        if (telegramUser?.username) {
          username.value = telegramUser.username;
        }

        isLoading.value = false;
        return;
      }

      // Not in storage, need to register
      console.log('No stored key found, registering with Telegram...');

      const initDataRaw = window.Telegram.WebApp.initData;
      if (!initDataRaw) {
        throw new Error('Telegram initData not available');
      }

      const result = await ghostClient.value.registerTelegram(initDataRaw);

      privateKey.value = result.telegram.privateKey;
      username.value = result.telegram.username;
      wasRegistered.value = true; // Newly registered

      // Save to storage
      await saveToStorage(result.telegram.privateKey);
      console.log('Private key saved to storage');

    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error during registration';
      console.error('Registration error:', err);
      error.value = message;
      privateKey.value = null;
      username.value = null;
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Clear stored private key (for testing or logout)
   */
  async function clearStorage(): Promise<void> {
    return new Promise((resolve, reject) => {
      const storage = getStorageAPI();
      storage.removeItem(STORAGE_KEY, (err) => {
        if (err) {
          reject(new Error(err));
        } else {
          privateKey.value = null;
          username.value = null;
          resolve();
        }
      });
    });
  }

  return {
    privateKey,
    username,
    isLoading,
    error,
    wasRegistered,
    storageType: activeStorageType,
    register,
    clearStorage,
  };
}
