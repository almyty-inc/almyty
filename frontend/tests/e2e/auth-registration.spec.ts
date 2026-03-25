import { test, expect } from './setup/test-hooks'
import { AuthHelper } from './helpers/auth.helper'

test.describe('Authentication - Registration', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/auth/register')
  })

  test('should display registration form', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /register|sign up/i })).toBeVisible()
    await expect(page.getByLabel('First Name')).toBeVisible()
    await expect(page.getByLabel('Last Name')).toBeVisible()
    await expect(page.getByLabel(/Email/i)).toBeVisible() // Fixed: "Email address" not "Email"
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Confirm Password')).toBeVisible()
    await expect(page.getByLabel('Organization Name')).toBeVisible()
    await expect(page.getByRole('button', { name: /create account|register|sign up/i })).toBeVisible() // Fixed: button says "Create account"
  })

  test('should successfully register a new user', async ({ page, authHelper, assertHelper }) => {
    const testUser = AuthHelper.generateTestUser()

    // Fill registration form
    await page.getByLabel('First Name').fill(testUser.firstName)
    await page.getByLabel('Last Name').fill(testUser.lastName)
    await page.getByLabel(/Email/i).fill(testUser.email)
    await page.getByLabel('Password', { exact: true }).fill(testUser.password)
    await page.getByLabel('Confirm Password').fill(testUser.password)
    await page.getByLabel('Organization Name').fill(testUser.organizationName)

    // Check terms checkbox (REQUIRED!)
    await page.getByLabel(/terms.*service|agree/i).check()

    // Submit form
    await page.getByRole('button', { name: /create account|register|sign up/i }).click()

    // Should redirect to dashboard
    await assertHelper.waitForLoadingComplete()
    await assertHelper.assertOnDashboard()

    // Should be authenticated
    const isAuthenticated = await authHelper.isAuthenticated()
    expect(isAuthenticated).toBe(true)
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
    await page.getByLabel('Confirm Password').click() // Blur password field

    // Should show password strength error
    await expect(page.getByText(/password.*at least|password.*minimum|password.*strong/i)).toBeVisible()
  })

  test('should validate password confirmation match', async ({ page }) => {
    const testUser = AuthHelper.generateTestUser()

    await page.getByLabel('Password', { exact: true }).fill(testUser.password)
    await page.getByLabel('Confirm Password').fill('DifferentPassword123')
    await page.getByLabel('Organization Name').click() // Blur confirm password field

    // Should show password mismatch error
    await expect(page.getByText(/password.*match|password.*same/i)).toBeVisible()
  })

  test('should handle duplicate email', async ({ page, apiHelper }) => {
    // First, create a user via API
    const existingUser = AuthHelper.generateTestUser('existing')
    await apiHelper.register(existingUser)

    // Try to register with same email
    await page.getByLabel('First Name').fill('New')
    await page.getByLabel('Last Name').fill('User')
    await page.getByLabel(/Email/i).fill(existingUser.email)
    await page.getByLabel('Password', { exact: true }).fill('NewPassword@123')
    await page.getByLabel('Confirm Password').fill('NewPassword@123')
    await page.getByLabel('Organization Name').fill('New Org')

    // Check terms checkbox (REQUIRED!)
    await page.getByLabel(/terms.*service|agree/i).check()

    await page.getByRole('button', { name: /create account|register|sign up/i }).click()

    // Should show duplicate email error
    // Use .first() to handle multiple matching elements (toast + inline error)
    await expect(page.getByText(/email.*already.*exist|email.*taken/i).first()).toBeVisible()
  })

  test('should handle special characters in password [BUG FIX TEST]', async ({ page, assertHelper }) => {
    // Test for CLAUDE.md mentioned issue: "special character parsing issues"
    const testUser = AuthHelper.generateTestUser()
    const specialPassword = 'T3st!@#$%^&*()_+-=[]{}|;:,.<>?'

    await page.getByLabel('First Name').fill(testUser.firstName)
    await page.getByLabel('Last Name').fill(testUser.lastName)
    await page.getByLabel(/Email/i).fill(testUser.email)
    await page.getByLabel('Password', { exact: true }).fill(specialPassword)
    await page.getByLabel('Confirm Password').fill(specialPassword)
    await page.getByLabel('Organization Name').fill(testUser.organizationName)

    // Check terms checkbox (REQUIRED!)
    await page.getByLabel(/terms.*service|agree/i).check()

    await page.getByRole('button', { name: /create account|register|sign up/i }).click()

    // Should successfully register and redirect to dashboard
    await assertHelper.waitForLoadingComplete()
    await assertHelper.assertOnDashboard()
  })

  test('should allow user-controlled organization name', async ({ page }) => {
    const testUser = AuthHelper.generateTestUser()
    const customOrgName = 'My Custom Organization 2025'

    await page.getByLabel('Organization Name').fill(customOrgName)

    // Organization name field should accept the value
    await expect(page.getByLabel('Organization Name')).toHaveValue(customOrgName)
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
    const testUser = AuthHelper.generateTestUser()

    // Intercept and fail the registration request
    await page.route('**/auth/register', route => {
      route.abort('failed')
    })

    await page.getByLabel(/Email/i).fill(testUser.email)
    await page.getByLabel('Password', { exact: true }).fill(testUser.password)
    await page.getByLabel('Confirm Password').fill(testUser.password)
    await page.getByLabel('Organization Name').fill(testUser.organizationName)
    await page.getByLabel('First Name').fill(testUser.firstName)
    await page.getByLabel('Last Name').fill(testUser.lastName)

    // Check terms checkbox (REQUIRED!)
    await page.getByLabel(/terms.*service|agree/i).check()

    await page.getByRole('button', { name: /create account|register|sign up/i }).click()

    // Should show error message (either network error or generic registration failed)
    // Use .first() to handle multiple matching elements (toast + inline error)
    await expect(page.getByText(/error|failed/i).first()).toBeVisible()
  })
})
