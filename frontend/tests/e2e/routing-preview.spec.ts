import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'

/**
 * L3 gate against a running stack: `plan()` is callable with no agent, and
 * the preview shows what was chosen and what was rejected with reasons.
 *
 * This goes through the real HTTP boundary on purpose. A unit test on the
 * service cannot see a controller that refuses the body, which is exactly
 * how the deployment feature shipped unreachable earlier this week.
 */
async function registerUser(page: Page, suffix: string) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const user = {
    email: `e2e-${suffix}-${stamp}@example.com`,
    password: 'E2e#Routing2026pass',
    firstName: 'Route',
    lastName: 'Preview',
    organizationName: `Route Preview ${stamp}`,
  }
  await page.goto('/auth/register')
  await page.locator('#firstName').fill(user.firstName)
  await page.locator('#lastName').fill(user.lastName)
  await page.locator('#email').fill(user.email)
  await page.locator('#organizationName').fill(user.organizationName)
  await page.locator('#password').fill(user.password)
  await page.locator('#confirmPassword').fill(user.password)
  await page.locator('#terms').click()
  const registered = page.waitForResponse((r) => r.url().includes('/auth/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create account' }).click()
  const res = await registered
  expect(res.status(), `register: ${await res.text()}`).toBe(201)
  await page.waitForURL(/\/dashboard/)
  return user
}

type AuthState = Awaited<ReturnType<BrowserContext['storageState']>>
const test = base.extend<{}, { authState: AuthState }>({
  authState: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL })
      const page = await context.newPage()
      await registerUser(page, 'routing')
      const state = await context.storageState()
      await context.close()
      await use(state)
    },
    { scope: 'worker' },
  ],
})
test.use({ storageState: async ({ authState }, use) => { await use(authState) } })

test.describe('routing preview over HTTP', () => {
  test('a policy is previewable with no agent, and answers JSON', async ({ page }) => {
    await page.goto('/models')

    const res = await page.request.post('/models/route-preview', {
      data: { objective: 'cheapest' },
    })

    expect(res.headers()['content-type']).toContain('application/json')
    expect(res.status(), await res.text()).toBe(201)
    const body = await res.json()
    expect(body.success).toBe(true)
    // A fresh organization has no cards, so the honest answer is an empty
    // plan rather than an error: nothing was chosen and nothing qualified.
    expect(Array.isArray(body.data.candidates)).toBe(true)
    expect(Array.isArray(body.data.rejected)).toBe(true)
  })

  test('accepts the whole policy shape the editor sends', async ({ page }) => {
    await page.goto('/models')

    const res = await page.request.post('/models/route-preview', {
      data: {
        objective: 'fastest',
        privacyTier: 'private_cloud',
        regions: ['eu-central'],
        capabilities: { tools: true },
        connectionPreference: ['openai'],
        budgetHeadroomCents: 500,
      },
    })

    expect(res.status(), await res.text()).toBe(201)
    expect((await res.json()).success).toBe(true)
  })

  test('refuses an objective that is not one of the three, with a reason', async ({ page }) => {
    await page.goto('/models')

    const res = await page.request.post('/models/route-preview', { data: { objective: 'cleverest' } })

    expect(res.status()).toBe(400)
    const body = await res.json()
    // The reason reaches the user rather than a bare status code.
    expect(JSON.stringify(body)).toMatch(/objective/i)
  })

  test('never returns a credential, whatever the catalog holds', async ({ page }) => {
    await page.goto('/models')
    const res = await page.request.post('/models/route-preview', { data: {} })
    const text = await res.text()
    expect(text).not.toContain('apiKey')
    expect(text).not.toContain('sk-')
  })
})
