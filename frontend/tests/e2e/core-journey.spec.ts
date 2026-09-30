import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { execSync } from 'child_process'

import { AuthHelper } from './helpers/auth.helper'
import { startFakeUpstreams, type FakeUpstreams, FINAL_ANSWER, FORECAST, MODEL_ID } from './helpers/fake-upstreams'

/**
 * The core journey, through the UI, the way a new user takes it: sign up,
 * add a provider connection under Credentials, connect an API (its kind
 * first), create a gateway for its tools over MCP and call it (and one each
 * over UTCP and Skills), build an autonomous agent (work mode, model,
 * the API as a capability) and run it, then add a web chat channel on the
 * agent and chat with it as a visitor. Unit suites cannot see the seams
 * between these (a client calling a route the server shadows, a proxy rule
 * missing, a response shape the page does not wait for); this walks across
 * all of them.
 *
 * Nothing leaves the machine and no key is real: the model, the API and
 * its description are one local fake (helpers/fake-upstreams.ts). The fake
 * model asks for the forecast tool and then answers with what it returned,
 * so an answer that carries the forecast proves the tool really ran.
 *
 * Needs a running stack:
 *   - the backend with LLM_ALLOW_PRIVATE_URLS=true (the fake model is on
 *     localhost), reachable at E2E_API_URL;
 *   - the vite dev server in front of it at E2E_BASE_URL (dev builds
 *     stand in for a hosted chat's own host with ?__slug=);
 *   - E2E_PSQL, a psql command line for its database, used for the one
 *     thing a new user does outside the product: clicking the link in
 *     the verification email.
 *
 *   E2E_BASE_URL=http://localhost:3102 E2E_API_URL=http://localhost:4100 \
 *   E2E_PSQL="docker exec -i almyty-qa-pg psql -U postgres -d almyty_qa" \
 *   npm run test:e2e:journey
 */

const API_ORIGIN = (process.env.E2E_API_URL || 'http://localhost:4000').replace(/\/api\/?$/, '').replace(/\/+$/, '')

function sql(query: string): string {
  const psql = process.env.E2E_PSQL
  if (!psql) throw new Error('E2E_PSQL is not set: a psql command line for the backend database')
  return execSync(`${psql} -v ON_ERROR_STOP=1 -tA`, { input: query, encoding: 'utf8' }).trim()
}

/** A JSON-RPC answer, from a JSON body or the first `data:` line of an SSE one. */
function rpcResult(body: string): any {
  const text = body.trimStart().startsWith('{') ? body : (body.split('\n').find((l) => l.startsWith('data:')) ?? '').slice(5)
  const message = JSON.parse(text)
  if (message.error) throw new Error(`JSON-RPC error: ${JSON.stringify(message.error)}`)
  return message.result
}

/** The smallest MCP client over Streamable HTTP: initialize, then calls on that session. */
async function mcpClient(request: APIRequestContext, url: string, accessKey: string) {
  let id = 0
  let session: string | undefined
  const call = async (method: string, params: unknown) => {
    const response = await request.post(url, {
      headers: {
        'x-api-key': accessKey,
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      data: { jsonrpc: '2.0', id: ++id, method, params },
    })
    expect(response.status(), `${method}: ${await response.text()}`).toBe(200)
    session = response.headers()['mcp-session-id'] ?? session
    return rpcResult(await response.text())
  }
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e-journey', version: '1.0.0' } })
  return { call }
}

/**
 * What a page is allowed to get wrong: nothing, except the session probe a
 * signed-out page makes (401 on /auth/profile before sign-in).
 */
const EXPECTED_FAILURE = (path: string, status: number) => path === '/auth/profile' && status === 401

interface Trouble {
  consoleErrors: string[]
  failedRequests: string[]
}

/** Record console errors, failed requests, and API calls the dev server answered with the SPA. */
function watch(page: Page, who: string, trouble: Trouble) {
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const at = message.location().url
    const path = at ? new URL(at).pathname : ''
    // The browser's own line for a failed response; the response itself is judged below.
    if (/^Failed to load resource: the server responded with a status of 401/.test(message.text()) && EXPECTED_FAILURE(path, 401)) return
    trouble.consoleErrors.push(`${who}: ${message.text()}${at ? ` (${at})` : ''}`)
  })
  page.on('pageerror', (error) => trouble.consoleErrors.push(`${who}: ${String(error)}`))
  page.on('response', async (response) => {
    const url = new URL(response.url())
    const kind = response.request().resourceType()
    if (response.status() >= 400 && !EXPECTED_FAILURE(url.pathname, response.status())) {
      const body = (await response.text().catch(() => '')).slice(0, 500)
      trouble.failedRequests.push(`${who}: ${response.request().method()} ${url.pathname} -> ${response.status()} ${body}`)
    }
    // A backend prefix the vite proxy has no rule for comes back as index.html.
    if ((kind === 'xhr' || kind === 'fetch') && (response.headers()['content-type'] || '').includes('text/html')) {
      trouble.failedRequests.push(`${who}: ${response.request().method()} ${url.pathname} answered with HTML (no proxy rule?)`)
    }
  })
}

