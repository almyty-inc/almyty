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
    await expect(page.getByRole('button', { name: /add secret/i })).toBeVisible()
  })

  test('should switch to access keys tab', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /access keys/i }).click()
    await page.waitForTimeout(1000)
    await expect(page.getByText(/search access keys/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /generate key/i })).toBeVisible()
  })

  test('should navigate to access keys via URL', async ({ authenticatedPage: page }) => {
    await page.goto('/credentials/access-keys')
    await page.waitForTimeout(2000)
    await expect(page.getByText(/search access keys/i)).toBeVisible()
  })

  test('should open add secret dialog', async ({ authenticatedPage: page }) => {
    await page.getByRole('button', { name: /add secret/i }).click()
    await page.waitForTimeout(500)
    await expect(page.getByText(/store a credential/i)).toBeVisible()
  })
})
