/**
 * Fixtures for the staging gate.
 *
 * - `page` is signed in as the QA user in the QA organization (the
 *   project's storage state, saved once by the global setup).
 * - `gate` names what a test makes (`gate-<run id>-<what>`) and deletes it
 *   when the test ends, pass or fail.
 * - `qa` is the QA session for cleanup and read-backs, never for the
 *   feature under test.
 * - `freshUser` signs a brand-new account up through the real sign-up page
 *   (`gate-<run id>-<n>@test.almyty.com`, which staging confirms at once),
 *   signs it in, and deletes its organization afterwards.
 *
 * Every test ends with a full-page screenshot under gate-results/shots,
 * named after the test, which the gate report links.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import { test as base, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'
import { API_URL, APP_URL, RUN_ID, SHOTS_DIR } from './env'
import { deleteThing, qaApi, qaOrg, type Kind, type QaOrg } from './qa-api'

export interface Gate {
  runId: string
  /** `gate-<run id>-<what>`: what the sweep recognises as the gate's own. */
  name(what: string): string
  /** The same, as an identifier (tool names): `gate_<run id>_<what>`. */
  ident(what: string): string
  /** Delete this when the test ends. Deleted in reverse order. */
  track(kind: Kind, id: string): void
}

export interface FreshUser {
  page: Page
  email: string
  password: string
  organizationName: string
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
}

export function shotPath(title: string): string {
  return join(SHOTS_DIR, `${slug(title)}.png`)
}

let seq = 0

export const test = base.extend<{ gate: Gate; qa: APIRequestContext; org: QaOrg; freshUser: FreshUser; _shot: void }>({
  org: async ({}, use) => {
    await use(qaOrg())
  },

  qa: async ({ org }, use) => {
    const api = await qaApi(org.id)
    await use(api)
    await api.dispose()
  },

  gate: async ({ qa, org }, use, testInfo) => {
    const made: { kind: Kind; id: string }[] = []
    const stamp = `${RUN_ID}${testInfo.retry ? `r${testInfo.retry}` : ''}`
    await use({
      runId: RUN_ID,
      name: (what) => `gate-${stamp}-${slug(what)}`,
      ident: (what) => `gate_${stamp}_${slug(what).replace(/-/g, '_')}`,
      track: (kind, id) => {
        made.push({ kind, id })
      },
    })
    const problems: string[] = []
    for (const { kind, id } of made.reverse()) {
      try {
        await deleteThing(qa, kind, id, org.id)
      } catch (err) {
        problems.push((err as Error).message)
      }
    }
    // A failed cleanup leaves the thing for the daily sweep; say so, do not fail the test.
    if (problems.length) testInfo.annotations.push({ type: 'cleanup', description: problems.join('; ') })
  },

  freshUser: async ({ browser }, use, testInfo) => {
    const context = await browser.newContext({ baseURL: APP_URL, storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    screenshotThis(page)
    const stamp = `${RUN_ID}-${process.pid}-${++seq}`
    const email = `gate-${stamp}@test.almyty.com`
    // Not a secret: a throwaway account that lives for one test.
    const password = `Gate-${stamp}-pw!`
    const organizationName = `gate-${stamp}-org`

    await page.goto('/auth/register')
    await page.locator('#firstName').fill('Gate')
    await page.locator('#lastName').fill('Runner')
    await page.locator('#email').fill(email)
    await page.locator('#organizationName').fill(organizationName)
    await page.locator('#password').fill(password)
    await page.locator('#confirmPassword').fill(password)
    await page.locator('#terms').check()
    // Turnstile's widget fills this once it has passed. Staging's build uses
    // Cloudflare's always-pass test site key, so it passes on its own.
    await expect(
      page.locator('input[name="cf-turnstile-response"]'),
      'the sign-up captcha never passed: is the staging build on the always-pass test site key?',
    ).toHaveValue(/.+/, { timeout: 30_000 })
    await page.getByRole('button', { name: 'Create account' }).click()

    // staging confirms @test.almyty.com at once, so sign-up goes straight to sign-in.
    await expect(page, 'sign-up should go straight to sign-in for a @test.almyty.com address').toHaveURL(/\/auth\/login/, { timeout: 45_000 })
    await page.locator('#email').fill(email)
    await page.locator('#password').fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()

    await use({ page, email, password, organizationName })
    await finalShot(page, testInfo)

    // Remove the account's organization (the account itself has no self-delete).
    try {
      const profile = await page.request.get(`${API_URL}/auth/profile`)
      const orgs = (await profile.json()).data?.organizations || []
      for (const o of orgs) {
        await page.request.delete(`${API_URL}/organizations/${o.id}`, { headers: { 'X-Organization-Id': o.id } })
      }
    } catch (err) {
      testInfo.annotations.push({ type: 'cleanup', description: `fresh user org: ${(err as Error).message}` })
    }
    await context.close()
  },

  // Every test leaves one screenshot behind, named after it.
  _shot: [
    async ({ page }, use, testInfo) => {
      await use()
      await finalShot(shotPages.get(testInfo.testId) || page, testInfo)
    },
    { auto: true },
  ],
})

export { expect }

const shotPages = new Map<string, Page>()

/** Make this page the one the test's closing screenshot is taken of. */
export function screenshotThis(page: Page): void {
  shotPages.set(test.info().testId, page)
}

async function finalShot(page: Page, testInfo: TestInfo): Promise<void> {
  if (testInfo.annotations.some((a) => a.type === 'screenshot')) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  const path = shotPath(testInfo.titlePath.slice(1).join(' '))
  try {
    await page.screenshot({ path, fullPage: true })
    testInfo.annotations.push({ type: 'screenshot', description: path })
  } catch {
    // The page is already closed; Playwright's own failure screenshot remains.
  }
}

/** Wait for a JSON response the page itself makes (never stubbed). */
export async function responseOf(page: Page, url: RegExp, method = 'POST') {
  return page.waitForResponse((r) => url.test(r.url()) && r.request().method() === method, { timeout: 120_000 })
}