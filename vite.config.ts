import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const apiProxyTarget = process.env.API_PROXY_TARGET || `http://127.0.0.1:${process.env.API_PORT || '3001'}`;
const includeBackendTests = process.env.VITEST_BACKEND === '1';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: apiProxyTarget,
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    globals: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-server/**',
      ...(includeBackendTests ? [] : ['**/server/**']),
      '**/._*',
    ],
  },
});
