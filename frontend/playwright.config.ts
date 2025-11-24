import { defineConfig, devices } from '@playwright/test'

/**
 * E2E Test Configuration - Tests against REAL backend
 *
 * Environment Variables:
 * - E2E_BASE_URL: Frontend URL (default: http://localhost:4001)
 * - E2E_API_URL: Backend API URL (default: http://localhost:4000/api)
 * - E2E_HEADLESS: Run in headless mode (default: true in CI)
 * - E2E_SLOWMO: Slow down operations (default: 0)
 *
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests/e2e',

  /* Run tests in files in parallel - disable for E2E to avoid conflicts */
  fullyParallel: false,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Run one test at a time to avoid database conflicts */
  workers: 1,

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
    process.env.CI ? ['github'] : ['line'],
  ],

  /* Global timeout for each test - API operations can be slow */
  timeout: 90000, // 90 seconds per test (async jobs need time)

  /* Expect timeout for assertions */
  expect: {
    timeout: 10000, // 10 seconds for assertions
  },

  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3002',

    /* Collect trace on first retry and on failure */
    trace: 'retain-on-failure',

    /* Screenshot on failure */
    screenshot: 'only-on-failure',

    /* Video on failure - helps debug issues */
    video: 'retain-on-failure',

    /* Action timeout - wait up to 15s for actions like click, fill */
    actionTimeout: 15000,

    /* Navigation timeout - API calls can be slow */
    navigationTimeout: 30000,

    /* Slow down operations for debugging */
    launchOptions: {
      slowMo: parseInt(process.env.E2E_SLOWMO || '0'),
    },
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },

    // Uncomment to test on other browsers (slower)
    // {
    //   name: 'firefox',
    //   use: { ...devices['Desktop Firefox'] },
    // },
    // {
    //   name: 'webkit',
    //   use: { ...devices['Desktop Safari'] },
    // },

    /* Mobile tests - DISABLED due to timeout issues */
    // {
    //   name: 'mobile',
    //   use: {
    //     ...devices['Pixel 5'],
    //     viewport: { width: 375, height: 667 },
    //   },
    // },
  ],

  /* Global setup and teardown */
  globalSetup: require.resolve('./tests/e2e/setup/global-setup'),
  globalTeardown: require.resolve('./tests/e2e/setup/global-teardown'),

  /* Run your local dev server before starting the tests */
  webServer: process.env.CI ? undefined : {
    command: 'PORT=3002 npm run dev',
    url: 'http://localhost:3002',
    reuseExistingServer: true, // Don't restart if already running
    timeout: 120000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})