import { test, expect } from '@playwright/test'
import { AuthHelper } from './helpers/auth.helper'

/**
 * The chat widget's live preview on a website-widget channel, under the
 * policy the page is served with.
 *
 * The preview used to be an srcdoc iframe with an inline shim and widget.js
 * from the API host. An srcdoc document inherits the page's CSP, which
 * allows neither, so in production the preview stayed empty. The dev server
 * sends no CSP, so nothing else could see it. It is now a page on the API
 * (/gateways/:id/widget-preview) with a policy of its own.
 *
 * Run it against a production build under the nginx CSP, with the API on
 * its own origin as in production:
 *   build:  ALMYTY_API_BASE_URL=http://localhost:4100 npx vite build
 *   serve:  ALMYTY_API_BASE_URL=http://localhost:4100 ALMYTY_API_TARGET=http://localhost:4100 \
 *           npx vite preview --config vite.csp-preview.config.ts --port 3611
 *   API:    FRONTEND_URL=http://localhost:3611 (CORS, and who may frame the preview)
 *   E2E_BASE_URL=http://localhost:3611 E2E_API_URL=http://localhost:4100 \
 *   npx playwright test --config=playwright.local.config.ts widget-preview
 */
const API = (process.env.E2E_API_URL || 'http://localhost:4000').replace(/\/api\/?$/, '').replace(/\/+$/, '')

test('the widget preview renders under the CSP and follows the placement', async ({ page }) => {
  const violations: string[] = []
  // Every frame reports its own violations, the preview's included. Not eval:
  // zod probes for it once (Function('') in a try) and falls back when the
  // CSP refuses, which is the policy working, not the page breaking.
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      if (e.blockedURI === 'eval') return
      console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || 'inline'} in ${location.href}`)
    })
  })
  page.on('console', (msg) => {
    if (/Content Security Policy|CSP violation|Refused to (load|frame|connect|execute)/i.test(msg.text())) violations.push(msg.text())
  })

  // A new account with an autonomous agent and a published widget channel.
  // Registration answers with the session cookie; a stack with a real
  // captcha secret refuses the test token, and there is nothing to preview.
  const user = AuthHelper.generateTestUser('widget')
  const registered = await page.request.post(`${API}/auth/register`, {
    data: { ...user, captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' },
  })
  test.skip(
    registered.status() === 400 && /captcha|verification/i.test(await registered.text()),
    'the API checks a real captcha secret, so an account cannot be made here',
  )
  expect(registered.ok(), await registered.text()).toBe(true)

  const agent = await page.request.post(`${API}/agents`, {
    data: { name: 'Preview Agent', mode: 'autonomous', instructions: 'Be helpful.' },
  })
  expect(agent.ok(), await agent.text()).toBe(true)
  const agentId = (await agent.json()).data.id
  const channel = await page.request.post(`${API}/agents/${agentId}/channels`, { data: { type: 'widget', name: 'Site widget' } })
  expect(channel.ok(), await channel.text()).toBe(true)
  const channelId = (await channel.json()).data.id
  const published = await page.request.post(`${API}/agents/${agentId}/channels/${channelId}/publish`, { data: {} })
  expect(published.ok(), await published.text()).toBe(true)
  const gatewayId = (await published.json()).data.gatewayId

  const response = await page.goto(`/agents/${agentId}/channels/${channelId}`)
  const csp = response?.headers()['content-security-policy']

  const iframe = page.getByTitle('Chat widget live preview')
  await iframe.scrollIntoViewIfNeeded()
  const src = new URL((await iframe.getAttribute('src'))!)
  // On the API, or on the page origin when the API is proxied same-origin (dev).
  expect([API, new URL(page.url()).origin]).toContain(src.origin)
  expect(src.pathname).toBe(`/gateways/${gatewayId}/widget-preview`)
  if (csp) {
    // The page's policy admits the API it frames, and still no inline script.
    const directive = (name: string) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) || '').split(/\s+/)
    expect(directive('frame-src')).toContain(src.origin)
    expect(directive('script-src')).not.toContain("'unsafe-inline'")
  }

  // The shim ran (the panel opens by itself) and widget.js drew the agent's look.
  const preview = page.frameLocator('iframe[title="Chat widget live preview"]')
  await expect(preview.locator('.almyty-widget-panel.almyty-widget-open')).toBeVisible()
  await expect(preview.locator('.almyty-widget-header')).toHaveText('Preview Agent')
  await expect(preview.locator('.almyty-widget-root')).not.toHaveClass(/almyty-widget-left/)

  // An unsaved placement reaches the preview.
  await page.getByRole('combobox', { name: 'Position' }).click()
  await page.getByRole('option', { name: 'Bottom left' }).click()
  await expect(preview.locator('.almyty-widget-root')).toHaveClass(/almyty-widget-left/)
  await expect(preview.locator('.almyty-widget-panel.almyty-widget-open')).toBeVisible()

  expect(violations).toEqual([])
})
