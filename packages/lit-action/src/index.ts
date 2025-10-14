/**
 * Lit Action Entry Point
 *
 * This file is compiled into a single JavaScript file that runs in a Deno TEE
 * on the Lit Protocol network. It has access to the @monorepo/core library
 * and environment variables embedded at build time.
 *
 * jsParams (passed from client via executeJs) are available as globals:
 * - ghostRequest: The request object (discriminated union)
 * - Lit: The Lit Actions namespace with methods like setResponse, signEcdsa, etc.
 */

import { validateJsParams } from './validation';
import { handleRequest } from './handler';
import type { GhostResponse } from './types';

/**
 * Environment variables are available via the ENV global
 * This is injected during build time via vite.config.ts
 *
 * All VITE_* environment variables from .env files are available here.
 * Add new variables to .env.development and .env.production as needed.
 */
declare const ENV: {
  MODE: string;
  VITE_TELEGRAM_BOT_API_KEY: string;
  // Add more VITE_* env vars here as needed
};

/**
 * Main Lit Action function
 * This is the entry point that will be executed by the Lit Action runner
 *
 * Globals available (injected via jsParams):
 * - ghostRequest: GhostRequest
 * - Lit: LitGlobalNamespace
 */
async function main() {
  console.log('🚀 Lit Action starting (mode:', ENV.MODE + ')');

  try {
    // Validate jsParams from global scope
    const params = validateJsParams({
      ghostRequest: globalThis.ghostRequest
    });

    console.log('✓ Validated jsParams:', {
      requestType: params.ghostRequest.type
    });

    // Handle the request
    const response: GhostResponse = await handleRequest(
      params.ghostRequest
    );

    console.log('✓ Request handled:', response.success ? 'success' : 'error');

    // Set response using Lit Actions API
    // The response must be JSON-serializable
    Lit.Actions.setResponse({
      response: JSON.stringify(response),
    });

    console.log('✓ Lit Action completed successfully');
  } catch (error) {
    console.error('✗ Lit Action failed:', error);

    // Return error response
    const errorResponse: GhostResponse = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      details: error instanceof Error ? error.stack : String(error),
    };

    Lit.Actions.setResponse({
      response: JSON.stringify(errorResponse),
    });
  }
}

// Execute the main function
// This is the entry point when the Lit Action is invoked
main().catch((error) => {
  console.error('✗ Fatal error in Lit Action:', error);
  throw error;
});
