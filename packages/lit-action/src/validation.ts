/**
 * Runtime validation for ghost requests
 * Provides validator functions per request type
 */

import type {
  GhostRequest,
  GhostRequestEcho,
} from './types';

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

  throw new Error(`Unknown ghostRequest type: ${req.type}`);
}

/**
 * Validate all required jsParams
 * Returns validated parameters or throws
 */
export function validateJsParams(params: {
  ghostRequest: unknown;
}): {
  ghostRequest: GhostRequest;
} {
  return {
    ghostRequest: validateGhostRequest(params.ghostRequest),
  };
}
