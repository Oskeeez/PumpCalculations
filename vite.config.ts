import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

declare const process: { env: Record<string, string | undefined> };

/** Short commit id of this build, from the CI environment (Cloudflare, GitHub), else 'dev'. Shown in the app so you can tell which version is live. */
function buildId(): string {
  const ci = process.env.WORKERS_CI_COMMIT_SHA ?? process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA;
  return ci ? ci.slice(0, 7) : 'dev';
}

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  base: './', // relative paths so the build works under a sub-path such as GitHub Pages
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
