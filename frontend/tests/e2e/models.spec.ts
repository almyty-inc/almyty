import { test as base, expect, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'http'
import { AddressInfo } from 'net'

/**
 * Models: the list, Add model (a provider's API, a server you run),
 * inference providers set up inline, validation, a price override on the
 * model's own page, sync, and the routed llm_call node.
 *
 * There are no tabs and no dialogs in these flows: /models is the list,
 * /models/new asks where the model runs, /models/:id is the model, and
 * inference providers live on /llm-providers. The list shows a card grid,
 * with the table behind a toggle and a "where it runs" filter beside it,
 * so the assertions below read the grid first and switch to the table
 * where a per-column value is the point.
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
 * with OLLAMA_ALLOW_PRIVATE_URLS=true and LLM_ALLOW_PRIVATE_URLS=true for
 * that). Against a remote stack with no URL the provider-dependent tests
 * are skipped.
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

test.describe('Models: the list, Add model and inference providers', () => {
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

  test('the list page: empty state, no tabs, no dialogs, header links, and /models answers JSON', async ({ page }) => {
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
    // Nothing to summarise until there is at least one model.
    await expect(page.getByTestId('catalog-summary')).toHaveCount(0)
    await expect(page.getByTestId('catalog-cards')).toHaveCount(0)
    // With no inference providers there is nothing to sync, so the
    // empty state does not offer it.
    await expect(empty.getByRole('button', { name: 'Sync from providers' })).toHaveCount(0)

    // One list, no tabs. Adding a model and managing inference providers
    // are pages of their own, linked from the header.
    await expect(page.getByRole('tab')).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Inference providers' })).toHaveAttribute('href', '/llm-providers')
    await expect(page.getByRole('link', { name: 'Add model' }).first()).toHaveAttribute('href', '/models/new')

    // Links from before the page lost its tabs still land somewhere real.
    await page.goto('/models?tab=providers')
    await expect(page).toHaveURL(/\/llm-providers$/)
    await expect(page.getByRole('heading', { name: 'Inference providers', level: 1 })).toBeVisible()
    await page.goto('/models?tab=deployments')
    await expect(page).toHaveURL(/\/models$/)

    // Add model opens a page that asks where the model runs, one answer per URL.
    await page.goto('/models')
    await page.getByRole('link', { name: 'Add model' }).first().click()
    await expect(page).toHaveURL(/\/models\/new$/)
    await expect(page.getByRole('heading', { name: 'Add model', level: 1 })).toBeVisible()
    const choices = page.getByRole('list', { name: 'Where does it run?' })
    await expect(choices.getByRole('button')).toHaveCount(3)
    for (const [label, via] of [["A provider's API", 'provider'], ['A server you run', 'server'], ['Your cloud account', 'cloud']] as const) {
      await page.goto('/models/new')
      await page.getByRole('list', { name: 'Where does it run?' }).getByRole('button', { name: new RegExp(`^${label}`) }).click()
      await expect(page).toHaveURL(new RegExp(`/models/new\\?via=${via}$`))
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
  })

  test("a provider's API: an inference provider set up inline fills the list, validates, takes a price override, syncs", async ({ page }) => {
    test.skip(!llmUrl, 'no reachable fake LLM server (set E2E_FAKE_LLM_URL)')

    // With no inference provider yet, the form offers to set one up on the page itself.
    await page.goto('/models/new?via=provider')
    await expect(page.getByRole('heading', { name: "Add a model from a provider's API", level: 1 })).toBeVisible()
    await expect(page.getByTestId('no-inference-providers')).toContainText('No inference providers yet')
    await page.getByRole('button', { name: 'Set up an inference provider' }).click()
    const setup = page.getByRole('region', { name: 'Set up an inference provider' })
    await expect(setup).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await setup.getByLabel('Provider Name').fill('E2E Ollama')
    await setup.getByLabel('Provider Type').click()
    await page.getByRole('option', { name: 'Ollama', exact: true }).click()
    await setup.getByLabel('Base URL (optional)').fill(llmUrl!)
    const created = page.waitForResponse((r) => new URL(r.url()).pathname === '/llm-providers' && r.request().method() === 'POST')
    await setup.getByRole('button', { name: 'Add inference provider' }).click()
    expect((await created).status()).toBe(201)
    await expect(page.getByText('Inference provider added', { exact: true })).toBeVisible()

    // Back on the model form, with the new provider picked.
    await expect(setup).toHaveCount(0)
    await expect(page.getByRole('combobox', { name: 'Inference provider' })).toContainText('E2E Ollama')

    // The provider_created hook syncs the model list and the health check
    // records a passing validation for the model it called.
    await waitForSelectableCard(page)
    await page.goto('/models')

    // The list opens on the cards, and says what the agents can use.
    await expect(page.getByTestId('catalog-summary')).toContainText(/[12] of 2 models/)
    await expect(page.getByTestId('catalog-vendors')).toContainText('E2E Ollama')
    const grid = page.getByTestId('catalog-cards')
    await expect(grid.getByRole('listitem')).toHaveCount(2)
    await expect(grid).toContainText('e2e-small:latest')
    await expect(grid).toContainText('e2e-large:latest')
    // Ollama is a server the organization runs, and each model says where.
    const smallCard = grid.getByRole('listitem').filter({ hasText: 'e2e-small:latest' })
    await expect(smallCard).toContainText('Your server')
    await expect(smallCard).toContainText('Your Ollama server')
    // Neither runs on a cloud account, so that filter empties the grid.
    await page.getByLabel('Filter by where it runs').click()
    await page.getByRole('option', { name: 'Your cloud' }).click()
    await expect(page.getByText('0 of 2 shown')).toBeVisible()
    await page.getByLabel('Filter by where it runs').click()
    await page.getByRole('option', { name: 'Runs anywhere' }).click()
    await expect(grid.getByRole('listitem')).toHaveCount(2)

    // The table is the same data, one row per model.
    await showTable(page)
    const small = page.getByRole('row').filter({ hasText: 'e2e-small:latest' })
    const large = page.getByRole('row').filter({ hasText: 'e2e-large:latest' })
    await expect(small).toBeVisible()
    await expect(large).toBeVisible()
    await expect(large.getByRole('cell', { name: 'Not validated' })).toBeVisible()

    // Validate the second model by hand.
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

    // Price override through the model's own page: Edit lands on its
    // inline settings form, not a sheet or a dialog.
    await openRowActions(page, 'e2e-large:latest')
    await page.getByRole('menuitem', { name: 'Edit' }).click()
    await expect(page).toHaveURL(/\/models\/[^/]+#settings$/)
    await expect(page.getByRole('heading', { name: 'e2e-large:latest', level: 1 })).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const settings = page.getByRole('form', { name: 'Model settings' })
    await settings.getByRole('switch', { name: 'Override price' }).click()
    await settings.locator('#edit-price-in').fill('0.25')
    await settings.locator('#edit-price-out').fill('1.5')
    const patched = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/models/'))
    await settings.getByRole('button', { name: 'Save changes' }).click()
    expect((await patched).status()).toBe(200)
    await expect(page.getByText('Model updated', { exact: true })).toBeVisible()

    await page.goto('/models')
    await showTable(page)
    await expect(large.getByRole('cell', { name: '$0.25 in / $1.50 out Override' })).toBeVisible()

    // Sync from providers reports what is already there.
    await page.getByRole('button', { name: 'Sync from providers' }).first().click()
    const synced = page.waitForResponse((r) => r.url().includes('/models/sync'))
    await page.getByRole('menuitem', { name: 'All inference providers' }).click()
    expect((await synced).status()).toBe(201)
    await expect(page.getByText('Sync complete', { exact: true })).toBeVisible()
    await expect(page.getByText(/0 new models from all inference providers, 2 already present/).first()).toBeVisible()

    // Usable only keeps both.
    await page.getByRole('checkbox', { name: 'Usable only' }).click()
    await expect(small).toBeVisible()
    await expect(large).toBeVisible()
  })

  test('a server you run: a custom inference provider plus an ordinary model, validated and removed from its page', async ({ page }) => {
    test.skip(!llmUrl, 'no reachable fake LLM server (set E2E_FAKE_LLM_URL)')

    await page.goto('/models/new?via=server')
    await expect(page.getByRole('heading', { name: 'Connect a server you run', level: 1 })).toBeVisible()
    await page.locator('#server-url').fill(`${llmUrl}/v1`)
    await page.locator('#server-model-id').fill('e2e-small')
    await page.locator('#server-name').fill('E2E server')

    // Two ordinary requests: a `custom` inference provider holding the URL,
    // then a model on it. There is no endpoint-registration route.
    const providerPost = page.waitForRequest((r) => r.method() === 'POST' && new URL(r.url()).pathname === '/llm-providers')
    const providerRes = page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/llm-providers')
    let endpointRoute = false
    page.on('request', (r) => { if (r.url().includes('register-endpoint')) endpointRoute = true })
    await page.getByRole('button', { name: 'Add model', exact: true }).click()
    const sent = (await providerPost).postDataJSON()
    expect(sent).toMatchObject({ name: 'E2E server', type: 'custom', configuration: { apiUrl: `${llmUrl}/v1`, model: 'e2e-small' } })
    const created = await providerRes
    expect(created.status(), await created.text()).toBe(201)
    await expect(page.getByText('Server connected', { exact: true })).toBeVisible()
    expect(endpointRoute).toBe(false)

    // Saving the provider also imports what the server lists, so the model
    // may already have been there; either way exactly one is on the list.
    await expect(page).toHaveURL(/\/models(\/[^/#?]+)?$/)
    let modelId = ''
    await expect
      .poll(async () => {
        const rows: any[] = (await (await page.request.get('/models')).json())?.data ?? []
        const hit = rows.find((r) => r.vendorModelId === 'e2e-small' && r.providerType === 'custom')
        modelId = hit?.id ?? ''
        return modelId
      }, { timeout: 15000, message: 'the server model is in the list' })
      .not.toBe('')

    // It is a model like any other, on its own page, saying where it runs.
    await page.goto(`/models/${modelId}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByText(/^Your server \(/).first()).toBeVisible()
    await expect(page.getByRole('region', { name: 'On your cloud' })).toHaveCount(0)
    await expect(page.getByRole('form', { name: 'Model settings' })).toBeVisible()

    // Validation runs one real call through the server. A localhost URL is
    // only reachable when the backend allows private URLs for custom
    // providers; either verdict must still come back as JSON with a toast.
    const validated = page.waitForResponse((r) => /\/models\/[^/]+\/validate$/.test(new URL(r.url()).pathname))
    await page.getByRole('button', { name: 'Validate', exact: true }).click()
    const validateRes = await validated
    expect(validateRes.headers()['content-type']).toContain('application/json')
    await expect(page.getByText(/^Validation (passed|failed)$/)).toBeVisible()

    // The server is an inference provider too, listed on that page.
    await page.goto('/llm-providers')
    await expect(page.getByRole('row').filter({ hasText: 'E2E server' })).toBeVisible()

    // Remove asks first, then returns to the list.
    await page.goto(`/models/${modelId}`)
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    const confirm = page.getByRole('alertdialog')
    await expect(confirm.getByRole('heading', { name: 'Remove this model?' })).toBeVisible()
    const removed = page.waitForResponse((r) => r.request().method() === 'DELETE' && new URL(r.url()).pathname === `/models/${modelId}`)
    await confirm.getByRole('button', { name: 'Remove', exact: true }).click()
    expect((await removed).status()).toBeLessThan(300)
    await expect(page).toHaveURL(/\/models$/)
    await expect(page.getByText('Model removed', { exact: true })).toBeVisible()
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
    await page.getByLabel('Privacy').click()
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
    await page.getByRole('button', { name: 'Run' }).click()
    const invokeDialog = page.getByRole('dialog')
    await expect(invokeDialog.getByRole('heading', { name: 'Run Agent' })).toBeVisible()
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
