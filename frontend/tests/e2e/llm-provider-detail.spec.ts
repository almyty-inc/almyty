import { test, expect } from './setup/test-hooks'

test.describe('LLM Provider Detail', () => {
  test('should navigate from list to detail page', async ({ authenticatedPage: page }) => {
    await page.goto('/llm-providers')
    await page.waitForTimeout(3000)

    // Click on a provider row if one exists
    const row = page.getByRole('row').filter({ hasText: /anthropic|openai/i }).first()
    if (await row.isVisible().catch(() => false)) {
      await row.click()
      await page.waitForTimeout(2000)
      await expect(page).toHaveURL(/\/llm-providers\//)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    }
  })

  test('should show provider stats and tabs', async ({ authenticatedPage: page }) => {
    await page.goto('/llm-providers')
    await page.waitForTimeout(3000)

    const row = page.getByRole('row').filter({ hasText: /anthropic|openai/i }).first()
    if (await row.isVisible().catch(() => false)) {
      await row.click()
      await page.waitForTimeout(2000)

      // Should show stats
      await expect(page.getByText(/total requests/i)).toBeVisible()
      await expect(page.getByText(/success rate/i)).toBeVisible()

      // Should show tabs
      await expect(page.getByRole('tab', { name: /overview/i })).toBeVisible()
      await expect(page.getByRole('tab', { name: /configuration/i })).toBeVisible()
    }
  })
})
