import { describe, it, expect } from 'vitest';
import { loadEnv } from '../../../src/config/env';

const base = { DATABASE_URL: 'postgres://x', JWT_ACCESS_SECRET: 'x'.repeat(32) };

describe('SMTP env settings', () => {
  it('defaults the port and secure flag and leaves host, credentials and sender optional', () => {
    const env = loadEnv({ ...base });
    expect(env.SMTP_PORT).toBe(1025);
    expect(env.SMTP_SECURE).toBe(false);
    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.SMTP_USER).toBeUndefined();
    expect(env.SMTP_PASSWORD).toBeUndefined();
    expect(env.MAIL_FROM).toBeUndefined();
  });

  it('parses explicit SMTP settings', () => {
    const env = loadEnv({
      ...base,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'true',
      SMTP_USER: 'mailer',
      SMTP_PASSWORD: 'secret',
      MAIL_FROM: 'lcms@algihaz.example',
    });
    expect(env.SMTP_HOST).toBe('smtp.example.com');
    expect(env.SMTP_PORT).toBe(587);
    expect(env.SMTP_SECURE).toBe(true);
    expect(env.SMTP_USER).toBe('mailer');
    expect(env.MAIL_FROM).toBe('lcms@algihaz.example');
  });
});
