/**
 * Showcase recordings: real journeys on staging, filmed for the website
 * and docs. Same QA session as the staging gate (run the gate once first
 * so gate-results/.auth/qa.json exists), human names instead of gate
 * names, a readable pace, and a video per journey. Everything a journey
 * creates is deleted when it ends.
 *
 *   cd frontend && npx playwright test --config=playwright.showcase.config.ts
 *
 * Videos land in showcase-results/<journey>/video.webm.
 */
import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'path'
import { APP_URL, QA_STATE_FILE, RUN_ID } from './tests/staging/support/env'

process.env.GATE_RUN_ID = RUN_ID
const OUT = resolve(__dirname, '../showcase-results')

export default defineConfig({
  testDir: './tests/showcase',
  // Signs in as the QA user when the saved session is gone or stale.
  globalSetup: './tests/staging/support/global-setup.ts',
  outputDir: OUT,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 10 * 60_000,
  expect: { timeout: 30_000 },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: APP_URL,
    storageState: QA_STATE_FILE,
    viewport: { width: 1440, height: 900 },
    video: { mode: 'on', size: { width: 1440, height: 900 } },
    launchOptions: { slowMo: Number(process.env.SHOWCASE_SLOWMO || 250) },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
})
