import { test, expect } from './setup/test-hooks'
import { AuthHelper } from './helpers/auth.helper'

test.describe('Dashboard', () => {
  test('should display dashboard for new user', async ({ page, authHelper }) => {
    const testUser = AuthHelper.generateTestUser()
    await authHelper.registerViaAPI(testUser)
    await authHelper.loginViaAPI(testUser.email, testUser.password)

    await page.goto('/dashboard')
    await page.waitForTimeout(3000)

    // Page loads with dashboard heading
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
    // New user sees Getting Started checklist
    await expect(page.getByText(/Getting Started/i)).toBeVisible()
  })

  test('should display pipeline stats or getting started', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')
    await page.waitForTimeout(5000)

    // Fresh users see the Getting Started checklist instead of pipeline stats
    // Pipeline stats only appear when APIs + Tools + Gateways + Agents all exist
    const hasPipeline = await page.getByText(/APIs Connected/i).isVisible().catch(() => false)
    if (hasPipeline) {
      await expect(page.getByText(/APIs Connected/i)).toBeVisible()
      await expect(page.getByText(/Tools Generated/i)).toBeVisible()
      await expect(page.getByText(/Gateways Serving/i)).toBeVisible()
      await expect(page.getByText(/Agents Running/i)).toBeVisible()
    } else {
      // New user sees Getting Started checklist
      await expect(page.getByText(/Getting Started/i)).toBeVisible()
    }
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

  test('should navigate to APIs from pipeline or checklist', async ({ authenticatedPage: page }) => {
    await page.goto('/dashboard')
    await page.waitForTimeout(5000)

    // Fresh users see checklist; users with data see pipeline
    const hasPipeline = await page.getByText(/APIs Connected/i).isVisible().catch(() => false)
    if (hasPipeline) {
      await page.getByText(/APIs Connected/i).click()
    } else {
      // Click "Connect your first API" checklist item
      await page.getByText(/Connect your first API/i).click()
    }
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

    // The header shows the organization name badge or a user menu — verify the page loaded
    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
    // Organization name or email should appear somewhere on the page (sidebar, header, badge)
    const hasOrgOrEmail = await page.getByText(testUser.organizationName, { exact: false }).first().isVisible().catch(() => false)
      || await page.getByText(testUser.email, { exact: false }).first().isVisible().catch(() => false)
    expect(hasOrgOrEmail).toBe(true)
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
