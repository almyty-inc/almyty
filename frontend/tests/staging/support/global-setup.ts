/**
 * Staging gate setup: sign the QA user in once, point the session at the
 * QA organization, and sweep yesterday's leftovers.
 *
 * Login is throttled (10 per 15 minutes per account), so a saved session
 * that still answers /auth/profile is reused instead of signing in again.
 * The password is typed into the real login page and never logged.
 */
import { mkdirSync, existsSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { chromium, request, expect, type FullConfig } from '@playwright/test'
import { APP_URL, API_URL, QA_ORG_FILE, QA_ORG_NAME, QA_STATE_FILE, qaCredentials } from './env'
import { sweep } from './sweep'
import { installCli } from './cli'
async function savedSessionWorks(): Promise<boolean> {
  if (!existsSync(QA_STATE_FILE)) return false
  const ctx = await request.newContext({ baseURL: API_URL, storageState: QA_STATE_FILE })
  try {
    return (await ctx.get('/auth/profile')).ok()
  } finally {
    await ctx.dispose()
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  mkdirSync(dirname(QA_STATE_FILE), { recursive: true })
  const reuse = await savedSessionWorks()

  const browser = await chromium.launch()
  const context = await browser.newContext({ baseURL: APP_URL, ...(reuse ? { storageState: QA_STATE_FILE } : {}) })
  const page = await context.newPage()
  try {
    if (!reuse) {
      const { email, password } = qaCredentials()
      await page.goto('/auth/login')
      await page.locator('#email').fill(email)
      await page.locator('#password').fill(password)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL(/\/dashboard|\/onboarding|\/guide/, { timeout: 60_000 })
    } else {
      await page.goto('/dashboard')
    }

    // Work in the QA organization: the one whose models are connected.
    const switcher = page.getByRole('button', { name: /Switch organization, current:/ })
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