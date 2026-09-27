import { describe, it, expect, vi } from 'vitest';
import { loadEnv } from '../../../src/config/env';

describe('loadEnv', () => {
  const valid = {
    NODE_ENV: 'test',
    PORT: '4000',
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_ACCESS_EXPIRES_IN: '15m',
    REFRESH_TOKEN_EXPIRES_DAYS: '30',
  };

  it('parses and coerces a valid environment', () => {
    const env = loadEnv(valid);
    expect(env.PORT).toBe(4000);
    expect(env.NODE_ENV).toBe('test');
  });

  it('exits the process when a required var is missing', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const { DATABASE_URL, ...missing } = valid;
    loadEnv(missing as unknown as NodeJS.ProcessEnv);
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('rejects a JWT secret shorter than 32 characters', () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    loadEnv({ ...valid, JWT_ACCESS_SECRET: 'short' });
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
