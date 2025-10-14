/**
 * Sandboxed Lit Action executor
 *
 * Provides isolated execution contexts for Lit Actions with:
 * - Fresh global scope per execution (simulates disposable process)
 * - Persistent state object across executions (for key material, settings, etc.)
 * - Lit.Actions mock injection
 * - ethers v5 global injection
 *
 * Used by both the test server and vitest tests
 */

import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createLitMock } from './lit-mock';

/**
 * Persistent state that survives across multiple Lit Action executions
 *
 * This is an open object that you can define fields on as needed.
 * The state object is passed by reference and can be mutated by Lit mocks.
 *
 * Example fields you might add:
 * - pkpPrivateKey?: string - Mock PKP private key for signing
 * - telegramBotState?: { ... } - Telegram bot session state
 * - encryptionKeys?: { ... } - Encryption keys for the action
 */
export interface PersistentTestState {
  [key: string]: any;
}

/**
 * Result from executing a Lit Action
 */
export interface ExecutionResult {
  /**
   * The response captured from Lit.Actions.setResponse()
   */
  response: string | null;

  /**
   * Any errors that occurred during execution
   */
  error?: Error;

  /**
   * Console output captured during execution
   */
  logs: string[];
}

/**
 * Execute a Lit Action in an isolated sandbox
 *
 * @param code - The compiled Lit Action code (JavaScript string)
 * @param jsParams - The jsParams to inject as globals
 * @param persistentState - State that persists across executions (optional)
 * @returns Execution result with response and logs
 */
export async function executeLitAction(
  code: string,
  jsParams: Record<string, any>,
  persistentState: PersistentTestState = {}
): Promise<ExecutionResult> {
  const logs: string[] = [];

  // Create console mock that captures logs
  const mockConsole = {
    log: (...args: any[]) => {
      const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      logs.push(`[LOG] ${message}`);
      console.log(...args); // Also output to real console
    },
    error: (...args: any[]) => {
      const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      logs.push(`[ERROR] ${message}`);
      console.error(...args); // Also output to real console
    },
    warn: (...args: any[]) => {
      const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      logs.push(`[WARN] ${message}`);
      console.warn(...args); // Also output to real console
    },
    debug: (...args: any[]) => {
      const message = args.map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      logs.push(`[DEBUG] ${message}`);
      console.debug(...args); // Also output to real console
    },
  };

  try {
    // Create Lit mock with persistent state
    const { Lit, getResponse } = createLitMock(persistentState);

    // Import ethers v5.7.0 for injection
    // In the actual Lit runtime, ethers v5.7.0 is available as a global
    const ethers = await import('ethers');

    // Create isolated sandbox with fresh global scope
    const sandbox: any = {
      // Inject jsParams as globals (fresh per execution)
      ...jsParams,

      // Inject Lit namespace (uses persistent state)
      Lit,

      // Inject ethers v5 as global (matches Lit runtime)
      ethers,

      // Provide console mock
      console: mockConsole,

      // Self-references
      globalThis: undefined,
      global: undefined,

      // Standard globals
      setTimeout,
      setInterval,
      clearTimeout,
      clearInterval,
      Promise,
      Array,
      Object,
      JSON,
      Date,
      Math,
      String,
      Number,
      Boolean,
      Error,
      TextEncoder,
      TextDecoder,
      Buffer,
      crypto: webcrypto,

      // Add more globals as needed to match Lit runtime
    };

    // Set self-references
    sandbox.globalThis = sandbox;
    sandbox.global = sandbox;

    // Create VM context
    const context = vm.createContext(sandbox);

    // Wrap code in async IIFE to support top-level await
    // Vite's SSR transform may produce code with top-level await
    const wrappedCode = `(async () => { ${code} })()`;

    // Execute the Lit Action code in the sandbox
    const promise = vm.runInContext(wrappedCode, context, {
      filename: 'lit-action.js',
      timeout: 30000, // 30 second timeout
    });

    // Wait for the async execution to complete
    await promise;

    // Give a moment for any remaining async operations
    await new Promise(resolve => setTimeout(resolve, 50));

    // Get the captured response
    const response = getResponse();

    return {
      response,
      logs,
    };
  } catch (error) {
    return {
      response: null,
      error: error instanceof Error ? error : new Error(String(error)),
      logs,
    };
  }
}

/**
 * Helper to create a persistent state object for testing
 * Returns an empty object by default - add your own fields as needed
 */
export function createPersistentState(
  overrides?: Partial<PersistentTestState>
): PersistentTestState {
  return {
    ...overrides,
  };
}
