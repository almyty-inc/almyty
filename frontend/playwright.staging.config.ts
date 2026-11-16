/**
 * The staging gate's browser suite: tests/staging against the deployed
 * staging stack, signed in as the QA user (see tests/staging/support).
 * No stubs, no keys. Run it through `npm run gate:staging` at the repo
 * root, which also runs the CLI smoke tests and writes gate-report.md.
 */
import { defineConfig, devices } from '@playwright/test'
import { join } from 'path'
import { APP_URL, GATE_DIR, QA_STATE_FILE, RUN_ID } from './tests/staging/support/env'

// Workers inherit this, so every test in the run shares one run id.
process.env.GATE_RUN_ID = RUN_ID

export default defineConfig({
  testDir: './tests/staging',
  globalSetup: './tests/staging/support/global-setup.ts',
  outputDir: join(GATE_DIR, 'playwright'),
  // Tests are independent; two workers keep the run short without
  // tripping staging's per-IP throttles.
  fullyParallel: true,
  workers: Number(process.env.GATE_WORKERS || 2),
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: join(GATE_DIR, 'playwright-results.json') }],
  ],
  timeout: 5 * 60_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: APP_URL,
    storageState: QA_STATE_FILE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    // Results are read the way a person takes them: through the Copy button.
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    {
      name: 'staging',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
  ],
})