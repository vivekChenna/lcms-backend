import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  // A dedicated Postgres schema within a shared database (e.g. the Algihaz UAT/prod
  // server, where other projects each already get their own schema in one shared
  // database). Unset leaves every connection on its default schema, exactly as before.
  DB_SCHEMA: z.string().min(1).optional(),
  // "drona": sign-in happens through the DronaHQ container's own identity (an email
  // the container already vouches for -- see /auth/drona), not a password. Turns
  // password sign-in off (/auth/login refuses while this is set). "local" (default)
  // is the existing email+password flow, unchanged.
  AUTH_STRATEGY: z.enum(['local', 'drona']).default('local'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().positive().default(30),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(26_214_400),
  UPLOAD_ALLOWED_EXTENSIONS: z.string().min(1).default('pdf,doc,docx,xls,xlsx,png,jpg,jpeg,txt'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(1).optional(),
  // Public address of the frontend, used to build the links in password emails (no trailing slash)
  FRONTEND_URL: z.string().url().optional(),
  CORS_ORIGINS: z.string().default(''),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_DOMAIN: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    process.exit(1);
    return undefined as unknown as Env;
  }
  return parsed.data;
}
