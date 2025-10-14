/**
 * Shared test helpers for Lit Action tests
 * Provides a single source of truth for loading Lit Action code
 */

import { build, loadEnv } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLitActionEnv } from '../../vite.shared.config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load the latest Lit Action code by bundling it in-memory
 * This enables hot reloading and ensures tests always use the latest source
 *
 * @param mode - Build mode ('development' or 'production'), defaults to 'development'
 * @returns The bundled JavaScript code ready for execution
 */
export async function loadLitActionCode(mode: 'development' | 'production' = 'development'): Promise<string> {
  // Resolve to the package root (where .env files are located)
  const packageRoot = resolve(__dirname, '../..');

  // Load environment variables from .env files (same as vite.config.ts)
  // Only loads VITE_* prefixed vars by default
  const env = loadEnv(mode, packageRoot);

  // Bundle the Lit Action in-memory using Vite
  // This produces self-contained code without SSR-specific helpers
  const result = await build({
    root: packageRoot,
    logLevel: 'error',
    build: {
      write: false, // Don't write to disk
      minify: false, // Keep readable for debugging
      target: 'es2020',
      lib: {
        entry: resolve(__dirname, '../index.ts'),
        name: 'LitAction',
        formats: ['es']
      },
      rollupOptions: {
        external: [],
        output: {
          inlineDynamicImports: true,
          // Inject environment variables (uses same logic as vite.config.ts)
          intro: `const ENV = ${JSON.stringify(createLitActionEnv(mode, env))};`,
        },
      },
    },
  });

  // Extract the generated code
  if (!Array.isArray(result)) {
    throw new Error('Expected build result to be an array');
  }

  const output = result[0];
  if (!('output' in output)) {
    throw new Error('Expected build output to have output property');
  }

  const chunk = output.output[0];
  if (!('code' in chunk)) {
    throw new Error('Expected chunk to have code property');
  }

  return chunk.code;
}
