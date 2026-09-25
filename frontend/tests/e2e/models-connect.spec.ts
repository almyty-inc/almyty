import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { AddressInfo } from 'net'
import { randomBytes } from 'crypto'

import { AuthHelper } from './helpers/auth.helper'

/**
 * Models, the way a new user meets it: Models -> Connect a provider ->
 * a tile -> a key (here, your own server) -> its models -> pick one in a
 * single search box. Nothing asks where a model runs.
 *
 * Needs a backend with POST /llm-providers/connect. The provider flows need
 * an OpenAI-compatible server the backend can reach: E2E_FAKE_LLM_URL when
 * set, otherwise (on a localhost baseURL) one started in-process, which needs
 * the backend to run with LLM_ALLOW_PRIVATE_URLS=true. Against a remote
 * stack with no URL those tests are skipped.
 *
 *   npx playwright test --config=playwright.local.config.ts models-connect.spec.ts
 */

const API_PATHS = /^\/(models|model-adapters|model-deployments|llm-providers)(\/|\?|$)/
/** What the fake server refuses as a credential; made per run. */
const REFUSED = `refused-${randomBytes(8).toString('hex')}`

function fakeLlmServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if ((req.headers.authorization || '').includes(REFUSED)) return json(401, { error: { message: 'Incorrect API key provided' } })
    const url = req.url || ''
    if (req.method === 'GET' && /\/models(\?|$)/.test(url)) {
      return json(200, { object: 'list', data: [{ id: 'e2e-small', object: 'model' }, { id: 'e2e-large', object: 'model' }] })
    }
    if (req.method === 'POST' && /chat\/completions/.test(url)) {
      return json(200, {
        id: 'chatcmpl-e2e', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'e2e-small',
        choices: [{ index: 0, message: { role: 'assistant', content: 'E2E_REPLY_OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      })
    }
    json(404, { error: { message: `no route ${req.method} ${url}` } })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://localhost:${(server.address() as AddressInfo).port}/v1` }))
  })
}

async function registerUser(page: Page) {
  // The shared throwaway e2e user, so this file writes no credentials of its own.
  const user = AuthHelper.generateTestUser('connect')
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
  expect((await registered).status()).toBe(201)
  await page.waitForURL(/\/dashboard/)
}

/** One user per worker: /auth/register is throttled per IP. */
type AuthState = Awaited<ReturnType<BrowserContext['storageState']>>
const test = base.extend<{}, { authState: AuthState }>({
  authState: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL })
      const page = await context.newPage()
      await registerUser(page)
      const state = await context.storageState()
      await context.close()
      await use(state)
    },
    { scope: 'worker' },
  ],
})
test.use({ storageState: async ({ authState }, use) => { await use(authState) } })

/** A missing vite proxy rule answers an API call with index.html; catch that here. */
function guardJsonResponses(page: Page): string[] {
  const violations: string[] = []
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (!API_PATHS.test(path) || response.request().resourceType() === 'document') return
    const type = response.headers()['content-type'] || ''
    if (response.status() !== 204 && !type.includes('application/json')) violations.push(`${response.request().method()} ${path} -> ${response.status()} ${type}`)
  })
  return violations
}

test.describe.configure({ mode: 'serial' })

test.describe('Models: connect a provider, see its models, pick one', () => {
  let fake: { server: Server; url: string } | null = null
  let llmUrl: string | undefined = process.env.E2E_FAKE_LLM_URL
  let violations: string[] = []

  test.beforeAll(async ({ baseURL }) => {
    if (!llmUrl && /localhost|127\.0\.0\.1/.test(baseURL || '')) {
      fake = await fakeLlmServer()
      llmUrl = fake.url
    }
  })
  test.afterAll(async () => { fake?.server.close() })
  test.beforeEach(async ({ page }) => { violations = guardJsonResponses(page) })
  test.afterEach(async () => { expect(violations, 'non-JSON API responses').toEqual([]) })

  test('an empty Models page goes straight to connecting, and the old addresses redirect', async ({ page }) => {
    await page.goto('/models')
    await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Connect your first provider' })).toBeVisible()
    await expect(page.getByText(/Where does it run/i)).toHaveCount(0)

    for (const [from, to] of [['/llm-providers', /\/models$/], ['/llm-providers/new', /\/models\/connect$/], ['/models/new?type=anthropic', /\/models\/connect\?type=anthropic$/]] as const) {
      await page.goto(from)
      await expect(page).toHaveURL(to)
    }
  })

  test('a refused key is said plainly, and nothing is saved', async ({ page }) => {
    test.skip(!llmUrl, 'no reachable fake LLM server (set E2E_FAKE_LLM_URL)')
    await page.goto('/models/connect?type=custom')
    await page.getByLabel('Server URL').fill(llmUrl!)
    await page.getByLabel('API key (optional)').fill(REFUSED)
    const connected = page.waitForResponse((r) => new URL(r.url()).pathname === '/llm-providers/connect')
    await page.getByRole('button', { name: 'Connect' }).click()
    expect((await connected).status()).toBe(400)
    await expect(page.getByTestId('connect-failure')).toBeVisible()
    await expect(page.getByLabel('API key (optional)')).toHaveValue(REFUSED)
    const providers = await (await page.request.get('/llm-providers')).json()
    expect(providers?.data ?? providers).toHaveLength(0)
  })

  test('connect your own server, see its models, and pick one in the chat with one search box', async ({ page }) => {
    test.skip(!llmUrl, 'no reachable fake LLM server (set E2E_FAKE_LLM_URL)')
    await page.goto('/models')
    await page.getByRole('link', { name: 'Connect a provider' }).first().click()
    await expect(page).toHaveURL(/\/models\/connect$/)
    await page.getByRole('textbox', { name: 'Search providers' }).fill('own server')
    await page.getByTestId('provider-tile-custom').click()
    await expect(page).toHaveURL(/\?type=custom$/)
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.getByLabel('Server URL').fill(llmUrl!)
    const connected = page.waitForResponse((r) => new URL(r.url()).pathname === '/llm-providers/connect')
    await page.getByRole('button', { name: 'Connect' }).click()
    expect((await connected).status()).toBe(201)
    const done = page.getByTestId('connect-success')
    await expect(done).toContainText('My server is connected.')
    await expect(done).toContainText('e2e-small')
    await done.getByRole('button', { name: 'Done' }).click()

    await expect(page).toHaveURL(/\/models$/)
    await expect(page.getByRole('link', { name: /My server/ })).toBeVisible()
    await expect(page.getByText('e2e-small').first()).toBeVisible()

    await page.goto('/chat')
    const picker = page.getByRole('combobox', { name: 'Model' })
    await picker.click()
    await page.getByRole('searchbox', { name: 'Search models' }).fill('e2e-sm')
    await page.getByRole('option', { name: /e2e-small/ }).click()
    await expect(picker).toContainText('e2e-small')
    // One field: no provider to choose first.
    await expect(page.getByLabel('Provider', { exact: true })).toHaveCount(0)
  })
})
