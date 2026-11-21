import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'file:./test.db',
      WEBHOOK_SECRET: 'test-webhook-secret',
      SMS_PROVIDER: 'mock',
    },
    // Tests share one SQLite file; run files serially so they don't clobber each other.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
