/**
 * J1: sign up, sign in. A brand-new account through the real sign-up page
 * (real Turnstile widget, staging's always-pass test site key), and the QA
 * user's own session.
 */
import { test, expect, screenshotThis } from './support/fixtures'
import { APP_URL, QA_ORG_NAME, RUN_ID } from './support/env'

test.describe('J1 sign up and sign in', () => {
  test('J1 fresh sign-up through the UI lands in the app', async ({ freshUser }) => {
    const { page, organizationName } = freshUser
    // Signed in: off the auth pages, inside the app, in the account's own organization.
    await expect(page).not.toHaveURL(/\/auth\//, { timeout: 45_000 })
    await expect(page.locator('main#main-content')).toBeVisible()
    await expect(page.getByRole('button', { name: `Switch organization, current: ${organizationName}` })).toBeVisible()
    await expect(page.getByRole('button', { name: 'User menu' })).toContainText(freshUser.email)
  })

  test('J1 a new account starts empty: no APIs, no agents, no analytics', async ({ freshUser }) => {
    const { page } = freshUser
    await expect(page).not.toHaveURL(/\/auth\//, { timeout: 45_000 })
    // Its organization is its own: nothing of the QA org shows through.
    await page.goto('/analytics')
    // Every counter of the overview is zero.
    const overview = page.getByRole('tabpanel', { name: 'Overview' }).or(page.getByRole('main'))
    await expect(overview.first()).toContainText(/Requests \(24h\)\s*0(?![\d.])/)
    await expect(overview.first()).toContainText(/Tool executions \(7d\)\s*0(?![\d.])/)
    await expect(overview.first()).toContainText(/Model calls \(24h\)\s*0(?![\d.])/)
    await page.goto('/agents')
    await expect(page.getByRole('main').getByText(/no agents/i).first()).toBeVisible()
    await page.goto('/apis')
    await expect(page.getByRole('main').getByText(/no apis/i).first()).toBeVisible()
  })

  test('J1 QA session opens in the QA organization', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('button', { name: `Switch organization, current: ${QA_ORG_NAME}` })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible()
    await expect(page.getByText(`${QA_ORG_NAME}: your APIs, tools, gateways and agents at a glance`)).toBeVisible()
  })

  test('J1 sign-in with a wrong password is refused', async ({ browser }) => {
    const context = await browser.newContext({ baseURL: APP_URL, storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    screenshotThis(page)
    await page.goto('/auth/login')
    await page.locator('#email').fill(`gate-${RUN_ID}-nobody@test.almyty.com`)
    await page.locator('#password').fill('not-the-password-1A!')
    const answer = page.waitForResponse((r) => r.url().endsWith('/auth/login') && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Sign in' }).click()
    expect((await answer).status()).toBe(401)
    await expect(page).toHaveURL(/\/auth\/login/)
    await expect(page.getByRole('alert').filter({ hasText: /don't match|invalid|incorrect/i }).first()).toBeVisible()
  })
})
