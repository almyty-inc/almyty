import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { AddressInfo } from 'net'

/**
 * Models layer: catalog, providers, validation, price override, endpoint
 * registration, sync, and the routed llm_call node.
 *
 * The catalog is the default tab and shows a card grid, with the table
 * behind a toggle and an origin filter beside it, so the assertions below
 * read the grid first and switch to the table where a per-column value is
 * the point.
 *
 * Auth is the httpOnly cookie set by POST /auth/register, issued through
 * page.request so it lands in the browser context; nothing touches
 * localStorage. Every models/provider API response is checked to be JSON,
 * because a missing vite proxy rule answers with index.html and the page
 * fails in a way no unit test sees.
 *
 * The provider flows need an OpenAI/Ollama-compatible server the backend can
 * reach. When E2E_FAKE_LLM_URL is set it is used as-is; otherwise, on a
 * localhost baseURL, the spec starts one in-process (the backend must run
 * with OLLAMA_ALLOW_PRIVATE_URLS=true for that). Against a remote stack with
 * no URL the provider-dependent tests are skipped.
 *
 *   npx playwright test --config=playwright.local.config.ts models.spec.ts
 */

const API_PATHS = /^\/(models|model-adapters|model-deployments|model-versions|llm-providers|agents)(\/|\?|$)/

function fakeLlmServer(): Promise<{ server: Server; url: string; calls: string[] }> {
  const calls: string[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`)
      const json = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      const url = req.url || ''
      if (req.method === 'GET' && url.startsWith('/api/tags')) {
        return json(200, { models: [
          { name: 'e2e-small:latest', model: 'e2e-small:latest', size: 1, details: { family: 'llama' } },
          { name: 'e2e-large:latest', model: 'e2e-large:latest', size: 2, details: { family: 'llama' } },
        ] })
      }
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        return json(200, { object: 'list', data: [{ id: 'e2e-small', object: 'model' }, { id: 'e2e-large', object: 'model' }] })
      }
      if (req.method === 'POST' && (url.startsWith('/v1/chat/completions') || url.startsWith('/chat/completions'))) {
        let model = 'e2e-small'
        try { model = JSON.parse(body || '{}').model || model } catch { /* keep default */ }
        return json(200, {
          id: 'chatcmpl-e2e', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'E2E_REPLY_OK' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })
      }
      json(404, { error: { message: `no route ${req.method} ${url}` } })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://localhost:${port}`, calls })
    })
  })
}

/** Registers a throwaway user; the response cookie authenticates the page. */
async function registerUser(page: Page, suffix: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const user = {
    email: `e2e-${suffix}-${stamp}@example.com`,
    password: 'E2e#Models2026pass',
    firstName: 'E2E',
    lastName: suffix,
    organizationName: `E2E ${suffix} ${stamp}`,
  }
  // Through the real form: registration sets the httpOnly cookie and seeds
  // the persisted auth store, which a cookie-only cold load does not get.
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

/** Fails the test on any models/provider API response that is not JSON. */
/**
 * One throwaway user per file. /auth/register is throttled to ten per hour
 * per IP, so registering in every test exhausts it after two runs; a
 * worker-scoped fixture registers once and hands the cookie plus the
 * persisted auth store to every page through storageState.
 */
type AuthState = Awaited<ReturnType<BrowserContext['storageState']>>
const test = base.extend<{}, { authState: AuthState }>({
  authState: [
    async ({ browser }, use, workerInfo) => {
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL })
      const page = await context.newPage()
      await registerUser(page, 'models')
      const state = await context.storageState()
      await context.close()
      await use(state)
    },
    { scope: 'worker' },
  ],
})
test.use({ storageState: async ({ authState }, use) => { await use(authState) } })

function guardJsonResponses(page: Page): string[] {
  const violations: string[] = []
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (!API_PATHS.test(path) || response.request().resourceType() === 'document') return
    const type = response.headers()['content-type'] || ''
    if (response.status() !== 204 && !type.includes('application/json')) {
      violations.push(`${response.request().method()} ${path} -> ${response.status()} ${type || '(no content-type)'}`)
    }
  })
  return violations
}

/**
 * The provider health check runs a second after creation and records a
 * passing validation on the card it called; the catalog does not refetch on
 * its own, so wait for it in the API before opening the page.
 */
async function waitForSelectableCard(page: Page, timeoutMs = 30000) {
  await expect
    .poll(async () => {
      const res = await page.request.get('/models')
      const rows = (await res.json())?.data ?? []
      return rows.filter((r: any) => r.selectable).length
    }, { timeout: timeoutMs, message: 'a card became selectable after the provider health check' })
    .toBeGreaterThan(0)
}

