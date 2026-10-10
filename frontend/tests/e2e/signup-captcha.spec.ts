import { test, expect } from '@playwright/test'
import { AuthHelper } from './helpers/auth.helper'

/**
 * Sign-up with the captcha on, under the policy the page is served with.
 *
 * Staging and production refused every sign-up: the bundle had a Turnstile
 * site key, the API demanded a token, and the CSP blocked the Turnstile script
 * and iframe, so the widget never appeared. The core journey could not see
 * it: CI builds without a site key (the widget renders nothing) and runs the
 * vite dev server, which sends no CSP at all.
 *
 * Runs only against a stack built with a captcha key; skips otherwise. With
 * Cloudflare's always-pass test keys:
 *   build:  ALMYTY_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx vite build
 *   API:    TURNSTILE_SECRET=1x0000000000000000000000000000000AA
 *   serve:  the build under the nginx CSP, see vite.csp-preview.config.ts
 *   E2E_BASE_URL=... npx playwright test --config=playwright.local.config.ts signup-captcha
 * Needs to reach challenges.cloudflare.com.
 */
test('sign-up renders the captcha and completes', async ({ page }) => {
  const violations: string[] = []
  page.on('console', (msg) => {
    if (/Content Security Policy|Refused to (load|frame|connect)/i.test(msg.text())) violations.push(msg.text())
  })

  const response = await page.goto('/auth/register')
  test.skip(!(await page.getByTestId('captcha-widget').count()), 'this build has no captcha site key')

  const csp = response?.headers()['content-security-policy']
  if (csp) {
    expect(csp).toContain('https://challenges.cloudflare.com')
  }

  // The provider's iframe is what the CSP blocked: it must load and settle.
  expect(await AuthHelper.waitForCaptcha(page)).toBe(true)

  const user = AuthHelper.generateTestUser('captcha')
  await page.locator('#firstName').fill(user.firstName)
  await page.locator('#lastName').fill(user.lastName)
  await page.locator('#email').fill(user.email)
  await page.locator('#organizationName').fill(user.organizationName)
  await page.locator('#password').fill(user.password)
  await page.locator('#confirmPassword').fill(user.password)
  await page.locator('#terms').click()
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.waitForURL(/\/dashboard/)

  expect(violations).toEqual([])
})
