import { defineConfig, devices } from '@playwright/test'

/**
 * Local run against a dev stack that is already up (see scripts/dev-stack.sh):
 *   frontend  http://localhost:3102  (vite, ALMYTY_API_TARGET=http://localhost:4100)
 *   backend   http://localhost:4100
 *
 * Nothing is started or migrated here; the specs talk to the API through the
 * vite proxy on the same origin as the page, so the httpOnly cookie set by
 * registration is the only auth they need.
 *
 *   E2E_BASE_URL=http://localhost:3102 npx playwright test --config=playwright.local.config.ts models
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 120000,
  expect: { timeout: 10000 },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3102',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
    },
  ],
})
