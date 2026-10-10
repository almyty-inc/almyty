import type { Page } from '@playwright/test'
import { test, expect } from './setup/test-hooks'
import { AuthHelper } from './helpers/auth.helper'

/**
 * Fill the sign-up form and submit it, once the captcha (if the build has
 * one) has handed the form its token: before then the form refuses to submit
 * and only says so in a toast.
 */
async function submitSignUp(
  page: Page,
  user: { firstName: string; lastName: string; email: string; password: string; organizationName: string },
) {
  await page.getByLabel('First name').fill(user.firstName)
  await page.getByLabel('Last name').fill(user.lastName)
  await page.getByLabel(/Email/i).fill(user.email)
  await page.getByLabel('Password', { exact: true }).fill(user.password)
  await page.getByLabel('Confirm password').fill(user.password)
  await page.getByLabel('Organization name').fill(user.organizationName)
  await page.getByLabel(/terms.*service|agree/i).check()
  await AuthHelper.waitForCaptcha(page)
  await page.getByRole('button', { name: /create account|register|sign up/i }).click()
}

test.describe('Authentication - Registration', () => {
  // The tests that submit the form need a captcha token. Against a real site
  // key (staging, production) a headless browser never gets one, so those
  // skip (AuthHelper.skipUnlessCaptchaAutoPasses); the rest run anywhere.
  //
  // They wait on what the page does (the URL, a heading, a message), never on
  // 'networkidle': the captcha's frame keeps talking to its provider for as
  // long as the page is open, so the network never goes idle on a build that
  // has one.
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth/register')
  })

  test('should display registration form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /register|sign up/i })).toBeVisible()
    await expect(page.getByLabel('First name')).toBeVisible()
    await expect(page.getByLabel('Last name')).toBeVisible()
    await expect(page.getByLabel(/Email/i)).toBeVisible()
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Confirm password')).toBeVisible()
    await expect(page.getByLabel('Organization name')).toBeVisible()
    await expect(page.getByRole('button', { name: /create account|register|sign up/i })).toBeVisible()
  })

  test('should successfully register a new user', async ({ page, authHelper, assertHelper }) => {
    await AuthHelper.skipUnlessCaptchaAutoPasses(page)
    await submitSignUp(page, AuthHelper.generateTestUser())

    await page.waitForURL(/\/dashboard/)
    await assertHelper.assertOnDashboard()
    expect(await authHelper.isAuthenticated()).toBe(true)
  })

  test('should validate required fields', async ({ page }) => {
    // Try to submit empty form
    await page.getByRole('button', { name: /create account|register|sign up/i }).click()

    // Should show validation errors (multiple errors appear - check for at least one)
    await expect(page.getByText(/required|cannot be empty/i).first()).toBeVisible()
  })

  test('should validate email format', async ({ page }) => {
    await page.getByLabel('Email').fill('invalid-email')
    await page.getByLabel('Password', { exact: true }).click() // Blur email field

    // Should show email validation error
    await expect(page.getByText(/valid email|invalid email/i)).toBeVisible()
  })

  test('should validate password strength', async ({ page }) => {
    const testUser = AuthHelper.generateTestUser()

    await page.getByLabel('Email').fill(testUser.email)
    await page.getByLabel('Password', { exact: true }).fill('weak')
    await page.getByLabel('Confirm password').click() // Blur password field

    // Should show password strength error
    await expect(page.getByText(/password.*at least|password.*minimum|password.*strong/i)).toBeVisible()
  })

  test('should validate password confirmation match', async ({ page }) => {
    const testUser = AuthHelper.generateTestUser()

    await page.getByLabel('Password', { exact: true }).fill(testUser.password)
    await page.getByLabel('Confirm password').fill('DifferentPassword123')
    await page.getByLabel('Organization name').click() // Blur confirm password field

    // Should show password mismatch error
    await expect(page.getByText(/password.*match|password.*same/i)).toBeVisible()
  })

  test('should handle duplicate email', async ({ page, apiHelper }) => {
    await AuthHelper.skipUnlessCaptchaAutoPasses(page)
    // First, create a user via API
    const existingUser = AuthHelper.generateTestUser('existing')
    await apiHelper.register(existingUser)

    await submitSignUp(page, {
      firstName: 'New',
      lastName: 'User',
      email: existingUser.email,
      password: 'NewPassword@123',
      organizationName: `New Org ${Date.now()}`,
    })

    // The inline alert and the toast both carry the message.
    await expect(page.getByRole('alert').filter({ hasText: /email.*already.*exist|email.*taken/i })).toBeVisible()
    await expect(page).toHaveURL(/\/auth\/register/)
  })

  test('should handle special characters in password [BUG FIX TEST]', async ({ page, assertHelper }) => {
    await AuthHelper.skipUnlessCaptchaAutoPasses(page)
    // A password full of characters that need escaping in JSON, a form body
    // or a shell must arrive intact.
    await submitSignUp(page, { ...AuthHelper.generateTestUser(), password: 'T3st!@#$%^&*()_+-=[]{}|;:,.<>?' })

    await page.waitForURL(/\/dashboard/)
    await assertHelper.assertOnDashboard()
  })

  test('should allow user-controlled organization name', async ({ page }) => {
    const customOrgName = 'My Custom Organization 2025'

    await page.getByLabel('Organization name').fill(customOrgName)

    // Organization name field should accept the value
    await expect(page.getByLabel('Organization name')).toHaveValue(customOrgName)
  })

  test('should have link to login page', async ({ page }) => {
    const loginLink = page.getByRole('link', { name: /sign in|login|already have an account/i })
    await expect(loginLink).toBeVisible()

    await loginLink.click()
    await expect(page).toHaveURL(/\/auth\/login/)
  })

  test('should show/hide password toggle', async ({ page }) => {
    const passwordInput = page.getByLabel('Password', { exact: true })

    // Password field should be type=password initially
    await expect(passwordInput).toHaveAttribute('type', 'password')

    // Click show password toggle if it exists
    const toggleButton = page.getByRole('button', { name: /show|hide password/i })
    if (await toggleButton.isVisible()) {
      await toggleButton.click()
      await expect(passwordInput).toHaveAttribute('type', 'text')

      // Click again to hide
      await toggleButton.click()
      await expect(passwordInput).toHaveAttribute('type', 'password')
    }
  })

  test('should handle network errors gracefully', async ({ page }) => {
    await AuthHelper.skipUnlessCaptchaAutoPasses(page)

    // Fail the registration request itself; the page is already loaded.
    let attempted = false
    await page.route('**/auth/register', (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      attempted = true
      return route.abort('failed')
    })

    await submitSignUp(page, AuthHelper.generateTestUser())

    await expect(page.getByRole('alert').filter({ hasText: /failed|error|try again|check your information/i })).toBeVisible()
    expect(attempted).toBe(true)
    await expect(page).toHaveURL(/\/auth\/register/)
  })
})
