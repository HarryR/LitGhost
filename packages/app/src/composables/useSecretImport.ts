import { ref } from 'vue';

export interface SecretImportState {
  privateKey: string | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Composable for managing private key import in the Web App
 * Does NOT persist to storage - user must login each time
 */
export function useSecretImport() {
  const privateKey = ref<string | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  /**
   * Validate hex string (with or without 0x prefix)
   */
  function validateHexString(input: string): boolean {
    // Remove whitespace
    const cleaned = input.replace(/\s+/g, '');

    // Check if it's a valid hex string (with or without 0x prefix)
    const hexPattern = /^(0x)?[0-9a-fA-F]+$/;
    if (!hexPattern.test(cleaned)) {
      return false;
    }

    // Remove 0x prefix if present
    const hex = cleaned.startsWith('0x') ? cleaned.slice(2) : cleaned;

    // Check if it's 32 bytes (64 hex characters)
    return hex.length === 64;
  }

  /**
   * Normalize hex string (remove whitespace, ensure 0x prefix)
   */
  function normalizeHexString(input: string): string {
    const cleaned = input.replace(/\s+/g, '');
    const hex = cleaned.startsWith('0x') ? cleaned.slice(2) : cleaned;
    return '0x' + hex.toLowerCase();
  }

  /**
   * Import a private key from user input
   */
  function importSecret(secretInput: string): boolean {
    error.value = null;
    isLoading.value = true;

    try {
      // Validate the input
      if (!secretInput || secretInput.trim().length === 0) {
        throw new Error('Please enter a private key');
      }

      if (!validateHexString(secretInput)) {
        throw new Error('Invalid private key format. Expected 64 hex characters (32 bytes)');
      }

      // Normalize and set
      const normalized = normalizeHexString(secretInput);
      privateKey.value = normalized;

      console.log('Private key imported successfully');
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error during import';
      console.error('Import error:', err);
      error.value = message;
      privateKey.value = null;
      return false;
    } finally {
      isLoading.value = false;
    }
  }

  /**
   * Clear private key (for logout)
   */
  function logout(): void {
    privateKey.value = null;
    error.value = null;
  }

  /**
   * Check URL hash for secret key parameter and auto-import
   * Also clears the hash from the URL after importing for security
   */
  function checkUrlHash(): boolean {
    try {
      const hash = window.location.hash;
      if (!hash || hash.length < 2) return false;

      // Parse hash parameters (format: #sk=0x...)
      const params = new URLSearchParams(hash.slice(1));
      const secretKey = params.get('sk');

      if (secretKey) {
        // Try to import the secret
        const success = importSecret(secretKey);

        // Clear the hash from URL for security (don't leave the key in the URL)
        if (success) {
          window.history.replaceState(null, '', window.location.pathname + window.location.search);
        }

        return success;
      }

      return false;
    } catch (err) {
      console.error('Error checking URL hash:', err);
      return false;
    }
  }

  return {
    privateKey,
    isLoading,
    error,
    importSecret,
    logout,
    checkUrlHash,
  };
}
