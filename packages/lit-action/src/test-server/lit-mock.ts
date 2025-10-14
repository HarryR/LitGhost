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
    },
  };

  return {
    Lit,
    getResponse: () => capturedResponse,
    getState: () => persistentState
  };
}
