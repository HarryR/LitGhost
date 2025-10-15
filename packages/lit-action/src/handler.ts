/**
 * Main request handler for Lit Action
 * Pattern matches on ghostRequest type and executes appropriate logic
 */

import type { GhostRequest, GhostResponse, GhostRequestEcho } from './types';
import { validateEchoRequest } from './validation';

/**
 * Main request handler
 * Takes a validated ghostRequest and returns a response
 * Does NOT call Lit.Actions.setResponse - that's done in main()
 */
export async function handleRequest(
  request: GhostRequest
): Promise<GhostResponse> {
  try {
    // Pattern match on request type
    // Validate and dispatch to appropriate handler
    if (request.type === 'echo') {
      const validatedRequest = validateEchoRequest(request);
      return handleEcho(validatedRequest);
    }

    // This should never happen if validation is correct
    return {
      success: false,
      error: 'Unknown request type',
      details: { type: (request as any).type },
    };
  } catch (error) {
    console.error('Error in handleRequest:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: error instanceof Error ? error.stack : undefined,
    };
  }
}

// ============================================================================
// Individual Request Handlers
// ============================================================================

/**
 * Handle echo request - simple test that returns the message
 */
function handleEcho(request: GhostRequestEcho): GhostResponse {
  return {
    success: true,
    data: {
      echo: request.message,
      timestamp: Date.now(),
    },
  };
}
