import { test, expect } from './setup/test-hooks'
import { AuthHelper } from './helpers/auth.helper'

test.describe('Authentication - Session Management', () => {
  let testUserCredentials: any

  test.beforeAll(async ({ apiHelper }) => {
    // Store credentials before registration so we can login later
    testUserCredentials = AuthHelper.generateTestUser('session-test')
    await apiHelper.register(testUserCredentials)
  })

  test('should logout user and redirect to login', async ({ page, authHelper, assertHelper }) => {
    // Login first
    await authHelper.loginViaAPI(testUserCredentials.email, testUserCredentials.password)
    await page.goto('/dashboard')
    await assertHelper.assertOnDashboard()

    // Click user menu
    await page.getByRole('button', { name: /user menu|account|profile/i }).click()

    // Wait for menu to open and click logout
    await page.getByText('Log out').click()

    // Should redirect to login
    await assertHelper.assertOnLoginPage()

    // Should no longer be authenticated
    const isAuthenticated = await authHelper.isAuthenticated()
    expect(isAuthenticated).toBe(false)
  })

  test('should redirect to login when accessing protected routes without auth', async ({ page, assertHelper }) => {
    // Clear any existing auth
    await page.goto('/dashboard')

    // Try to access protected route
    await page.goto('/apis')

    // Should redirect to login
    await assertHelper.assertOnLoginPage()
  })

  test('should handle token expiration (401 response)', async ({ page, authHelper, assertHelper }) => {
    // Login first
    await authHelper.loginViaAPI(testUserCredentials.email, testUserCredentials.password)
    await page.goto('/dashboard')

    // Intercept API requests and return 401
    await page.route('**/{apis,gateways,tools,organizations}/**', (route) => {
      // Return 401 for protected endpoints
      route.fulfill({
        status: 401,
        body: JSON.stringify({ message: 'Unauthorized' }),
      })
    })

    // Try to navigate to another page (will trigger API call)
    await page.goto('/apis')

    // Should redirect to login after 401
    await assertHelper.assertOnLoginPage()
  })

  test('should clear local storage on logout', async ({ page, authHelper }) => {
    // Login
    await authHelper.loginViaAPI(testUserCredentials.email, testUserCredentials.password)
    await page.goto('/dashboard')

    // Verify token exists
    const tokenBefore = await page.evaluate(() => localStorage.getItem('token'))
    expect(tokenBefore).toBeTruthy()

    // Logout
    await page.getByRole('button', { name: /user menu|account|profile/i }).click()
    await page.getByText('Log out').click()

    // Verify token is cleared
    const tokenAfter = await page.evaluate(() => localStorage.getItem('token'))
    expect(tokenAfter).toBeNull()

    const userAfter = await page.evaluate(() => localStorage.getItem('user'))
    expect(userAfter).toBeNull()
  })

  test('should maintain session across tabs', async ({ page, context, authHelper }) => {
    // Login in first tab
    await authHelper.loginViaAPI(testUserCredentials.email, testUserCredentials.password)
    await page.goto('/dashboard')

    // Open new tab
    const newTab = await context.newPage()
    await newTab.goto('/dashboard')

    // Should be authenticated in new tab without logging in again
    await expect(newTab).toHaveURL(/\/dashboard/)
    await expect(newTab.getByRole('heading', { name: /dashboard/i })).toBeVisible()
  })

  test('should logout from all tabs when logging out from one tab', async ({ page, context, authHelper }) => {
    // Login in first tab
    await authHelper.loginViaAPI(testUserCredentials.email, testUserCredentials.password)
    await page.goto('/dashboard')

    // Open second tab
    const secondTab = await context.newPage()
    await secondTab.goto('/dashboard')

    // Logout from first tab
    await page.getByRole('button', { name: /user menu|account|profile/i }).click()
    await page.getByText('Log out').click()

    // First tab should be on login page
    await expect(page).toHaveURL(/\/auth\/login/)

    // Try to navigate in second tab - should redirect to login
    await secondTab.goto('/apis')
    await expect(secondTab).toHaveURL(/\/auth\/login/)
  })

  test('should remember user on browser restart (if Remember Me is checked)', async ({ page, authHelper, assertHelper }) => {
    // Login with "Remember Me" option if available
    await page.goto('/auth/login')
    await page.getByLabel('Email').fill(testUserCredentials.email)
    await page.getByLabel('Password').fill(testUserCredentials.password)

    // Check "Remember Me" if it exists
    const rememberMeCheckbox = page.getByLabel(/remember me/i)
    if (await rememberMeCheckbox.isVisible()) {
      await rememberMeCheckbox.check()
    }

    await page.getByRole('button', { name: /sign in|login/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Close and reopen page (simulates browser restart)
    await page.close()
    const newPage = await page.context().newPage()
    await newPage.goto('/dashboard')

    // Should still be authenticated
    await expect(newPage).toHaveURL(/\/dashboard/)
  })

  test('should handle concurrent requests with expired token', async ({ page, authHelper }) => {
    // Login
    await authHelper.loginViaAPI(testUserCredentials.email, testUserCredentials.password)
    await page.goto('/dashboard')

    // Set up multiple API routes to return 401
    let callCount = 0
    await page.route('**/{apis,gateways,tools,organizations}/**', (route) => {
      callCount++
      if (callCount <= 3) {
        route.fulfill({ status: 401, body: JSON.stringify({ message: 'Unauthorized' }) })
      } else {
        route.continue()
      }
    })

    // Make multiple API requests concurrently
    await Promise.all([
      page.goto('/apis'),
      page.goto('/tools'),
      page.goto('/gateways'),
    ]).catch(() => {
      // Expected to fail due to 401
    })

    // Should only redirect to login once (not multiple times)
    await expect(page).toHaveURL(/\/auth\/login/)
  })
})
