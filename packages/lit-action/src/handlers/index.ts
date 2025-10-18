/**
 * Main request handler for Lit Action
 * Pattern matches on ghostRequest type and executes appropriate logic
 */

import '../lit-interfaces'; // Import to ensure global type definitions are loaded
import { type JsParams, GhostRequestEcho, GhostRequestBootstrap, GhostRequestRegisterTelegram, GhostResponse } from '../params';
import type { GhostContext } from '../context';

import { handleBootstrap } from './bootstrap';
import { handleEcho } from './echo';
import { handleRegisterTelegram } from './register-telegram';

/**
 * Main request handler
 * Takes validated jsParams and context, returns a response
 * Does NOT call Lit.Actions.setResponse - that's done in main()
 *
 * @param jsParams - Validated parameters passed to the Lit Action
 * @param ctx - Runtime context with provider and contract instances (unused for now)
 */
export async function handleRequest(
  {ghostRequest}: JsParams,
  ctx: GhostContext
): Promise<GhostResponse> {
  try {
    switch( ghostRequest.type ) {
      case 'echo': return handleEcho(ghostRequest as GhostRequestEcho);
      case 'bootstrap': return await handleBootstrap(ghostRequest as GhostRequestBootstrap, ctx);
      case 'register-telegram': return await handleRegisterTelegram(ghostRequest as GhostRequestRegisterTelegram, ctx);
      default: return { ok: false, error: `Unknown request type: ${(ghostRequest as any).type}` };
    }
  } catch (error) {
    console.error('Error in handleRequest:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
