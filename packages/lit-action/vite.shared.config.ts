/**
 * Shared Vite configuration for Lit Action builds
 * This ensures consistency between production builds and test builds
 */

/**
 * Create the ENV object that gets injected into the Lit Action
 * Automatically includes all VITE_* environment variables from .env files
 *
 * @param mode - Build mode ('development' or 'production')
 * @param env - Environment variables loaded from .env files (only VITE_* prefixed)
 * @returns The ENV object to inject
 */
export function createLitActionEnv(
  mode: string,
  env: Record<string, string>
): Record<string, string> {
  return {
    MODE: mode,
    ...env, // Spread all loaded environment variables (only VITE_* vars)
  };
}
