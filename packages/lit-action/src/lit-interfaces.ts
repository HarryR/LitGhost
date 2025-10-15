/**
 * Type definitions for Lit Actions global namespace
 *
 * These interfaces define the Lit Protocol runtime environment available
 * in Lit Actions, including the Lit.Actions and Lit.Auth namespaces.
 */

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
     * @param {Uint8array} toSign the message to sign
     * @param {string} publicKey the public key of the PKP
     * @param {string} sigName the name of the signature
     * @returns {Uint8array} The resulting signature
     */
    signAndCombineEcdsa(options:{
      toSign:Uint8Array,
      publicKey:string,
      sigName:string,
    }): Promise<Uint8Array>;

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

  /**
   * Encrypt data with access control conditions
   *
   * @param params - Encryption parameters
   * @param params.accessControlConditions - Access control conditions
   * @param params.to_encrypt - Data to encrypt (Uint8Array)
   * @returns Promise with ciphertext and dataToEncryptHash
   */
  encrypt(params: {
    accessControlConditions: any[];
    to_encrypt: Uint8Array;
  }): Promise<{
    ciphertext: string;
    dataToEncryptHash: string;
  }>;

  /**
   * Decrypt and combine decryption shares from multiple nodes
   *
   * @param params - Decryption parameters
   * @param params.accessControlConditions - Access control conditions
   * @param params.ciphertext - Encrypted data
   * @param params.dataToEncryptHash - Hash of the original data
   * @param params.authSig - Authentication signature
   * @param params.chain - Blockchain chain
   * @returns Promise with decrypted data as Uint8Array
   */
  decryptAndCombine(params: {
    accessControlConditions: any[];
    ciphertext: string;
    dataToEncryptHash: string;
    authSig: any;
    chain: string;
  }): Promise<Uint8Array>;

  /**
   * Decrypt on a single node (simpler, doesn't require node coordination)
   *
   * @param params - Decryption parameters
   * @param params.accessControlConditions - Access control conditions
   * @param params.ciphertext - Encrypted data
   * @param params.dataToEncryptHash - Hash of the original data
   * @param params.authSig - Authentication signature
   * @param params.chain - Blockchain chain
   * @returns Promise with decrypted data as Uint8Array
   */
  decryptToSingleNode(params: {
    accessControlConditions: any[];
    ciphertext: string;
    dataToEncryptHash: string;
    authSig: any;
    chain: string;
  }): Promise<Uint8Array>;

  /**
   * Get the RPC URL for a specific blockchain
   *
   * @param params - RPC URL parameters
   * @param params.chain - The chain to get the RPC URL for
   * @returns Promise with the RPC URL for the chain
   */
  getRpcUrl(params: { chain: string }): Promise<string>;

  // Add more Lit Actions methods as needed (signEcdsa, getJwt, etc.)
}

/**
 * Authentication context available in Lit Actions runtime
 */
export interface LitAuthNamespace {
  /**
   * IPFS CIDs of the action being executed (current and parent actions)
   */
  actionIpfsIds: string[];

  /**
   * Stack of IPFS CIDs representing the call chain
   */
  actionIpfsIdStack: string[];

  /**
   * Ethereum address that signed the auth signature
   */
  authSigAddress: string;

  /**
   * Authentication method contexts
   */
  authMethodContexts: any[];

  /**
   * Resources that were granted access
   */
  resources: any[];

  /**
   * Custom authentication resource if provided
   */
  customAuthResource: string;
}

/**
 * Global Lit namespace available in Lit Actions runtime
 */
export interface LitGlobalNamespace {
  Auth: LitAuthNamespace;
  Actions: LitActionsNamespace;
}


/**
 * These are available in the Lit Action execution context
 */
declare global {
  // The Lit namespace with Actions methods
  var Lit: LitGlobalNamespace;

  // v8/Naga exports these rather than just `Lit.Auth` and `Lit.Actions`
  var LitAuth: LitAuthNamespace;
  var LitActions: LitActionsNamespace;

  // Add more global jsParams as needed
}

export {};
