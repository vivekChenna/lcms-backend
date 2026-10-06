import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';
import { parseDurationSeconds, securityConfigFromEnv } from '../../../src/config/security';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('parseDurationSeconds', () => {
  it.each([['30s', 30], ['15m', 900], ['2h', 7200], ['30d', 2_592_000]])('parses %s', (input, seconds) => {
    expect(parseDurationSeconds(input as string)).toBe(seconds);
  });

  it('rejects unsupported formats', () => {
    expect(() => parseDurationSeconds('soon')).toThrow(/Unsupported duration/);
    expect(() => parseDurationSeconds('1h30m')).toThrow(/Unsupported duration/);
  });
});

describe('securityConfigFromEnv', () => {
  it('defaults to no CORS origins, lax non-secure cookies in development, token lifetimes from env', () => {
    const config = securityConfigFromEnv(loadEnv({ ...base, NODE_ENV: 'development' }));
    expect(config.corsOrigins).toEqual([]);
    expect(config.cookie).toMatchObject({ secure: false, sameSite: 'lax', accessMaxAgeSeconds: 900, refreshMaxAgeSeconds: 2_592_000 });
    expect(config.cookie.domain).toBeUndefined();
  });

  it('parses a comma separated origin list and trims blanks', () => {
    const config = securityConfigFromEnv(loadEnv({ ...base, CORS_ORIGINS: ' http://a.test , ,http://b.test ' }));
    expect(config.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
  });

  it('makes cookies secure by default in production and lets COOKIE_SECURE override', () => {
    expect(securityConfigFromEnv(loadEnv({ ...base, NODE_ENV: 'production' })).cookie.secure).toBe(true);
    expect(securityConfigFromEnv(loadEnv({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).cookie.secure).toBe(false);
  });

  it('refuses SameSite=None without Secure', () => {
    expect(() => securityConfigFromEnv(loadEnv({ ...base, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' }))).toThrow(/requires COOKIE_SECURE/);
    expect(securityConfigFromEnv(loadEnv({ ...base, COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'true' })).cookie.sameSite).toBe('none');
  });

  it('passes the cookie domain through', () => {
    expect(securityConfigFromEnv(loadEnv({ ...base, COOKIE_DOMAIN: '.algihaz.example' })).cookie.domain).toBe('.algihaz.example');
  });
});
