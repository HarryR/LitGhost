/**
 * Runtime validation for ghost requests
 * Provides type guards and validation functions
 */

import type {
  GhostRequest,
  GhostRequestEcho,
} from './types';

// ============================================================================
// Type Guards
// ============================================================================

export function isGhostRequestEcho(req: GhostRequest): req is GhostRequestEcho {
  return req.type === 'echo' && typeof (req as any).message === 'string';
}

// ============================================================================
// Validation Functions
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

  // Validate based on discriminator
  switch (req.type) {
    case 'echo':
      if (typeof req.message !== 'string') {
        throw new Error('ghostRequest.message must be a string for echo requests');
      }
      return req as GhostRequestEcho;

    default:
      throw new Error(`Unknown ghostRequest type: ${req.type}`);
  }
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
