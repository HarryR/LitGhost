/**
 * Mock implementation of Lit.Actions namespace for local testing
 * Simulates the Lit Protocol runtime environment
 */

import type { LitActionsNamespace, LitAuthNamespace, LitGlobalNamespace } from '../lit-interfaces';
import type { PersistentTestState } from './executor';

/**
 * Create a mock Lit.Actions namespace for testing
 *
 * @param persistentState - State object that persists across executions (passed by reference)
 *                          The Lit mock can read/write to this object, and changes will be
 *                          visible in subsequent executions.
 */
export function createLitMock(
  persistentState: PersistentTestState = {}
): {
  Lit: LitGlobalNamespace;
  LitAuth: LitAuthNamespace;
  LitActions: LitActionsNamespace;
  getResponse: () => string | null;
  getState: () => PersistentTestState;
} {
  let capturedResponse: string | null = null;

  const Lit: LitGlobalNamespace = {
    Auth: {
      actionIpfsIds: ['QmRvJy4aj9FFqRR7rmTmqMXuDMdBUSXNooV7zbrzHouCXP'],
      actionIpfsIdStack: ['QmRvJy4aj9FFqRR7rmTmqMXuDMdBUSXNooV7zbrzHouCXP'],
      authSigAddress: '0xe7B5Bcc8d2656F438E50604e14bf668C577Cb994',
      authMethodContexts: [],
      resources: [],
      customAuthResource: '',
    },

    Actions: {
      /**
       * Mock setResponse - captures the response for the test server to return
       */
      setResponse(response: { response: string }) {
        console.log('[Mock] Lit.Actions.setResponse called');
        capturedResponse = response.response;
      },

      /**
       * Mock runOnce - in the mock environment, we always act as the leader and execute the function
       *
       * Since we're not part of a node cohort, we simulate the leader behavior:
       * - Always execute the provided async function
       * - Return the result if waitForResponse is true
       * - Log the broadcast channel ID for debugging
       */
      async runOnce(
        { waitForResponse = false, name = 'default_bc_id' },
        async_fn: () => Promise<any>
      ): Promise<string | undefined> {
        console.log(`[Mock] Lit.Actions.runOnce called (bc_id: ${name}, waitForResponse: ${waitForResponse})`);

        let response = '';

        try {
          response = await async_fn();
        } catch (e) {
          console.error('[Mock] Error running function:', e);
          response = '[ERROR]';
        }

        try {
          response = response.toString();
        } catch (e) {
          console.error('[Mock] Error converting response to string:', e);
          response = '';
        }

        console.log(`[Mock] runOnce result: ${response}`);

        if (waitForResponse) {
          return response;
        }

        return undefined;
      },

      /**
       * Convert a Uint8Array to a string
       *
       * @param array - The Uint8Array to convert
       * @param encoding - The encoding to use (supports: 'utf8', 'base64', 'base16', 'hex')
       * @returns The string representation of the Uint8Array
       */
      uint8arrayToString(array: Uint8Array, encoding: string = 'utf8'): string {
        console.log(`[Mock] Lit.Actions.uint8arrayToString called (encoding: ${encoding})`);

        switch (encoding.toLowerCase()) {
          case 'utf8':
          case 'utf-8':
            return new TextDecoder('utf-8').decode(array);

          case 'base64':
            // Use Buffer in Node.js environment, or btoa in browser
            if (typeof Buffer !== 'undefined') {
              return Buffer.from(array).toString('base64');
            }
            // Fallback for browser environment
            return btoa(String.fromCharCode(...array));

          case 'base16':
          case 'hex':
            return Array.from(array)
              .map(b => b.toString(16).padStart(2, '0'))
              .join('');

          default:
            throw new Error(`Unsupported encoding: ${encoding}`);
        }
      },

      /**
       * Convert a string to a Uint8Array
       *
       * @param string - The string to convert
       * @param encoding - The encoding to use (supports: 'utf8', 'base64', 'base16', 'hex')
       * @returns The Uint8Array representation of the string
       */
      uint8arrayFromString(string: string, encoding: string = 'utf8'): Uint8Array {
        console.log(`[Mock] Lit.Actions.uint8arrayFromString called (encoding: ${encoding})`);

        switch (encoding.toLowerCase()) {
          case 'utf8':
          case 'utf-8':
            return new TextEncoder().encode(string);

          case 'base64':
            // Use Buffer in Node.js environment
            if (typeof Buffer !== 'undefined') {
              return new Uint8Array(Buffer.from(string, 'base64'));
            }
            // Fallback for browser environment
            const binaryString = atob(string);
            const a = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              a[i] = binaryString.charCodeAt(i);
            }
            return a;

          case 'base16':
          case 'hex':
            // Remove any spaces or 0x prefix
            const cleanHex = string.replace(/\s/g, '').replace(/^0x/i, '');
            if (cleanHex.length % 2 !== 0) {
              throw new Error('Hex string must have an even number of characters');
            }
            const b = new Uint8Array(cleanHex.length / 2);
            for (let i = 0; i < cleanHex.length; i += 2) {
              b[i / 2] = parseInt(cleanHex.substring(i, i + 2), 16);
            }
            return b;

          default:
            throw new Error(`Unsupported encoding: ${encoding}`);
        }
      },

      /**
       * Mock encrypt - simulates Lit Protocol encryption
       * In mock mode, we use a simple reversible encoding to simulate encryption
       *
       * @param params - Encryption parameters
       * @param params.accessControlConditions - Access control conditions (stored but not enforced in mock)
       * @param params.to_encrypt - Data to encrypt (Uint8Array)
       * @returns Mock encryption result with ciphertext and dataToEncryptHash
       */
      async encrypt(params: {
        accessControlConditions: any[];
        to_encrypt: Uint8Array;
      }): Promise<{
        ciphertext: string;
        dataToEncryptHash: string;
      }> {
        console.log('[Mock] Lit.Actions.encrypt called');
        console.log('[Mock] Access control conditions:', JSON.stringify(params.accessControlConditions));
        console.log('[Mock] Data to encrypt length:', params.to_encrypt.length, 'bytes');

        // In mock mode, we just base64 encode the data (reversible for testing)
        // In production, this would be actual encryption
        const ciphertext = Buffer.from(params.to_encrypt).toString('base64');

        // Create a mock hash of the data (in production this is a real hash)
        const crypto = await import('crypto');
        const hash = crypto.createHash('sha256').update(params.to_encrypt).digest('hex');
        const dataToEncryptHash = '0x' + hash;

        // Store the mapping in persistent state for decryption
        if (!persistentState.encryptionStore) {
          persistentState.encryptionStore = {};
        }
        persistentState.encryptionStore[dataToEncryptHash] = {
          ciphertext,
          originalData: Buffer.from(params.to_encrypt).toString('hex'),
          accessControlConditions: params.accessControlConditions,
        };

        console.log('[Mock] Encrypted successfully. Hash:', dataToEncryptHash);

        return {
          ciphertext,
          dataToEncryptHash,
        };
      },

      /**
       * Mock decryptAndCombine - simulates Lit Protocol decryption
       * In mock mode, we reverse the mock encryption
       *
       * @param params - Decryption parameters
       * @param params.accessControlConditions - Access control conditions to verify
       * @param params.ciphertext - Ciphertext to decrypt (base64 string)
       * @param params.dataToEncryptHash - Hash of the original data
       * @param params.authSig - Auth signature (not used in mock)
       * @param params.chain - Chain name (not used in mock)
       * @returns Decrypted data as Uint8Array
       */
      async decryptAndCombine(params: {
        accessControlConditions: any[];
        ciphertext: string;
        dataToEncryptHash: string;
        authSig: any;
        chain: string;
      }): Promise<Uint8Array> {
        console.log('[Mock] Lit.Actions.decryptAndCombine called');
        console.log('[Mock] Data hash:', params.dataToEncryptHash);

        // Check if we have this in our persistent state
        const stored = persistentState.encryptionStore?.[params.dataToEncryptHash];

        if (!stored) {
          throw new Error(`Mock decryption failed: No encrypted data found for hash ${params.dataToEncryptHash}`);
        }

        // Verify ciphertext matches
        if (stored.ciphertext !== params.ciphertext) {
          throw new Error('Mock decryption failed: Ciphertext mismatch');
        }

        // In mock mode, we don't enforce access control conditions
        // In production, Lit Protocol would verify these
        console.log('[Mock] Access control conditions would be verified here:', params.accessControlConditions);

        // Decode the base64 ciphertext back to original data
        const decrypted = Buffer.from(stored.originalData, 'hex');

        console.log('[Mock] Decrypted successfully. Length:', decrypted.length, 'bytes');

        return new Uint8Array(decrypted);
      },

      /**
       * Mock decryptToSingleNode - alias for decryptAndCombine in mock mode
       */
      async decryptToSingleNode(params: {
        accessControlConditions: any[];
        ciphertext: string;
        dataToEncryptHash: string;
        authSig: any;
        chain: string;
      }): Promise<Uint8Array> {
        console.log('[Mock] Lit.Actions.decryptToSingleNode called (delegating to decryptAndCombine)');
        return this.decryptAndCombine(params);
      },

      /**
       * Mock signAndCombineEcdsa - simulates Lit Protocol ECDSA signing
       * In mock mode, we create a deterministic signature from the message hash
       *
       * @param options - Signing parameters
       * @param options.toSign - Data to sign (Uint8Array)
       * @param options.publicKey - PKP public key (hex string)
       * @param options.sigName - Name for this signature
       * @returns Mock signature as Uint8Array (65 bytes: r + s + v)
       */
      async signAndCombineEcdsa(options: {
        toSign: Uint8Array;
        publicKey: string;
        sigName: string;
      }): Promise<Uint8Array> {
        console.log('[Mock] Lit.Actions.signAndCombineEcdsa called');
        console.log('[Mock] Signing with PKP:', options.publicKey.substring(0, 20) + '...');
        console.log('[Mock] Signature name:', options.sigName);

        // Create a mock signature by hashing the message
        // In production, this would be actual ECDSA signing using the PKP
        const crypto = await import('crypto');
        const hash = crypto.createHash('sha256').update(options.toSign).digest();

        // Create r and s from the hash (32 bytes each)
        const r = hash;
        const s = crypto.createHash('sha256').update(Buffer.concat([hash, Buffer.from(options.publicKey.slice(2), 'hex')])).digest();

        // Standard v value for Ethereum signatures
        const v = Buffer.from([27]);

        // Concatenate r + s + v (65 bytes total)
        const signature = Buffer.concat([r, s, v]);

        console.log('[Mock] Generated signature:', signature.toString('hex').substring(0, 20) + '...');

        return new Uint8Array(signature);
      },

      /**
       * Mock getRpcUrl - returns RPC URL for a blockchain
       * In mock mode, we return a local RPC URL for any chain
       *
       * @param params - RPC URL parameters
       * @param params.chain - The chain to get the RPC URL for
       * @returns Promise with the RPC URL for the chain
       */
      async getRpcUrl(params: { chain: string }): Promise<string> {
        console.log(`[Mock] Lit.Actions.getRpcUrl called (chain: ${params.chain})`);

        // In mock mode, always return localhost RPC regardless of chain
        // Real Lit Actions would return actual RPC URLs for different chains
        const rpcUrl = 'http://127.0.0.1:8545/';
        console.log(`[Mock] Returning RPC URL: ${rpcUrl}`);
        return rpcUrl;
      },
    },
  };

  return {
    Lit,
    LitAuth: Lit.Auth,
    LitActions: Lit.Actions,
    getResponse: () => capturedResponse,
    getState: () => persistentState
  };
}
