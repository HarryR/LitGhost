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

/**
 * Response data for submit-deposit handler
 */
export interface SubmitDepositResponseData {
  depositTxHash: string;
  updateTxHash: string;
}

// ============================================================================
// Type map linking request types to their response data types
// ============================================================================

export interface GhostResponseDataMap {
  'echo': EchoResponseData;
  'bootstrap': BootstrapResponseData;
  'register-telegram': RegisterTelegramResponseData;
  'submit-deposit': SubmitDepositResponseData;
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
 * Submit deposit request - submits an ERC-3009 deposit transaction and processes it
 * Used for gas-less transfers where the bot (PKP) pays for gas
 */
export interface GhostRequestSubmitDeposit {
  type: 'submit-deposit';
  depositTo: {
    rand: string; // 0x-prefixed hex string (32 bytes)
    user: string; // 0x-prefixed hex string (32 bytes)
  };
  auth3009: {
    from: string; // User's address
    value: string; // Amount in token units (as string to handle bigint)
    validAfter: number;
    validBefore: number;
    sig: {
      v: number;
      r: string; // 0x-prefixed hex string
      s: string; // 0x-prefixed hex string
    };
  };
}

/**
 * Discriminated union of all possible ghost request types
 * Add new request types here as you build functionality
 */
export type GhostRequest = GhostRequestEcho | GhostRequestBootstrap | GhostRequestRegisterTelegram | GhostRequestSubmitDeposit;

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

/**
 * Validate submit-deposit request
 * Throws descriptive errors if validation fails
 */
export function validateSubmitDepositRequest(req: any): GhostRequestSubmitDeposit {
  if (!req.depositTo || typeof req.depositTo !== 'object') {
    throw new Error('depositTo must be an object');
  }
  if (typeof req.depositTo.rand !== 'string' || !req.depositTo.rand.startsWith('0x')) {
    throw new Error('depositTo.rand must be a 0x-prefixed hex string');
  }
  if (typeof req.depositTo.user !== 'string' || !req.depositTo.user.startsWith('0x')) {
    throw new Error('depositTo.user must be a 0x-prefixed hex string');
  }
  if (!req.auth3009 || typeof req.auth3009 !== 'object') {
    throw new Error('auth3009 must be an object');
  }
  if (typeof req.auth3009.from !== 'string') {
    throw new Error('auth3009.from must be a string (Ethereum address)');
  }
  if (typeof req.auth3009.value !== 'string') {
    throw new Error('auth3009.value must be a string');
  }
  if (typeof req.auth3009.validAfter !== 'number') {
    throw new Error('auth3009.validAfter must be a number');
  }
  if (typeof req.auth3009.validBefore !== 'number') {
    throw new Error('auth3009.validBefore must be a number');
  }
  if (!req.auth3009.sig || typeof req.auth3009.sig !== 'object') {
    throw new Error('auth3009.sig must be an object');
  }
  if (typeof req.auth3009.sig.v !== 'number') {
    throw new Error('auth3009.sig.v must be a number');
  }
  if (typeof req.auth3009.sig.r !== 'string' || !req.auth3009.sig.r.startsWith('0x')) {
    throw new Error('auth3009.sig.r must be a 0x-prefixed hex string');
  }
  if (typeof req.auth3009.sig.s !== 'string' || !req.auth3009.sig.s.startsWith('0x')) {
    throw new Error('auth3009.sig.s must be a 0x-prefixed hex string');
  }
  return req as GhostRequestSubmitDeposit;
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

  if (req.type === 'submit-deposit') {
    return validateSubmitDepositRequest(req);
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