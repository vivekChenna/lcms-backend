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
  },
});
