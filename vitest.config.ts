import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
    // Integration test files each run/undo migrations against the same shared
    // test Postgres in their own beforeAll/afterAll — running files in parallel
    // races CREATE/DROP TABLE across files. Unit tests don't share state, so
    // this costs nothing meaningful given the suite's size.
    fileParallelism: false,
    // loadEnv() runs during import of several modules under test (e.g. the auth
    // plugin). Supplying required vars here keeps the suite self-contained —
    // it never depends on a developer's local .env file, and works in CI.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgres://lcms:lcms@localhost:5433/lcms_test',
      JWT_ACCESS_SECRET: 'test-only-secret-value-at-least-32-chars-long',
      JWT_ACCESS_EXPIRES_IN: '15m',
      REFRESH_TOKEN_EXPIRES_DAYS: '30',
      PORT: '4001',
    },
  },
});
