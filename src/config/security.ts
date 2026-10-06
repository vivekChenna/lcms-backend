import type { Env } from './env';

export const ACCESS_COOKIE = 'lcms_access';
export const REFRESH_COOKIE = 'lcms_refresh';

export type SecurityConfig = {
  corsOrigins: string[];
  cookie: {
    secure: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    domain?: string;
    accessMaxAgeSeconds: number;
    refreshMaxAgeSeconds: number;
  };
};

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

export function parseDurationSeconds(value: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported duration "${value}" (use a number and one unit, e.g. 15m, 2h, 30d)`);
  }
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
}

export function securityConfigFromEnv(env: Env): SecurityConfig {
  const secure = env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production';
  if (env.COOKIE_SAMESITE === 'none' && !secure) {
    throw new Error('COOKIE_SAMESITE=none requires COOKIE_SECURE=true');
  }
  return {
    corsOrigins: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
    cookie: {
      secure,
      sameSite: env.COOKIE_SAMESITE,
      domain: env.COOKIE_DOMAIN,
      accessMaxAgeSeconds: parseDurationSeconds(env.JWT_ACCESS_EXPIRES_IN),
      refreshMaxAgeSeconds: env.REFRESH_TOKEN_EXPIRES_DAYS * 86_400,
    },
  };
}
