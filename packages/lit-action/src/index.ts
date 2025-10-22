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

import './lit-interfaces'; // Import to ensure global type definitions are loaded
import { getParams } from './params';
import { handleRequest } from './handlers';
import { GhostContext } from './context';

/**
 * Environment variables are available via the ENV global
 * This is injected during build time via vite.config.ts
 *
 * All VITE_* environment variables from .env files are available here.
 * Add new variables to .env.development and .env.production as needed.
 */
declare const ENV: {
  VITE_MODE: 'development' | 'production';
  VITE_CHAIN: string;
  VITE_CONTRACT_LITGHOST: string;
  VITE_CONTRACT_TOKEN: string;
  VITE_TELEGRAM_BOT_ID: string;
  VITE_TELEGRAM_PUBLIC_KEY: string;
  // Add more VITE_* env vars here as needed
};

/**
 * Main Lit Action function
 * This is the entry point that will be executed by the Lit Action runner
 *
 * Parameters (passed via jsParams):
 * - ghostRequest: GhostRequest
 *
 * Globals available:
 * - Lit: LitGlobalNamespace (or LitAuth/LitActions separately in v8)
 * - ENV: Environment variables injected at build time
 */
async function main() {
  try {
    const jsParams = getParams();
    const ctx = await GhostContext.fromEnv(ENV);
    const response = await handleRequest(jsParams, ctx);
    Lit.Actions.setResponse({
      response: JSON.stringify(response),
    });
  }
  catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
    });
  }
}

// Execute the main function
// This is the entry point when the Lit Action is invoked
main();
