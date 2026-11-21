import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './', // relative paths so the build works under a sub-path such as GitHub Pages
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