async function openRowActions(page: Page, cardName: string) {
  await page.getByRole('button', { name: `Actions for ${cardName}` }).click()
}

/** The table is behind a toggle; the cards are what the page opens on. */
async function showTable(page: Page) {
  await page.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Table', exact: true })).toHaveAttribute('aria-pressed', 'true')
}

test.describe.configure({ mode: 'serial' })

test.describe('Models: catalog and providers', () => {
  let fake: { server: Server; url: string; calls: string[] } | null = null
  let llmUrl: string | undefined = process.env.E2E_FAKE_LLM_URL
  let violations: string[] = []

  test.beforeAll(async ({ baseURL }) => {
    if (!llmUrl && /localhost|127\.0\.0\.1/.test(baseURL || '')) {
      fake = await fakeLlmServer()
      llmUrl = fake.url
    }
  })

  test.afterAll(async () => {
    fake?.server.close()
  })

  test.beforeEach(async ({ page }) => {
    violations = guardJsonResponses(page)
  })

  test.afterEach(async () => {
    expect(violations, 'non-JSON API responses').toEqual([])
  })

  test('catalog empty state renders and /models answers JSON', async ({ page }) => {
    const listed = page.waitForResponse((r) => new URL(r.url()).pathname === '/models' && r.request().method() === 'GET' && r.request().resourceType() !== 'document')
    await page.goto('/models')
    const res = await listed
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('application/json')

    // The page heading and the empty-state heading both say "models", so
    // the page one is matched exactly rather than by substring.
    await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible()
    const empty = page.getByRole('status').filter({ hasText: 'No models yet' })
    await expect(empty.getByRole('heading', { name: 'No models yet' })).toBeVisible()
    // Nothing to summarise until there is at least one card.
    await expect(page.getByTestId('catalog-summary')).toHaveCount(0)
    await expect(page.getByTestId('catalog-cards')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Register endpoint' }).first()).toBeVisible()
    // Sync is pointless with no providers, so the empty-state CTA is disabled.
    await expect(empty.getByRole('button', { name: 'Sync from providers' })).toBeDisabled()

    for (const tab of ['Catalog', 'Deployments', 'Providers', 'Tracked artifacts']) {
      await expect(page.getByRole('tab', { name: tab })).toBeVisible()
    }
  })

  test('provider tab: an Ollama-compatible provider auto-populates the catalog, validates, takes a price override, syncs', async ({ page }) => {
    test.skip(!llmUrl, 'no reachable fake LLM server (set E2E_FAKE_LLM_URL)')

    // Add the provider through the Providers tab.
    await page.goto('/models?tab=providers')
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible()
    await page.getByRole('button', { name: /Add provider/i }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Add Provider' })).toBeVisible()
    await dialog.getByLabel('Provider Name').fill('E2E Ollama')
    await dialog.getByLabel('Provider Type').click()
    await page.getByRole('option', { name: 'Ollama' }).click()
    await dialog.getByLabel('Base URL (optional)').fill(llmUrl!)
    const created = page.waitForResponse((r) => r.url().includes('/llm-providers') && r.request().method() === 'POST')
    await dialog.getByRole('button', { name: 'Add Provider' }).click()
    expect((await created).status()).toBe(201)
    await expect(page.getByRole('cell', { name: /E2E Ollama/ })).toBeVisible()

    // The provider_created hook syncs the model list into the catalog and the
    // health check records a passing validation for the model it called.
    await waitForSelectableCard(page)
    await page.goto('/models')

    // The catalog opens on the cards, and says what the agents can use.
    await expect(page.getByTestId('catalog-summary')).toContainText(/[12] of 2 models/)
    await expect(page.getByTestId('catalog-vendors')).toContainText('E2E Ollama')
    const grid = page.getByTestId('catalog-cards')
    await expect(grid.getByRole('listitem')).toHaveCount(2)
    await expect(grid).toContainText('e2e-small:latest')
    await expect(grid).toContainText('e2e-large:latest')
    await expect(grid.getByRole('listitem').filter({ hasText: 'e2e-small:latest' })).toContainText('Vendor key')
    // Both came from a vendor key, so the deployment origin filter empties the grid.
    await page.getByLabel('Filter by where it came from').click()
    await page.getByRole('option', { name: 'Deployed by you' }).click()
    await expect(page.getByText('0 of 2 shown')).toBeVisible()
    await page.getByLabel('Filter by where it came from').click()
    await page.getByRole('option', { name: 'Any origin' }).click()
    await expect(grid.getByRole('listitem')).toHaveCount(2)

    // The table is the same data, one row per card.
    await showTable(page)
    const small = page.getByRole('row').filter({ hasText: 'e2e-small:latest' })
    const large = page.getByRole('row').filter({ hasText: 'e2e-large:latest' })
    await expect(small).toBeVisible()
    await expect(large).toBeVisible()
    await expect(large.getByRole('cell', { name: 'Not validated' })).toBeVisible()

    // Validate the second card by hand.
    await openRowActions(page, 'e2e-large:latest')
    const validated = page.waitForResponse((r) => /\/models\/[^/]+\/validate$/.test(new URL(r.url()).pathname))
    await page.getByRole('menuitem', { name: 'Validate' }).click()
    const validateRes = await validated
    expect(validateRes.status()).toBe(201)
    expect(validateRes.headers()['content-type']).toContain('application/json')
    await expect(page.getByText('Validation passed', { exact: true })).toBeVisible()
    await expect(large.getByRole('cell', { name: 'Passed' })).toBeVisible()
    await expect(large.getByRole('cell', { name: 'Selectable', exact: true })).toBeVisible()
    await expect(page.getByTestId('catalog-summary')).toContainText('2 of 2 models')
    expect(fake?.calls.some((c) => c.includes('/chat/completions')) ?? true).toBe(true)

    // Price override through the Edit sheet.
    await openRowActions(page, 'e2e-large:latest')
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await expect(page.getByRole('heading', { name: 'Edit card' })).toBeVisible()
    await page.getByRole('switch', { name: 'Override price' }).click()
    await page.locator('#edit-price-in').fill('0.25')
    await page.locator('#edit-price-out').fill('1.5')
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/models/'))
    await page.getByRole('button', { name: 'Save' }).click()
    expect((await patched).status()).toBe(200)
    await expect(page.getByText('Card updated', { exact: true })).toBeVisible()
    await expect(large.getByRole('cell', { name: '$0.25 in / $1.50 out Override' })).toBeVisible()

    // Sync from providers reports what is already there.
    await page.getByRole('button', { name: 'Sync from providers' }).first().click()
    const synced = page.waitForResponse((r) => r.url().includes('/models/sync'))
    await page.getByRole('menuitem', { name: 'All providers' }).click()
    expect((await synced).status()).toBe(201)
    await expect(page.getByText('Sync complete', { exact: true })).toBeVisible()
    await expect(page.getByText(/0 new cards from all providers, 2 already present/).first()).toBeVisible()

    // Filters: Selectable only keeps both, provider filter lists the provider.
    await page.getByRole('checkbox', { name: 'Selectable only' }).click()
    await expect(small).toBeVisible()
    await expect(large).toBeVisible()
  })

  test('register endpoint dialog creates a custom-provider card', async ({ page }) => {
    test.skip(!llmUrl, 'no reachable fake LLM server (set E2E_FAKE_LLM_URL)')

    await page.goto('/models')
    await page.getByRole('button', { name: 'Register endpoint' }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Register endpoint' })).toBeVisible()
    await dialog.locator('#endpoint-name').fill('E2E endpoint')
    await dialog.locator('#endpoint-url').fill(`${llmUrl}/v1`)
    await dialog.locator('#endpoint-model-id').fill('e2e-small')
    const registered = page.waitForResponse((r) => r.url().includes('/models/register-endpoint'))
    await dialog.getByRole('button', { name: 'Register endpoint', exact: true }).click()
    const res = await registered
    expect(res.headers()['content-type']).toContain('application/json')
    expect(res.status(), await res.text()).toBe(201)
    await expect(page.getByText('Endpoint registered', { exact: true })).toBeVisible()

    // An endpoint card sits in the same grid as the vendor ones, with the
    // model id it sends and no validation run behind it yet. It is badged
    // as the customer's own endpoint rather than a vendor key: the card
    // carries endpointRef.url and no deploymentId, which is what tells
    // those three origins apart.
    const card = page.getByTestId('catalog-cards').getByRole('listitem').filter({ hasText: 'E2E endpoint' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('e2e-small')
    await expect(card).toContainText('Your endpoint')
    await expect(card).toContainText('Not validated')
    await expect(card).toContainText('Not selectable')

    // And the origin filter finds it, which it could not when the card
    // looked like a vendor one.
    await page.getByLabel('Filter by where it came from').click()
    await page.getByRole('option', { name: 'Your endpoint' }).click()
    await expect(page.getByTestId('catalog-cards').getByRole('listitem').filter({ hasText: 'E2E endpoint' })).toBeVisible()
    await page.getByLabel('Filter by where it came from').click()
    await page.getByRole('option', { name: 'Any origin' }).click()

    // Validation runs one real call through the endpoint. A localhost URL is
    // only reachable when the backend allows private URLs for custom
    // providers; either verdict must still come back as JSON with a toast.
    await openRowActions(page, 'E2E endpoint')
    const validated = page.waitForResponse((r) => /\/models\/[^/]+\/validate$/.test(new URL(r.url()).pathname))
    await page.getByRole('menuitem', { name: 'Validate' }).click()
    const validateRes = await validated
    expect(validateRes.headers()['content-type']).toContain('application/json')
    await expect(page.getByText(/^Validation (passed|failed)$/)).toBeVisible()
  })

  test('agent builder: a routed llm_call node runs through the catalog and the run shows its attribution', async ({ page }) => {
    test.skip(!llmUrl, 'no reachable fake LLM server (set E2E_FAKE_LLM_URL)')
    test.setTimeout(240000)

    // The provider test above left validated, selectable cards for the router.
    await waitForSelectableCard(page)

    // Build: one llm_call node switched to a policy.
    await page.goto('/agents/new')
    const canvas = page.locator('[role="application"]')
    await expect(canvas).toBeVisible({ timeout: 15000 })
    await page.getByRole('textbox', { name: 'Agent name' }).fill('E2E routed agent')
    await canvas.getByRole('group').filter({ hasText: 'LLM Call' }).click()
    const selection = page.getByRole('radiogroup', { name: 'Model selection' })
    await expect(selection).toBeVisible()
    await selection.getByRole('radio', { name: 'Routed by policy' }).click()
    await expect(page.getByLabel('Objective')).toBeVisible()
    await page.getByLabel('Privacy tier ceiling').click()
    await page.getByRole('option', { name: 'Local or stricter' }).click()
    const saved = page.waitForResponse((r) => r.url().includes('/agents') && ['POST', 'PUT', 'PATCH'].includes(r.request().method()))
    await page.getByRole('button', { name: 'Save' }).click()
    const saveRes = await saved
    expect(saveRes.headers()['content-type']).toContain('application/json')
    await expect(page.getByText(/saved successfully/).first()).toBeVisible()

    // The saved pipeline carries the policy, not a pinned provider.
    const list = await page.request.get('/agents')
    const body = await list.json()
    const agents: any[] = body?.data?.agents ?? body?.data ?? body
    const agent = agents.find((a: any) => a.name === 'E2E routed agent')
    expect(agent, 'saved agent listed').toBeTruthy()
    const llmNode = (agent.pipeline?.nodes ?? []).find((n: any) => n.type === 'llm_call')
    expect(llmNode?.data?.routing).toMatchObject({ objective: 'cheapest', privacyTier: 'local' })
    expect(llmNode?.data?.providerId ?? null).toBeNull()

    // A draft agent refuses invoke; activate, then run it from the detail page.
    await page.goto(`/agents/${agent.id}`)
    await expect(page.getByRole('heading', { name: 'E2E routed agent' })).toBeVisible()
    await page.getByRole('button', { name: 'Activate' }).click()
    await expect(page.getByText('Agent activated', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Invoke' }).click()
    const invokeDialog = page.getByRole('dialog')
    await expect(invokeDialog.getByRole('heading', { name: 'Invoke Agent' })).toBeVisible()
    await invokeDialog.getByRole('textbox').first().fill('{"message": "Say hello"}')
    const invoked = page.waitForResponse((r) => r.url().includes('/invoke'))
    await invokeDialog.getByRole('button', { name: 'Run Agent' }).click()
    const invokeRes = await invoked
    expect(invokeRes.headers()['content-type']).toContain('application/json')
    expect(invokeRes.status(), await invokeRes.text()).toBeLessThan(300)
    await expect(invokeDialog.getByText(/"status": "completed"/)).toBeVisible({ timeout: 30000 })
    await page.keyboard.press('Escape')

    // The run row says which card answered and why.
    const attribution = page.getByTestId('routing-attribution').first()
    await expect(attribution).toBeVisible({ timeout: 15000 })
    await expect(attribution).toContainText(/Routed: e2e-(small|large):latest via cheapest/)
    await expect(attribution).toContainText('attempt 1')
    expect(fake?.calls.filter((c) => c.includes('/chat/completions')).length ?? 1).toBeGreaterThan(0)
  })
})
