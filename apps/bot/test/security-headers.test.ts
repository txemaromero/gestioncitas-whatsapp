/**
 * F25 — the bot answers every request (also errors and unknown routes) with security headers.
 */
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createTestDeps } from './helpers';

describe('F25 — security headers of the bot', () => {
  it('are sent on every response, HSTS only in production', async () => {
    const app = buildApp(createTestDeps());
    for (const url of ['/health', '/webhook?hub.mode=subscribe', '/does-not-exist']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.headers['content-security-policy'], url).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['x-frame-options'], url).toBe('DENY');
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(res.headers['strict-transport-security'], url).toBeUndefined();
    }
    await app.close();

    const production = buildApp(createTestDeps({ config: { NODE_ENV: 'production' } }));
    const res = await production.inject({ method: 'POST', url: '/webhook', payload: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains');
    await production.close();
  });
});
