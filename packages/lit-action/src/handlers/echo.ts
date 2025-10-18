import { GhostRequestEcho, GhostResponse, EchoResponseData } from '../params';

/**
 * Handle echo request - simple test that returns the message
 */
export function handleEcho(request: GhostRequestEcho): GhostResponse<EchoResponseData> {
  return {
    ok: true,
    data: {
      echo: request.message,
      timestamp: Date.now(),
    },
  };
}