test('core journey: sign up, credentials, API, gateway, agent, channel', async ({ browser, page, request }) => {
  test.setTimeout(120_000)
  const fake: FakeUpstreams = await startFakeUpstreams()
  const trouble: Trouble = { consoleErrors: [], failedRequests: [] }
  watch(page, 'user', trouble)
  const user = AuthHelper.generateTestUser('journey')
  let agentPath = ''

  try {
    await test.step('register, verify, sign in', async () => {
      await page.goto('/auth/register')
      await page.locator('#firstName').fill(user.firstName)
      await page.locator('#lastName').fill(user.lastName)
      await page.locator('#email').fill(user.email)
      await page.locator('#organizationName').fill(user.organizationName)
      await page.locator('#password').fill(user.password)
      await page.locator('#confirmPassword').fill(user.password)
      await page.locator('#terms').click()
      await page.getByRole('button', { name: 'Create account' }).click()
      await page.waitForURL(/\/dashboard/)

      await page.getByRole('button', { name: 'User menu' }).click()
      await page.getByRole('menuitem', { name: 'Log out' }).click()
      await page.waitForURL(/\/auth\/login/)
      // The verification link, clicked.
      sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = now() WHERE email = '${user.email}';`)
      await page.locator('#email').fill(user.email)
      await page.locator('#password').fill(user.password)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await page.waitForURL(/\/dashboard/)
    })

    await test.step('Credentials: the Add credential tiles, then a provider connection to your own server', async () => {
      await page.getByTestId('sidebar-nav').getByRole('link', { name: 'Credentials', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Credentials', level: 1 })).toBeVisible()
      await page.getByRole('link', { name: 'Add credential' }).first().click()
      await expect(page).toHaveURL(/\/credentials\/new$/)
      await expect(page.getByRole('heading', { name: 'Add credential', level: 1 })).toBeVisible()
      await expect(page.locator('[data-testid^="service-tile-"]').first()).toBeVisible()
      await page.getByLabel('Search services').fill('zzzz-no-such-service')
      await expect(page.getByRole('button', { name: 'Save its key as another service' })).toBeVisible()

      // Model providers are one tile here, which leads to their own connect flow.
      await page.getByLabel('Search services').fill('')
      await page.getByTestId('service-tile-ai-models').click()
      await expect(page).toHaveURL(/\/credentials\/providers\/new$/)
      await page.getByRole('textbox', { name: 'Search providers' }).fill('own server')
      await page.getByTestId('provider-tile-custom').click()
      await page.getByLabel('Server URL').fill(fake.llmUrl)
      await page.getByRole('button', { name: 'Connect', exact: true }).click()
      const done = page.getByTestId('connect-success')
      await expect(done).toContainText(MODEL_ID)
      await done.getByRole('button', { name: 'Done' }).click()
      // Done opens the new connection, with its models ticked.
      await expect(page).toHaveURL(/\/credentials\/providers\/[0-9a-f-]{36}$/)
    })

    let apiId = ''
    await test.step('APIs: pick the kind, then give its description', async () => {
      await page.goto('/apis/new')
      await page.getByTestId('api-kind-openapi').click()
      await expect(page).toHaveURL(/\/apis\/new\/openapi$/)
      // A link to a local address is refused on purpose, so the description goes in as a file.
      await page.getByRole('tab', { name: 'File' }).click()
      await page.locator('input[type=file]').setInputFiles({ name: 'forecast.json', mimeType: 'application/json', buffer: Buffer.from(fake.openApi()) })
      await page.getByRole('button', { name: 'Connect API' }).click()
      await page.waitForURL(/\/apis\/[0-9a-f-]{36}$/)
      apiId = new URL(page.url()).pathname.split('/')[2]
      await expect(page.getByRole('heading', { name: 'E2E Forecast', level: 1 })).toBeVisible()
      await expect(page.getByRole('button', { name: /GET \/forecast/ })).toBeVisible()
    })

    /** Create gateway for the API's tools over one protocol; the key (none for Skills) and the address. */
    const createGateway = async (protocol: 'mcp' | 'utcp' | 'skills', path: string) => {
      await page.goto(`/gateways/new?protocol=${protocol}&api=${apiId}`)
      await expect(page.getByTestId(`gateway-protocol-${protocol}`)).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId(`share-api-${apiId}`)).toHaveAttribute('aria-pressed', 'true')
      // One gateway per protocol over the same tools: each its own path.
      await page.getByRole('button', { name: /^Advanced/ }).click()
      await page.getByLabel('Path').fill(path)
      await page.getByRole('button', { name: 'Create gateway' }).click()
      await page.waitForURL(/\/gateways\/[0-9a-f-]{36}$/)
      const id = new URL(page.url()).pathname.split('/')[2]
      const key = protocol === 'skills' ? '' : (await page.getByTestId('initial-api-key').locator('code').innerText()).trim()
      const address = (await page.getByTestId('connect-snippets').locator('code').filter({ hasText: /^https?:\/\// }).first().innerText()).trim()
      // The address is on the API's origin, which in dev is vite; a client talks to the API itself.
      return { id, key, url: `${API_ORIGIN}${new URL(address).pathname}` }
    }

    let gatewayUrl = ''
    let accessKey = ''
    await test.step('Create gateway: MCP, from the API page, with the key and the MCP setups', async () => {
      await page.getByRole('link', { name: 'Create gateway' }).click()
      await expect(page).toHaveURL(new RegExp(`/gateways/new\\?api=${apiId}$`))
      await page.getByTestId('gateway-protocol-mcp').click()
      await page.getByRole('button', { name: 'Create gateway' }).click()
      await page.waitForURL(/\/gateways\/[0-9a-f-]{36}$/)
      accessKey = (await page.getByTestId('initial-api-key').locator('code').innerText()).trim()
      expect(accessKey).toMatch(/^gw_/)
      const snippets = page.getByTestId('connect-snippets')
      await expect(snippets.getByRole('tab', { name: 'Claude Code' })).toBeVisible()
      await expect(snippets.getByRole('tab', { name: 'UTCP' })).toHaveCount(0)
      const address = (await snippets.locator('code').filter({ hasText: /^https?:\/\// }).first().innerText()).trim()
      gatewayUrl = `${API_ORIGIN}${new URL(address).pathname}`
      await expect(page.getByRole('tab', { name: /Tool scoping \(1\// })).toBeVisible()
    })

    let forecastTool = ''
    await test.step('call the tools over MCP; a UTCP and a Skills gateway list the same tool', async () => {
      // The fake API is on localhost: the organization says that host is its own.
      const orgId = sql(`SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${user.email}' LIMIT 1;`)
      const allowed = await page.request.patch(`/organizations/${orgId}`, { data: { settings: { egressAllowlist: ['localhost'] } } })
      expect(allowed.status(), await allowed.text()).toBeLessThan(300)

      const mcp = await mcpClient(request, gatewayUrl, accessKey)
      const names: string[] = (await mcp.call('tools/list', {})).tools.map((t: { name: string }) => t.name)
      forecastTool = names.find((n) => /forecast/i.test(n)) ?? ''
      expect(forecastTool, `tools/list: ${names.join(', ')}`).not.toBe('')
      const called = await mcp.call('tools/call', { name: forecastTool, arguments: { city: 'Lisbon' } })
      expect(called.isError ?? false, JSON.stringify(called)).toBe(false)
      expect(JSON.stringify(called.content)).toContain(FORECAST)
      expect(fake.apiCalls).toContain('GET /api/forecast?city=Lisbon')

      const utcp = await createGateway('utcp', '/forecast-utcp')
      const manual = await request.get(`${utcp.url}/manual`, { headers: { 'x-api-key': utcp.key } })
      expect(manual.status(), await manual.text()).toBe(200)
      const manualNames: string[] = ((await manual.json()).tools ?? []).map((t: { name: string }) => t.name)
      expect(manualNames.some((n) => n === forecastTool || n.endsWith(`.${forecastTool}`)), `UTCP manual: ${manualNames.join(', ')}`).toBe(true)

      // A Skills gateway has no access key: the Skills CLI reads it signed in as you, from here.
      const skillsGateway = await createGateway('skills', '/forecast-skills')
      const skills = await page.request.get(`/gateways/${skillsGateway.id}/skills/individual`)
      expect(skills.status(), await skills.text()).toBe(200)
      // The same tool, in the Agent Skills spelling (lowercase with dashes), under the gateway's name.
      const body = await skills.json()
      const skillNames: string[] = (body.data?.skills ?? []).map((s: { name: string }) => s.name)
      expect(skillNames).toEqual([`forecast-skills-${forecastTool.replace(/_/g, '-')}`])
    })

    await test.step('Agents: an autonomous agent, its work mode and model, the API as a capability, run from the UI', async () => {
      await page.goto('/agents/new')
      await page.getByRole('group', { name: 'Agent mode' }).getByRole('button', { name: 'Autonomous' }).click()
      await page.getByRole('textbox', { name: 'Agent name' }).fill('Forecaster')
      await page.getByPlaceholder('You are a helpful assistant that...').fill('Answer weather questions with the forecast tool.')
      // Work mode comes first, with the model slots it needs under it.
      await expect(page.getByRole('combobox', { name: 'Work mode' })).toContainText('Single')
      const model = page.getByRole('combobox', { name: 'Model' })
      await model.click()
      await page.getByRole('searchbox', { name: 'Search models' }).fill(MODEL_ID)
      await page.getByRole('option', { name: new RegExp(MODEL_ID) }).click()
      await expect(model).toContainText(MODEL_ID)
      // Capabilities: the whole API, so its tools (and later ones) are the agent's.
      await page.getByRole('checkbox', { name: 'All tools of E2E Forecast, including ones added later' }).click()
      await expect(page.getByTestId('capability-tools-chosen')).toContainText('E2E Forecast, all tools')
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByText('Agent "Forecaster" saved successfully.', { exact: true })).toBeVisible()
      const agentId = new URL(page.url()).pathname.split('/')[2]

      await page.goto(`/agents/${agentId}`)
      const actions = page.getByRole('group', { name: 'Agent actions' })
      await actions.getByRole('button', { name: 'Activate' }).click()
      await expect(actions.getByRole('button', { name: 'Deactivate' })).toBeVisible()
      await page.getByPlaceholder('Type a message to test this agent...').fill('What is the weather in Lisbon?')
      await page.getByRole('button', { name: 'Run test' }).click()
      await expect(page.getByRole('status').filter({ hasText: FINAL_ANSWER })).toContainText(FORECAST, { timeout: 30_000 })
      agentPath = `/agents/${agentId}`
    })

    await test.step('Channels: a web chat on the agent, published, answering a visitor', async () => {
      await page.goto(`${agentPath}?tab=channels`)
      await expect(page.getByRole('heading', { name: 'Channels', level: 2 })).toBeVisible()
      await page.getByRole('link', { name: 'Add channel' }).first().click()
      await expect(page.getByRole('heading', { name: 'Add channel', level: 1 })).toBeVisible()
      await page.getByRole('button', { name: /^Web chat/ }).click()
      await expect(page.getByRole('heading', { name: 'Web chat', level: 1 })).toBeVisible()
      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Live', level: 2 })).toBeVisible()
      const link = await page.getByRole('link', { name: 'Open it' }).getAttribute('href')
      const slug = new URL(link!).hostname.split('.')[0]

      // A visitor, with no dashboard session. Without wildcard DNS a dev
      // build stands in for the app's own host with ?__slug=.
      const visitorContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
      try {
        const visitor = await visitorContext.newPage()
        watch(visitor, 'visitor', trouble)
        await visitor.goto(`/?__slug=${slug}`)
        await expect(visitor.getByRole('heading', { name: 'How can I help?' })).toBeVisible()
        await visitor.getByRole('textbox', { name: 'Message' }).fill('Weather in Lisbon, please')
        await visitor.getByRole('button', { name: 'Send' }).click()
        await expect(visitor.getByText(FINAL_ANSWER).last()).toContainText(FORECAST, { timeout: 30_000 })
      } finally {
        await visitorContext.close()
      }
    })

    expect(trouble.failedRequests, 'failed requests').toEqual([])
    expect(trouble.consoleErrors, 'console errors').toEqual([])
  } finally {
    await test.info().attach('fake-upstreams.json', {
      body: JSON.stringify({ apiCalls: fake.apiCalls, chatCalls: fake.chatCalls, ...trouble }, null, 2),
      contentType: 'application/json',
    })
    await fake.close()
  }
})
