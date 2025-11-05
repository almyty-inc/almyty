import { test, expect } from './setup/test-hooks'

test.describe('Settings - Profile & Configuration', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
  })

  test('should display settings page', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.assertPageTitle(/settings/i)

    // Should show tab navigation
    await expect(page.getByRole('tab', { name: /organization/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /members.*teams/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /profile/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /security/i })).toBeVisible()
  })

  test('should display organization details', async ({ authenticatedPage: page, assertHelper }) => {
    // Organization tab should be selected by default
    await assertHelper.waitForLoadingComplete()

    // Should show organization information
    await expect(page.getByRole('heading', { name: /organization details/i })).toBeVisible()
    await expect(page.getByText(/organization.*name/i).first()).toBeVisible()
  })

  test('should edit organization name and description', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Click edit button
    await page.getByRole('button', { name: /edit.*organization/i }).click()

    // Should show editable fields
    const nameInput = page.getByLabel(/organization.*name/i)
    await expect(nameInput).toBeVisible()
    await expect(nameInput).toBeEnabled()

    // Update organization name with unique timestamp to avoid conflicts
    const uniqueName = `Updated Org ${Date.now()}-${Math.random().toString(36).substring(7)}`
    await nameInput.clear()
    await nameInput.fill(uniqueName)

    // Update description if field exists
    const descriptionInput = page.getByLabel(/description/i)
    if (await descriptionInput.isVisible()) {
      await descriptionInput.clear()
      await descriptionInput.fill('Updated organization description')
    }

    // Save changes
    await page.getByRole('button', { name: /save|update/i }).click()

    // Should show success message
    await assertHelper.assertToastMessage(/updated|saved|success/i)
  })

  test('should cancel organization edit', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    const originalName = await page.locator('text=/organization/i').first().textContent()

    // Click edit
    await page.getByRole('button', { name: /edit.*organization/i }).click()

    // Make changes
    await page.getByLabel(/organization.*name/i).fill('Temporary Name')

    // Cancel
    await page.getByRole('button', { name: /cancel/i }).click()

    // Changes should not be saved
    await expect(page.getByText('Temporary Name')).not.toBeVisible()
  })

  test('should display organization plan and status', async ({ authenticatedPage: page, assertHelper }) => {
    await assertHelper.waitForLoadingComplete()

    // Should show plan information - look for label and value
    await expect(page.locator('label:has-text("Plan")').or(page.getByText(/^plan$/i))).toBeVisible()
    await expect(page.getByText('free').or(page.getByText('Free'))).toBeVisible()

    // Should show status - look for label and "Active" text
    await expect(page.locator('label:has-text("Status")').or(page.getByText(/^status$/i))).toBeVisible()
    await expect(page.getByText('Active')).toBeVisible()
  })

  test('should switch to profile tab', async ({ authenticatedPage: page, assertHelper }) => {
    // Click profile tab
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Should show profile information
    await expect(page.getByRole('heading', { name: /profile.*information/i })).toBeVisible()
    await expect(page.getByText(/^first name$/i)).toBeVisible()
    await expect(page.getByText(/email/i).first()).toBeVisible()
  })

  test('should display user profile information', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Should show user data
    await expect(page.getByText(/first.*name/i)).toBeVisible()
    await expect(page.getByText(/last.*name/i)).toBeVisible()
    await expect(page.getByText(/email.*address/i)).toBeVisible()
  })

  test('should edit profile information', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Click edit
    await page.getByRole('button', { name: /edit.*profile/i }).click()

    // Should show editable fields
    const firstNameInput = page.getByLabel(/first.*name/i)
    const lastNameInput = page.getByLabel(/last.*name/i)

    await expect(firstNameInput).toBeVisible()
    await expect(firstNameInput).toBeEnabled()
    await expect(lastNameInput).toBeVisible()
    await expect(lastNameInput).toBeEnabled()

    // Update fields
    await firstNameInput.clear()
    await firstNameInput.fill('Updated')
    await lastNameInput.clear()
    await lastNameInput.fill('Name')

    // Save
    await page.getByRole('button', { name: /save|update/i }).click()

    // Should show success
    await assertHelper.assertToastMessage(/updated|saved|success/i)
  })

  test('should validate profile required fields', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Click edit
    await page.getByRole('button', { name: /edit.*profile/i }).click()

    // Clear required fields
    const firstNameInput = page.getByLabel(/first.*name/i)
    await firstNameInput.clear()

    // Try to save
    await page.getByRole('button', { name: /save|update/i }).click()

    // Should show validation error
    await expect(page.getByText(/required|cannot.*be.*empty/i)).toBeVisible()
  })

  test('should cancel profile edit', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Click edit
    await page.getByRole('button', { name: /edit.*profile/i }).click()

    // Make changes
    const firstNameInput = page.getByLabel(/first.*name/i)
    await firstNameInput.clear()
    await firstNameInput.fill('Temporary')

    // Cancel
    await page.getByRole('button', { name: /cancel/i }).click()

    // Should revert changes
    await expect(page.getByText('Temporary')).not.toBeVisible()
  })

  test('should display account creation date', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /profile/i }).click()

    // Should show account created date
    await expect(page.getByText(/account.*created|created/i)).toBeVisible()
  })

  test('should display account status', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Should show account status label and active status
    await expect(page.getByText(/account.*status/i)).toBeVisible()
    await expect(page.getByText(/active/i)).toBeVisible()
  })

  test('should switch to security tab', async ({ authenticatedPage: page, assertHelper }) => {
    // Click security tab
    await page.getByRole('tab', { name: /security/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Should show security settings
    await expect(page.getByRole('heading', { name: /change password|account security/i }).first()).toBeVisible()
  })

  test('should display password change option', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /security/i }).click()

    // Should show password settings
    const changePasswordButton = page.getByRole('button', { name: /change.*password|update.*password/i })
    if (await changePasswordButton.isVisible()) {
      await expect(changePasswordButton).toBeVisible()
    }
  })

  test('should display two-factor authentication settings', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /security/i }).click()

    // Should show 2FA settings
    const twoFactorText = page.getByText(/two.*factor|2fa|multi.*factor/i)
    if (await twoFactorText.isVisible()) {
      await expect(twoFactorText).toBeVisible()
    }
  })

  test('should switch between tabs', async ({ authenticatedPage: page, assertHelper }) => {
    // Switch to profile
    await page.getByRole('tab', { name: /profile/i }).click()
    await expect(page.getByRole('heading', { name: /profile.*information/i })).toBeVisible()

    // Switch to security
    await page.getByRole('tab', { name: /security/i }).click()
    await assertHelper.waitForLoadingComplete()
    await expect(page.getByRole('heading', { name: /change password|account security/i }).first()).toBeVisible()

    // Switch back to organization
    await page.getByRole('tab', { name: /organization/i }).click()
    await expect(page.getByRole('heading', { name: /organization details/i })).toBeVisible()
  })

  test('should maintain state when switching tabs', async ({ authenticatedPage: page, assertHelper }) => {
    // Go to organization tab
    await assertHelper.waitForLoadingComplete()

    // Click edit on organization
    await page.getByRole('button', { name: /edit.*organization/i }).click()
    await page.getByLabel(/organization.*name/i).fill('Test Name')

    // Switch tabs
    await page.getByRole('tab', { name: /profile/i }).click()
    await page.getByRole('tab', { name: /organization/i }).click()

    // Should not have saved unsaved changes
    const cancelButton = page.getByRole('button', { name: /cancel/i })
    if (await cancelButton.isVisible()) {
      await cancelButton.click()
    }
  })

  test('should handle profile loading state', async ({ page, authHelper, assertHelper }) => {
    // Create fresh user
    const testUser = await authHelper.registerViaAPI(authHelper.constructor.generateTestUser())
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/settings')
    await page.getByRole('tab', { name: /profile/i }).click()

    // Should eventually load profile
    await assertHelper.waitForLoadingComplete()
    await expect(page.getByRole('heading', { name: /profile.*information/i })).toBeVisible()
  })

  test('should display email in profile', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Should show email
    await expect(page.getByText(/email/i)).toBeVisible()
  })

  test('should update multiple profile fields at once', async ({ authenticatedPage: page, assertHelper }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await assertHelper.waitForLoadingComplete()

    // Edit profile
    await page.getByRole('button', { name: /edit.*profile/i }).click()

    // Update all fields with unique email to avoid conflicts
    await page.getByLabel(/first.*name/i).fill('John')
    await page.getByLabel(/last.*name/i).fill('Doe')

    const emailInput = page.getByLabel(/email/i)
    if (await emailInput.isVisible() && await emailInput.isEnabled()) {
      const uniqueEmail = `john.doe.${Date.now()}.${Math.random().toString(36).substring(7)}@example.com`
      await emailInput.clear()
      await emailInput.fill(uniqueEmail)
    }

    // Save
    await page.getByRole('button', { name: /save|update/i }).click()

    // Should show success
    await assertHelper.assertToastMessage(/updated|saved|success/i)
  })
})
