/**
 * Type definitions for Lit Action jsParams and global namespace
 */

// ============================================================================
// Ghost Request Types (Discriminated Union)
// ============================================================================

/**
 * Echo request - simple test request that echoes back a message
 */
export interface GhostRequestEcho {
  type: 'echo';
  message: string;
}

/**
 * Discriminated union of all possible ghost request types
 * Add new request types here as you build functionality
 */
export type GhostRequest = GhostRequestEcho;

// ============================================================================
// Response Types
// ============================================================================

export interface GhostResponseSuccess<T = any> {
  success: true;
  data: T;
}

export interface GhostResponseError {
  success: false;
  error: string;
  details?: any;
}

export type GhostResponse<T = any> = GhostResponseSuccess<T> | GhostResponseError;

// ============================================================================
// Lit Actions Global Namespace
// ============================================================================

/**
 * Mock-able interface for Lit.Actions methods
 * Add more methods as needed for your use cases
 */
export interface LitActionsNamespace {
  /**
   * Set the response that will be returned from the Lit Action
   */
  setResponse(response: { response: string }): void;

  /**
   * Run a function once across the node cohort (only the leader executes)
   *
   * @param options - Configuration options
   * @param options.waitForResponse - Whether to wait for a response or not
   * @param options.name - Optional broadcast channel ID (defaults to 'default_bc_id')
   * @param async_fn - The async function to execute
   * @returns The result from the function (as string) or undefined if not waiting
   */
  runOnce(
    options: { waitForResponse?: boolean; name?: string },
    async_fn: () => Promise<any>
  ): Promise<string | undefined>;

  /**
   * Convert a Uint8Array to a string
   *
   * @param array - The Uint8Array to convert
   * @param encoding - The encoding to use (defaults to "utf8")
   * @returns The string representation of the Uint8Array
   */
  uint8arrayToString(array: Uint8Array, encoding?: string): string;

  /**
   * Convert a string to a Uint8Array
   *
   * @param string - The string to convert
   * @param encoding - The encoding to use (defaults to "utf8")
   * @returns The Uint8Array representation of the string
   */
  uint8arrayFromString(string: string, encoding?: string): Uint8Array;

  // Add more Lit Actions methods as needed (signEcdsa, getJwt, etc.)
}

/**
 * Global Lit namespace available in Lit Actions runtime
 */
export interface LitGlobalNamespace {
  Actions: LitActionsNamespace;
}

// ============================================================================
// Global Type Declarations
// ============================================================================

/**
 * Declare global variables that are injected via jsParams
 * These are available in the Lit Action execution context
 */
declare global {
  // The main request object passed from the client
  var ghostRequest: GhostRequest;

  // The Lit namespace with Actions methods
  var Lit: LitGlobalNamespace;

  // Add more global jsParams as needed
}

// This export is needed to make this file a module
export {};
