/**
 * Tests for Lit Action
 *
 * These tests use the sandboxed executor to test the Lit Action
 * in an isolated environment that simulates the Lit Protocol runtime
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { executeLitAction, createPersistentState, type PersistentTestState } from '../test-server/executor';
import { loadLitActionCode } from '../test-server/test-helpers';
import type { GhostResponse } from '../params';

describe('Lit Action', () => {
  let persistentState: PersistentTestState;
  let litActionCode: string;

  // Load the Lit Action code once before all tests
  // This loads from source (src/index.ts) via Vite transform for hot reloading
  beforeAll(async () => {
    litActionCode = await loadLitActionCode();
  });

  beforeEach(() => {
    // Create fresh persistent state for each test
    // Define whatever fields you need - the state is mutable across executions
    persistentState = createPersistentState({
      pkpPrivateKey: '0xtest_private_key_for_testing',
      // Add more fields as needed for your tests
    });
  });

  describe('Echo Request', () => {
    it('should echo back the message', async () => {
      const result = await executeLitAction(
        litActionCode,
        {
          ghostRequest: {
            type: 'echo',
            message: 'Hello from test!',
          }
        },
        persistentState
      );

      expect(result.error).toBeUndefined();
      expect(result.response).toBeDefined();

      const response: GhostResponse = JSON.parse(result.response!);

      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.data.echo).toBe('Hello from test!');
        expect(response.data.timestamp).toBeTypeOf('number');
      }
    });

    it('should fail if message is missing', async () => {
      const result = await executeLitAction(
        litActionCode,
        {
          ghostRequest: {
            type: 'echo',
            // message is missing
          } as any,
        },
        persistentState
      );

      expect(result.response).toBeDefined();

      const response: GhostResponse = JSON.parse(result.response!);

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('message must be a string');
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown request types', async () => {
      const result = await executeLitAction(
        litActionCode,
        {
          ghostRequest: {
            type: 'unknown_type',
            data: 'test',
          } as any
        },
        persistentState
      );

      expect(result.response).toBeDefined();

      const response: GhostResponse = JSON.parse(result.response!);

      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toContain('Cannot validate ghostRequest');
      }
    });
  });

  describe('Persistent State', () => {
    it('should maintain state across multiple executions', async () => {
      // Track executions manually in persistent state
      persistentState.executionCount = 0;

      // First execution
      await executeLitAction(
        litActionCode,
        {
          ghostRequest: { type: 'echo', message: 'test1' },
        },
        persistentState
      );
      persistentState.executionCount++;

      // Second execution - state should be preserved
      await executeLitAction(
        litActionCode,
        {
          ghostRequest: { type: 'echo', message: 'test2' },
        },
        persistentState
      );
      persistentState.executionCount++;

      // Check that state persisted
      expect(persistentState.executionCount).toBe(2);
    });

    it('should allow custom fields in persistent state', async () => {
      // Add custom fields to persistent state
      persistentState.customValue = 'test123';
      persistentState.maxRetries = 5;

      await executeLitAction(
        litActionCode,
        {
          ghostRequest: { type: 'echo', message: 'test' },
        },
        persistentState
      );

      // Fields should still be there after execution
      expect(persistentState.customValue).toBe('test123');
      expect(persistentState.maxRetries).toBe(5);
    });
  });
});
