import { defineConfig } from 'vitest/config';

/** Browser tests: they start the app with Vite and drive it with Playwright (Chromium). Run with `npm run e2e`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
