/**
 * Runtime validation for ghost requests
 * Provides validator functions per request type
 */


export interface GhostResponseSuccess<T = any> {
  ok: true;
  data: T;
}

export interface GhostResponseError {
  ok: false;
  error: string;
  details?: any;
}

export type GhostResponse<T = any> = GhostResponseSuccess<T> | GhostResponseError;

// ============================================================================
// Response Data Types (per handler)
// ============================================================================

/**
 * Response data for echo handler
 */
export interface EchoResponseData {
  echo: string;
  timestamp: number;
}

/**
 * Response data for bootstrap handler
 */
export interface BootstrapResponseData {
  pkp: string;
  accessControlConditions: any[];
  dataToEncryptHash: string;
  ciphertext: string;
  encryptResult: any;
  signature: {
    v: number;
    r: string;
    s: string;
  };
  currentCid: string;
  teeEncPublicKey: string;
  setEntropyTxHash: string;
}

/**
 * Response data for register-telegram handler
 */
export interface RegisterTelegramResponseData {
  telegram: {
    username: string;
    privateKey: string;
  };
}

// ============================================================================
// Type map linking request types to their response data types
// ============================================================================

export interface GhostResponseDataMap {
  'echo': EchoResponseData;
  'bootstrap': BootstrapResponseData;
  'register-telegram': RegisterTelegramResponseData;
}

/**
 * Helper type to get the response type for a specific request type
 */
export type GhostResponseForRequest<T extends GhostRequest> =
  GhostResponse<GhostResponseDataMap[T['type']]>;

/**
 * Parameters passed to the Lit Action via jsParams
 *
 * In Lit SDK v7 and below: These are injected directly into global namespace
 * In Lit SDK v8+: These are in a global `jsParams` object
 */
export interface JsParams {
  ghostRequest: GhostRequest;
  // Add more jsParams fields here as needed
}

/**
 * Echo request - simple test request that echoes back a message
 */
export interface GhostRequestEcho {
  type: 'echo';
  message: string;
}

export interface GhostRequestRegisterTelegram {
  type: 'register-telegram';
  initDataRaw: string;
}

/**
 * Bootstrap request - generates entropy, encrypts it, and signs it
 * This initializes the system with a secret that only this Lit Action can decrypt
 */
export interface GhostRequestBootstrap {
  type: 'bootstrap';
  pkpPublicKey: string; // PKP public key (hex string) for signing
  pkpEthAddress: string; // ETH address of public key
  tgApiSecret: string; // Telegram API secret
}

/**
 * Discriminated union of all possible ghost request types
 * Add new request types here as you build functionality
 */
export type GhostRequest = GhostRequestEcho | GhostRequestBootstrap | GhostRequestRegisterTelegram;

// ============================================================================
// Request Type Validators
// ============================================================================

/**
 * Validate echo request
 * Throws descriptive errors if validation fails
 */
export function validateEchoRequest(req: any): GhostRequestEcho {
  if (typeof req.message !== 'string') {
    throw new Error('message must be a string');
  }
  return req as GhostRequestEcho;
}

/**
 * Validate bootstrap request
 * Throws descriptive errors if validation fails
 */
export function validateBootstrapRequest(req: any): GhostRequestBootstrap {
  if (typeof req.pkpPublicKey !== 'string') {
    throw new Error('pkpPublicKey must be a string');
  }
  if (/*!req.pkpPublicKey.startsWith('0x') ||*/ req.pkpPublicKey.length !== 130) {
    throw new Error('pkpPublicKey must be a hex string starting with 0x and 132 characters long');
  }
  return req as GhostRequestBootstrap;
}

// ============================================================================
// Main Validation Functions
// ============================================================================

/**
 * Validate that a value is a valid GhostRequest
 * Throws descriptive errors if validation fails
 */
export function validateGhostRequest(value: unknown): GhostRequest {
  if (!value || typeof value !== 'object') {
    throw new Error('ghostRequest must be an object');
  }

  const req = value as any;

  if (!req.type || typeof req.type !== 'string') {
    throw new Error('ghostRequest.type is required and must be a string');
  }

  // Validate based on discriminator - use specific validators per type
  if (req.type === 'echo') {
    return validateEchoRequest(req);
  }

  if (req.type === 'bootstrap') {
    return validateBootstrapRequest(req);
  }

  throw new Error(`Unknown ghostRequest type: ${req.type}`);
}

/**
 * Validate all required jsParams
 * Returns validated parameters or throws
 */
export function validateJsParams(params: Record<string, any>): JsParams {
  return {
    ghostRequest: validateGhostRequest(params.ghostRequest),
  };
}

/**
 * Get and validate parameters from either Lit SDK v7 (global namespace) or v8 (jsParams object)
 *
 * Lit SDK v7 and below: Parameters are injected directly into global namespace
 * Lit SDK v8+: Parameters are in a global `jsParams` object
 *
 * @returns Validated jsParams object
 */
export function getParams(): JsParams {
  const gt = (globalThis as any);
  if (typeof gt.jsParams !== 'undefined') {
    return validateJsParams(gt.jsParams);
  }
  return validateJsParams({
    ghostRequest: gt.ghostRequest,
  });
}