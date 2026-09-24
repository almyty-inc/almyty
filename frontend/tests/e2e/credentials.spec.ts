import { test, expect } from './setup/test-hooks'

test.describe('Credentials', () => {
  test.beforeEach(async ({ authenticatedPage: page }) => {
    await page.goto('/credentials')
    await page.waitForTimeout(2000)
  })

  test('should display credentials page with tabs', async ({ authenticatedPage: page }) => {
    await expect(page.getByRole('heading', { name: /credentials/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /secrets/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /access keys/i })).toBeVisible()
  })

  test('should show secrets tab by default', async ({ authenticatedPage: page }) => {
    await expect(page.getByText(/search secrets/i)).toBeVisible()
    await expect(page.getByRole('link', { name: /add credential/i }).first()).toBeVisible()
  })

  test('should switch to access keys tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /access keys/i }).click()
    await page.waitForTimeout(1000)
    await expect(page.getByText(/search access keys/i)).toBeVisible()
    await expect(page.getByRole('link', { name: /generate key/i }).first()).toBeVisible()
  })

  test('should navigate to access keys via URL', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials/access-keys')
    await page.waitForTimeout(2000)
    await expect(page.getByText(/search access keys/i)).toBeVisible()
  })

  test('should open the add credential page', async ({ authenticatedPage: page }) => {
    await page.getByRole('link', { name: /add credential/i }).first().click()
    await expect(page).toHaveURL(/\/credentials\/new$/)
    await expect(page.getByRole('heading', { name: /add credential/i })).toBeVisible()
    await expect(page.getByText(/store a credential/i)).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('should open the generate access key page', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials/access-keys')
    await page.getByRole('link', { name: /generate key/i }).first().click()
    await expect(page).toHaveURL(/\/credentials\/access-keys\/new$/)
    await expect(page.getByRole('heading', { name: /generate access key/i })).toBeVisible()
  })
})
