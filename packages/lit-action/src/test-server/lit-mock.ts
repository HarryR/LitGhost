/**
 * Mock implementation of Lit.Actions namespace for local testing
 * Simulates the Lit Protocol runtime environment
 */

import type { LitGlobalNamespace } from '../types';
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
  getResponse: () => string | null;
  getState: () => PersistentTestState;
} {
  let capturedResponse: string | null = null;

  const Lit: LitGlobalNamespace = {
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
    },
  };

  return {
    Lit,
    getResponse: () => capturedResponse,
    getState: () => persistentState
  };
}
