/**
 * App-wide navigation on staging as the QA user: the command palette, the
 * shortcuts page, and the old `?new=1` links that now open create pages.
 * (Replaces tests/e2e/staging-smoke.spec.ts, which could not get past
 * sign-up on staging.)
 */
import { test, expect } from './support/fixtures'

test.describe('Navigation', () => {
  test('Command palette jumps to APIs', async ({ page }) => {
    await page.goto('/dashboard')
    await page.locator('main#main-content').waitFor()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByPlaceholder(/jump to|run an action/i)
    await expect(palette).toBeVisible()
    await palette.fill('openapi')
    await page.getByRole('option', { name: /APIs/ }).first().click()
    await expect(page).toHaveURL(/\/apis/)
  })

  test('? opens the keyboard shortcuts page', async ({ page }) => {
    await page.goto('/dashboard')
    await page.locator('main#main-content').waitFor()
    await page.keyboard.press('Shift+Slash')
    await expect(page).toHaveURL(/\/shortcuts$/)
    await expect(page.getByRole('heading', { name: /keyboard shortcuts/i })).toBeVisible()
  })

  const deepLinks = [
    { path: '/apis?new=1', lands: /\/apis\/new$/, heading: 'Connect an API' },
    { path: '/tools?new=1', lands: /\/tools\/new$/, heading: 'Create tool' },
    { path: '/gateways?new=1', lands: /\/gateways\/new$/, heading: 'Create gateway' },
    { path: '/credentials?new=1', lands: /\/credentials\/new$/, heading: 'Add credential' },
    { path: '/organizations?new=1', lands: /\/organizations\/new$/, heading: 'Create organization' },
  ]
  for (const link of deepLinks) {
    test(`${link.path} opens ${link.heading} as a page`, async ({ page }) => {
      await page.goto(link.path)
      await expect(page).toHaveURL(link.lands)
      await expect(page.getByRole('heading', { name: link.heading, level: 1 })).toBeVisible()
      await expect(page.getByRole('dialog')).toHaveCount(0)
    })
  }
})
