import { describe, expect, it } from 'vitest';
import { assertAppDatabaseUrl } from './client';

describe('DATABASE_APP_URL in production (F32)', () => {
  it('is required in production unless the owner connection is allowed on purpose', () => {
    expect(() => assertAppDatabaseUrl(null, { NODE_ENV: 'production' })).toThrow(/DATABASE_APP_URL es obligatoria en producción/);
    expect(() => assertAppDatabaseUrl('', { NODE_ENV: 'production' })).toThrow(/ALLOW_OWNER_CONNECTION=true/);
    expect(() => assertAppDatabaseUrl('postgresql://clinicai_app@db/x', { NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertAppDatabaseUrl(null, { NODE_ENV: 'production', ALLOW_OWNER_CONNECTION: 'true' })).not.toThrow();
    // Development and tests may use the owner connection (the bot warns at startup).
    expect(() => assertAppDatabaseUrl(null, { NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertAppDatabaseUrl(null, {})).not.toThrow();
  });
});
