/**
 * Staging gate setup: sign the QA user in once, point the session at the
 * QA organization, and sweep yesterday's leftovers.
 *
 * Login is throttled (10 per 15 minutes per account), so a saved session is
 * reused instead of signing in again, but only one that is sure to carry
 * the whole run: it lasts the run (scripts/gate-session.js), it answers
 * /auth/profile, and the app opened with it lands signed in. Anything less
 * signs in afresh. A session that answered /auth/profile at setup and ended
 * mid-run used to send every later test to the sign-in page.
 * The password is typed into the real login page and never logged.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { chromium, request, expect, type FullConfig, type Page } from '@playwright/test'
import { APP_URL, API_URL, QA_ORG_FILE, QA_ORG_NAME, QA_STATE_FILE, qaCredentials } from './env'
import { sweep } from './sweep'
import { installCli } from './cli'
import { savedSessionLasts } from '../../../../scripts/gate-session.js'

async function savedSessionWorks(): Promise<boolean> {
  if (!existsSync(QA_STATE_FILE)) return false
  let state: unknown
  try {
    state = JSON.parse(readFileSync(QA_STATE_FILE, 'utf8'))
  } catch {
    return false
  }
  const lasts = savedSessionLasts(state, { apiUrl: API_URL })
  if (!lasts.reuse) {
    console.log(`[gate] signing in afresh: ${lasts.reason}`)
    return false
  }
  const ctx = await request.newContext({ baseURL: API_URL, storageState: QA_STATE_FILE })
  try {
    return (await ctx.get('/auth/profile')).ok()
  } finally {
    await ctx.dispose()
  }
}

/** The organization switcher: on screen only when the app is signed in. */
function orgSwitcher(page: Page) {
  return page.getByRole('button', { name: /Switch organization, current:/ })
}

/** Open the app with the saved session: true only if it lands signed in, not on the sign-in page. */
async function landsSignedIn(page: Page): Promise<boolean> {
  await page.goto('/dashboard')
  const signIn = page.locator('#email')
  try {
    await expect(orgSwitcher(page).or(signIn)).toBeVisible({ timeout: 30_000 })
  } catch {
    return false
  }
  return !(await signIn.isVisible()) && !/\/auth\//.test(new URL(page.url()).pathname)
}

async function signInAfresh(page: Page): Promise<void> {
  const { email, password } = qaCredentials()
  await page.goto('/auth/login')
  await page.locator('#email').fill(email)
  await page.locator('#password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard|\/onboarding|\/guide/, { timeout: 60_000 })
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  mkdirSync(dirname(QA_STATE_FILE), { recursive: true })
  const reuse = await savedSessionWorks()

  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: APP_URL, ...(reuse ? { storageState: QA_STATE_FILE } : {}) })
  const page = await context.newPage()
  try {
    if (!reuse) {
      await signInAfresh(page)
    } else if (!(await landsSignedIn(page))) {
      console.log('[gate] signing in afresh: the app did not open signed in with the saved session')
      await context.clearCookies()
      await signInAfresh(page)
    }

    // Work in the QA organization: the one whose models are connected.
    const switcher = orgSwitcher(page)
    await expect(switcher).toBeVisible({ timeout: 30_000 })
    const label = (await switcher.getAttribute('aria-label')) || (await switcher.innerText())
    if (!label.includes(`current: ${QA_ORG_NAME}`)) {
      await switcher.click()
      await page.getByRole('menuitem', { name: new RegExp(`${QA_ORG_NAME}$`) }).click()
      await expect(page.getByRole('button', { name: `Switch organization, current: ${QA_ORG_NAME}` })).toBeVisible({ timeout: 15_000 })
    }
    await context.storageState({ path: QA_STATE_FILE })

    const profile = await page.request.get(`${API_URL}/auth/profile`)
    const body = await profile.json()
    const org = (body.data?.organizations || []).find((o: any) => o.name === QA_ORG_NAME)
    if (!org) throw new Error(`The QA user is not in an organization named "${QA_ORG_NAME}"`)
    writeFileSync(QA_ORG_FILE, JSON.stringify({ id: org.id, name: org.name }))
  } finally {
    await browser.close()
  }
  const hours = Number(process.env.GATE_SWEEP_MAX_AGE_HOURS ?? 24)
  await sweep(hours * 3600_000)

  // The published CLI, installed the documented way, for the tests that run it.
  installCli()
}