import { GhostRequestEcho, GhostResponse } from '../params';

/**
 * Handle echo request - simple test that returns the message
 */
export function handleEcho(request: GhostRequestEcho): GhostResponse {
  return {
    ok: true,
    data: {
      echo: request.message,
      timestamp: Date.now(),
    },
  };
}