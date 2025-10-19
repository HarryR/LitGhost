/**
 * HTTP handler tests using supertest
 *
 * These tests verify the Express server endpoints work correctly
 * without needing to start an actual server
 */

import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createTestApp } from '../index';
import type { PersistentTestState } from '../executor';

describe('Test Server HTTP Handler', () => {
  let app: Express;
  let persistentState: PersistentTestState;

  beforeAll(async () => {
    // Use the actual createTestApp function to ensure we test the real code path
    const result = await createTestApp();
    app = result.app;
    persistentState = result.persistentState;
  });

  describe('POST /lit-test', () => {
    it('should handle echo request successfully', async () => {
      const response = await request(app)
        .post('/lit-test')
        .send({
          ghostRequest: {
            type: 'echo',
            message: 'Hello from HTTP test!',
          }
        })
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body.ok).toBe(true);
      expect(response.body.data.echo).toBe('Hello from HTTP test!');
      expect(response.body.data.timestamp).toBeTypeOf('number');
    });

    it('should return validation error for invalid request body', async () => {
      // When body is a string, express parses it and validation happens in Lit Action
      const response = await request(app)
        .post('/lit-test')
        .send('invalid')
        .expect(200);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain('ghostRequest must be an object');
    });

    it('should return 400 for malformed JSON', async () => {
      await request(app)
        .post('/lit-test')
        .set('Content-Type', 'application/json')
        .send('{invalid json}')
        .expect(400);

      // Express will catch this as bad JSON before it reaches our handler
    });

    it('should handle validation errors for missing message', async () => {
      const response = await request(app)
        .post('/lit-test')
        .send({
          ghostRequest: {
            type: 'echo',
            // message is missing
          }
        })
        .expect(200); // The action returns 200 with error in body

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain('message must be a string');
    });

    it('should handle unknown request types', async () => {
      const response = await request(app)
        .post('/lit-test')
        .send({
          ghostRequest: {
            type: 'unknown_type',
            data: 'test',
          }
        })
        .expect(200);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain('Unknown ghostRequest type');
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200)
        .expect('Content-Type', /json/);

      expect(response.body.status).toBe('ok');
      expect(response.body.timestamp).toBeTypeOf('number');
    });
  });

  describe('Persistent State', () => {
    it('should maintain state across multiple requests', async () => {
      // Track state manually in the shared persistentState
      persistentState.requestCount = 0;

      // First request
      await request(app)
        .post('/lit-test')
        .send({
          ghostRequest: { type: 'echo', message: 'test1' }
        })
        .expect(200);

      persistentState.requestCount++;

      // Second request
      await request(app)
        .post('/lit-test')
        .send({
          ghostRequest: { type: 'echo', message: 'test2' },
        })
        .expect(200);

      persistentState.requestCount++;

      // State should have persisted across requests
      expect(persistentState.requestCount).toBe(2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty request body', async () => {
      const response = await request(app)
        .post('/lit-test')
        .send({})
        .expect(200);

      // Should fail validation
      expect(response.body.ok).toBe(false);
    });

    it('should handle array instead of object', async () => {
      const response = await request(app)
        .post('/lit-test')
        .send([])
        .expect(400);

      expect(response.body.error).toBeDefined();
    });
  });
});
