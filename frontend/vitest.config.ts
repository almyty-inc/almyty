/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.tsx'],
    css: true,
    // Only pick up unit tests under src/. Without an explicit
    // include, vitest's default glob
    // `**/*.{test,spec}.{ts,tsx,...}` matches the Playwright
    // E2E specs at `tests/e2e/*.spec.ts`, which crash vitest
    // with "Playwright Test did not expect test.describe() to
    // be called here." Keeping this scope tight also means
    // `npm test` runs fast in CI and locally.
    include: ['src/**/*.{test,spec}.{ts,tsx,js,jsx}'],
    exclude: ['node_modules', 'dist', 'tests/e2e', 'tests/**/*.spec.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/index.ts',
      ],
      thresholds: {
        global: {
          branches: 75,
          functions: 75,
          lines: 75,
          statements: 75,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})