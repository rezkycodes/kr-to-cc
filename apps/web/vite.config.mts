/// <reference types="vitest" />
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

const backendTarget = process.env.VITE_BACKEND_URL || 'http://127.0.0.1:4000';
const proxiedPrefixes = ['/health', '/oauth', '/config', '/ui', '/v1'];

export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/apps/web',
  publicDir: '../server/src/ui/assets',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3210,
    host: '127.0.0.1',
    strictPort: true,
    proxy: Object.fromEntries(proxiedPrefixes.map((prefix) => [prefix, {
      target: backendTarget,
      changeOrigin: false,
      // Server-sent events must stream through the dev proxy unbuffered.
      ws: false,
    }])),
  },
  preview: {
    port: 4300,
    host: '127.0.0.1',
    strictPort: true,
  },
  build: {
    outDir: '../../dist/apps/web',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: {
      transformMixedEsModules: true,
    },
  },
  test: {
    name: 'web',
    watch: false,
    globals: true,
    environment: 'happy-dom',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../coverage/apps/web',
      provider: 'v8' as const,
    },
  },
});
