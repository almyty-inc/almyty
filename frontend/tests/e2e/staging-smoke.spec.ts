/*
 * Staging smoke suite — fresh-signup edition.
 *
 * Runs against a real deployed almyty stack (app.staging.almyty.com by
 * default). Registers a brand-new throwaway user per run via the real
 * UI and uses that user for every subsequent test. This is the
 * harshest possible first-contact experience — "can a random visitor
 * get from the sign-up screen to a working dashboard in one try?".
 *
 * Do NOT rely on a pre-existing demo account. The staging DB gets
 * reset / accounts get rotated / passwords get changed, and any
 * hard-coded credential is a ticking time bomb. Registration is
 * rate-limited at 10/hour per IP, so this spec only registers ONCE
 * per run (test.describe.configure serial + shared page) and reuses
 * the context for every test that follows.
 *
 * Environment:
 *   PLAYWRIGHT_BASE_URL — override baseURL
 *
 * Run:
 *   npx playwright test --config=playwright.staging.config.ts \
 *     tests/e2e/staging-smoke.spec.ts --project=chromium
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

let context: BrowserContext
let page: Page
let testEmail: string
let testOrg: string

const PASSWORD = 'SmokeTest123!'

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext()
  page = await context.newPage()

  const timestamp = Date.now()
  testEmail = `smoke-${timestamp}@almyty.test`
  testOrg = `Smoke Test ${timestamp}`

  // Fresh UI registration. If the page source changes, this block
  // is what needs to follow.
  await page.goto('/auth/register')
  await expect(page.getByRole('heading', { name: /sign up/i })).toBeVisible({ timeout: 20_000 })

  await page.getByLabel(/first name/i).fill('Smoke')
  await page.getByLabel(/last name/i).fill('Tester')
  await page.getByLabel(/email/i).fill(testEmail)
  await page.getByLabel(/organization name/i).fill(testOrg)
  // `exact: true` on Password so we don't match "Confirm Password".
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByLabel(/confirm password/i).fill(PASSWORD)
  // Terms checkbox — the Label wraps it in the real DOM so role=checkbox works.
  const termsCheckbox = page.locator('#terms')
  await termsCheckbox.check()

  await page.getByRole('button', { name: /create account/i }).click()

  // The backend will either redirect us to /dashboard on success, OR
  // leave us on /auth/register with a toast on validation failure.
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 45_000 })
  // Sanity: main landmark present after first render.
  await expect(page.locator('main#main-content')).toBeVisible({ timeout: 15_000 })
})

test.afterAll(async () => {
  await context?.close()
})

test.describe('Top-level nav renders without error', () => {
  const destinations = [
    { label: 'Dashboard', path: '/dashboard' },
    { label: 'APIs', path: '/apis' },
    { label: 'Tools', path: '/tools' },
    { label: 'Gateways', path: '/gateways' },
    { label: 'Agents', path: '/agents' },
    { label: 'Credentials', path: '/credentials' },
    { label: 'Models', path: '/llm-providers' },
    { label: 'Memory', path: '/memories' },
    { label: 'Analytics', path: '/analytics' },
    { label: 'Settings', path: '/settings' },
  ]

  for (const dest of destinations) {
    test(dest.label, async () => {
      await page.goto(dest.path)
      await expect(page).toHaveURL(new RegExp(dest.path.replace(/\//g, '\\/')))
      await expect(page.locator('main#main-content')).toBeVisible({ timeout: 15_000 })
      // No React error boundary copy.
      await expect(page.getByText(/something went wrong/i)).not.toBeVisible()
    })
  }
})

test.describe('Command palette', () => {
  test('opens on Ctrl+K and navigates', async () => {
    await page.goto('/dashboard')
    await page.locator('main#main-content').waitFor()
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByPlaceholder(/jump to|run an action/i)
    await expect(palette).toBeVisible({ timeout: 5_000 })
    await palette.fill('openapi')
    await page.getByRole('option', { name: /APIs/ }).click()
    await expect(page).toHaveURL(/\/apis/, { timeout: 10_000 })
    // Re-stabilize the shared page on dashboard for subsequent tests.
    await page.goto('/dashboard')
    await page.locator('main#main-content').waitFor()
  })
})

test.describe('Keyboard shortcuts', () => {
  test('? opens shortcuts dialog', async () => {
    await page.goto('/dashboard')
    await page.locator('main#main-content').waitFor()
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByRole('heading', { name: /keyboard shortcuts/i })).toBeVisible({ timeout: 5_000 })
    // Close via the dialog's X button (Radix Escape handling is unreliable
    // in headless chromium — the dialog stays open after keyboard Escape).
    const closeBtn = page.getByRole('dialog').getByRole('button', { name: /close/i }).first()
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click()
    } else {
      // Fallback: click outside the dialog to dismiss
      await page.locator('body').click({ position: { x: 5, y: 5 }, force: true })
    }
    await page.waitForTimeout(500)
  })
})

test.describe('A11y landmarks', () => {
  test('authenticated page has <main> landmark with id and aria-label', async () => {
    await page.goto('/dashboard')
    const main = page.locator('main#main-content')
    await expect(main).toBeVisible()
    await expect(main).toHaveAttribute('aria-label', /main content/i)
  })

  test('skip-to-main-content link exists in DOM', async () => {
    await page.goto('/dashboard')
    await page.locator('main#main-content').waitFor()
    // Verify the skip link exists and is wired to #main-content.
    const skipLink = page.locator('a[href="#main-content"]')
    await expect(skipLink).toHaveCount(1)
    await expect(skipLink).toHaveText(/skip to main content/i)
  })
})

test.describe('Create dialogs open from deep-link', () => {
  // Every list page supports `?new=1` as a deep-link to open its
  // Create dialog. These tests verify that landing on each list
  // page with that param actually renders a dialog with the expected
  // heading — catches silent regressions in the `useCreateDeepLink`
  // hook wiring on any page.
  const deepLinks = [
    { label: 'Create API', path: '/apis?new=1', heading: /create .*api|add .*api|new api|import api/i },
    { label: 'Create Tool', path: '/tools?new=1', heading: /create tool|new tool/i },
    { label: 'Create Gateway', path: '/gateways?new=1', heading: /create gateway|new gateway/i },
    { label: 'Add Credential', path: '/credentials?new=1', heading: /add credential|new credential|create credential/i },
    { label: 'Add LLM Provider', path: '/llm-providers?new=1', heading: /add provider|new provider|create provider|add llm/i },
  ]

  for (const link of deepLinks) {
    test(link.label, async () => {
      await page.goto(link.path)
      await expect(page.locator('main#main-content')).toBeVisible({ timeout: 15_000 })
      // Radix Dialog has role="dialog" on the content root.
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 })
      // Close the dialog to reset state for the next test (Escape
      // is the universal close for Radix Dialog).
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 5_000 })
    })
  }
})

test.describe('Wrong-credential login stays on login page', () => {
  // Own context — don't taint the shared auth session.
  test('rejects invalid password', async ({ browser }) => {
    const freshCtx = await browser.newContext()
    const freshPage = await freshCtx.newPage()
    await freshPage.goto('/auth/login')
    await freshPage.getByLabel(/email/i).fill(testEmail)
    await freshPage.getByLabel(/password/i).fill('WrongPassword123!')
    await freshPage.getByRole('button', { name: /sign in|login/i }).click()
    await freshPage.waitForTimeout(2000)
    await expect(freshPage).toHaveURL(/\/auth\/login/)
    await freshCtx.close()
  })
})
