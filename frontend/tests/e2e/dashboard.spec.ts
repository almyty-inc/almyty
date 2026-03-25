import { test, expect } from './setup/test-hooks'
import { AuthHelper } from './helpers/auth.helper'

test.describe('Dashboard', () => {
  test('should display dashboard for new user', async ({ page, authHelper }) => {
    const testUser = AuthHelper.generateTestUser()
    await authHelper.registerViaAPI(testUser)
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/dashboard')
    await page.waitForTimeout(3000)

    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
    // New user sees Getting Started checklist
    await expect(page.getByText(/get started|connect|import/i).first()).toBeVisible()
  })

  test('should display pipeline stats', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')
    await page.waitForTimeout(5000)

    // Pipeline shows: APIs Connected, Tools Generated, Gateways Serving, Agents Running
    await expect(page.getByText(/APIs Connected/i)).toBeVisible()
    await expect(page.getByText(/Tools Generated/i)).toBeVisible()
    await expect(page.getByText(/Gateways Serving/i)).toBeVisible()
    await expect(page.getByText(/Agents Running/i)).toBeVisible()
  })

  test('should show recent activity', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')
    await page.waitForTimeout(5000)

    await expect(page.getByText(/Recent Activity/i)).toBeVisible()
  })

  test('should show View Analytics button', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')
    await page.waitForTimeout(3000)

    await expect(page.getByRole('button', { name: /View Analytics/i })).toBeVisible()
  })

  test('should navigate to APIs from pipeline', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')
    await page.waitForTimeout(5000)

    await page.getByText(/APIs Connected/i).click()
    await expect(page).toHaveURL(/\/apis/)
  })

  test('should navigate via sidebar', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')

    const pages = [
      { name: /^APIs$/i, url: '/apis' },
      { name: /^Tools$/i, url: '/tools' },
      { name: /^Gateways$/i, url: '/gateways' },
      { name: /^Agents$/i, url: '/agents' },
      { name: /^Analytics$/i, url: '/analytics' },
      { name: /^Settings$/i, url: '/settings' },
    ]

    for (const { name, url } of pages) {
      const link = page.getByRole('link', { name })
      await expect(link).toBeVisible()
      await link.click()
      await expect(page).toHaveURL(new RegExp(url))
      await page.goto('/dashboard')
    }
  })

  test('should show user info in header', async ({ page, authHelper }) => {
    const testUser = AuthHelper.generateTestUser()
    await authHelper.registerViaAPI(testUser)
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/dashboard')
    await page.waitForTimeout(2000)

    const hasEmail = await page.getByText(testUser.email, { exact: false }).first().isVisible().catch(() => false)
    expect(hasEmail).toBe(true)
  })

  test('should show organization name', async ({ page, authHelper }) => {
    const testUser = AuthHelper.generateTestUser()
    await authHelper.registerViaAPI(testUser)
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/dashboard')
    await page.waitForTimeout(3000)

    await expect(page.getByText(testUser.organizationName).first()).toBeVisible()
  })

  test('should handle loading states', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
  })
})
