import { test as base, Page } from '@playwright/test'
import { AuthHelper } from '../helpers/auth.helper'
import { APIHelper } from '../helpers/api.helper'
import { AssertionsHelper } from '../helpers/assertions.helper'
import { LLMProvidersHelper } from './helpers/llm-providers.helper'

/**
 * Extended test fixture with common helpers
 */
type TestFixtures = {
  authHelper: AuthHelper
  apiHelper: APIHelper
  assertHelper: AssertionsHelper
  llmProvidersHelper: LLMProvidersHelper
  authenticatedPage: Page
}

/**
 * Extend Playwright's test with custom fixtures
 */
export const test = base.extend<TestFixtures>({
  /**
   * Auth helper instance
   */
  authHelper: async ({ page }, use) => {
    const authHelper = new AuthHelper(page)
    await use(authHelper)
  },

  /**
   * API helper instance
   */
  apiHelper: async ({}, use) => {
    const apiHelper = new APIHelper(process.env.E2E_API_URL || 'http://localhost:4000')
    await use(apiHelper)
    // Cleanup test data after each test
    // await apiHelper.cleanupTestData(...)
  },

  /**
   * Assertions helper instance
   */
  assertHelper: async ({ page }, use) => {
    const assertHelper = new AssertionsHelper(page)
    await use(assertHelper)
  },

  /**
   * LLM Providers helper instance
   */
  llmProvidersHelper: async ({ page }, use) => {
    const llmProvidersHelper = new LLMProvidersHelper(page)
    await use(llmProvidersHelper)
  },

  /**
   * Pre-authenticated page with a logged-in user
   * Useful for tests that don't need to test login flow
   */
  authenticatedPage: async ({ page, authHelper, apiHelper }, use) => {
    // Create and login a test user
    const testUser = AuthHelper.generateTestUser()
    await authHelper.registerViaAPI(testUser)

    // Navigate to app first so localStorage can be accessed
    await page.goto('/')

    const token = await authHelper.loginViaAPI(testUser.email, testUser.password)

    // Initialize apiHelper with auth token so it extracts organizationId
    apiHelper.setToken(token)
    await apiHelper.getProfile()

    await use(page)
  },
})

export { expect } from '@playwright/test'
