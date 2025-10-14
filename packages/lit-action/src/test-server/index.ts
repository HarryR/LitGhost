/**
 * Local test server for Lit Action development
 *
 * Provides instant HMR (Hot Module Replacement) for rapid development:
 * - POST to /lit-test with jsParams in body
 * - Server creates isolated execution context (simulates Lit's disposable process)
 * - Injects jsParams and Lit mock into global scope
 * - Loads fresh Lit Action code via Vite SSR (instant updates)
 * - Executes and returns the response
 *
 * Usage:
 *   pnpm dev:server
 *
 *   curl -X POST http://localhost:3030/lit-test \
 *     -H "Content-Type: application/json" \
 *     -d '{"ghostRequest": {"type": "echo", "message": "Hello"}}'
 */

import express, { type Express } from 'express';
import { executeLitAction, createPersistentState, type PersistentTestState } from './executor';
import { loadLitActionCode } from './test-helpers';

const PORT = process.env.PORT || 3030;

/**
 * Create the Express app
 * Exported for testing with supertest
 */
export async function createTestApp(options?: {
  persistentState?: PersistentTestState;
}): Promise<{ app: Express; persistentState: PersistentTestState }> {
  const app = express();

  // Parse JSON bodies
  app.use(express.json());

  // Create or use provided persistent state
  let persistentState: PersistentTestState = options?.persistentState || createPersistentState();

  // Load the Lit Action code once at startup
  // In development, restart the server to pick up changes
  console.log('📦 Loading Lit Action code...');
  const litActionCode = await loadLitActionCode();
  console.log('✓ Lit Action code loaded');

  /**
   * POST /lit-test
   *
   * Body should contain jsParams:
   * {
   *   "ghostRequest": { "type": "echo", "message": "test" },
   *   ... other params
   * }
   */
  app.post('/lit-test', async (req, res) => {
    const startTime = Date.now();

    try {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📨 Incoming Lit Action test request');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      const jsParams = req.body;

      if (!jsParams || typeof jsParams !== 'object' || Array.isArray(jsParams)) {
        return res.status(400).json({
          error: 'Request body must be an object containing jsParams',
        });
      }

      console.log('📦 jsParams:', JSON.stringify(jsParams, null, 2));
      console.log('🔐 Creating isolated execution context...');
      console.log('🚀 Executing Lit Action...');

      // Execute using the sandboxed executor
      // persistentState is mutated directly by the executor, so no need to reassign
      const result = await executeLitAction(
        litActionCode,
        jsParams,
        persistentState
      );

      // Check for errors
      if (result.error) {
        console.error('✗ Execution error:', result.error);
        const elapsed = Date.now() - startTime;
        console.log(`✗ Request failed after ${elapsed}ms`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(500).json({
          success: false,
          error: result.error.message,
          details: result.error.stack,
        });
      }

      // Check if response was set
      if (!result.response) {
        console.log('⚠️  No response was set via Lit.Actions.setResponse()');
        const elapsed = Date.now() - startTime;
        console.log(`⚠️  Request completed in ${elapsed}ms (no response)`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        return res.status(500).json({
          error: 'Lit Action did not set a response',
        });
      }

      console.log('✓ Response captured:', result.response.slice(0, 100) + '...');

      const elapsed = Date.now() - startTime;
      console.log(`✓ Request completed in ${elapsed}ms`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      // Parse and return the response
      const response = JSON.parse(result.response);
      res.json(response);

    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error('✗ Error executing Lit Action:', error);
      console.log(`✗ Request failed after ${elapsed}ms`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : String(error),
      });
    }
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  return { app, persistentState };
}

/**
 * Start the development server
 * Only used when running directly (not in tests)
 */
async function startServer() {
  const { app } = await createTestApp();

  // Start the server
  app.listen(PORT, () => {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log('║                                                       ║');
    console.log('║   🔥 Lit Action Test Server                          ║');
    console.log('║                                                       ║');
    console.log('╚═══════════════════════════════════════════════════════╝\n');
    console.log(`🌐 Server running at: http://localhost:${PORT}`);
    console.log(`📡 Test endpoint: POST http://localhost:${PORT}/lit-test`);
    console.log(`❤️  Health check: GET http://localhost:${PORT}/health`);
    console.log('\n💡 Restart server to pick up code changes\n');
    console.log('Example request:');
    console.log(`  curl -X POST http://localhost:${PORT}/lit-test \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(`    -d '{"ghostRequest": {"type": "echo", "message": "Hello!"}}'`);
    console.log('\n');
  });
}

// Start the server only if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
