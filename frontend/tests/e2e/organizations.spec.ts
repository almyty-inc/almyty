import { test, expect } from './setup/test-hooks'

test.describe('Organizations - Settings', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/settings')
    await page.waitForTimeout(2000)
  })

  test('should display organization details', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /organization/i })).toBeVisible()
    await expect(page.getByText(/Organization Name/i)).toBeVisible()
  })

  test('should show organization name and status', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/Organization Name/i)).toBeVisible()
    await expect(page.getByText(/Status/i)).toBeVisible()
    await expect(page.getByText(/Active/i)).toBeVisible()
  })

  test('should edit organization description', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /edit organization/i }).click()
    await page.waitForTimeout(500)

    // Fill in description
    const descInput = page.getByPlaceholder(/description/i).or(page.getByLabel(/description/i))
    await descInput.fill('E2E test description')

    await page.getByRole('button', { name: /save/i }).click()
    await page.waitForTimeout(1000)

    // Should show success toast
    await expect(page.getByText(/updated/i)).toBeVisible({ timeout: 5000 })
  })

  test('should display organization members', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /members/i }).click()
    await page.waitForTimeout(1000)

    // Should show at least one member (the owner)
    await expect(page.getByText(/owner/i)).toBeVisible()
  })

  test('should show invite member dialog', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /members/i }).click()
    await page.waitForTimeout(1000)

    await page.getByRole('button', { name: /invite/i }).click()
    await page.waitForTimeout(500)

    // Should show invite dialog with email field
    await expect(page.getByPlaceholder(/email/i).or(page.getByLabel(/email/i))).toBeVisible()
  })

  test('should show profile tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /profile/i }).click()
    await page.waitForTimeout(1000)

    await expect(page.getByText(/First Name/i)).toBeVisible()
    await expect(page.getByText(/Email Address/i)).toBeVisible()
  })

  test('should show security tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('tab', { name: /security/i }).click()
    await page.waitForTimeout(1000)

    await expect(page.getByText(/Change Password/i)).toBeVisible()
    await expect(page.getByText(/Active Sessions/i)).toBeVisible()
  })
})
