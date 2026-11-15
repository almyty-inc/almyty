/**
 * J9: an agent's channels, the way its visitors and callers reach it.
 *
 * Each test builds its own autonomous weather agent in the QA org (the
 * Open-Meteo tool, a connected model) and puts it on one channel:
 *
 * - web chat on `<slug>.staging.almyty.app`, asked by a visitor in a fresh
 *   browser with no almyty cookies;
 * - the same, with an approval rule on the agent's own forecast tool: the
 *   visitor is told the step waits, the QA user approves it in Approvals,
 *   and the visitor then gets the answer;
 * - the website widget, embedded with the snippet from its channel page on
 *   a local page this test serves on 127.0.0.1 (allowed on that page too);
 * - A2A, called with the official A2A client (@a2a-js/sdk) and a key made
 *   on the channel page.
 *
 * Every answer is checked against Open-Meteo, fetched by the test at the
 * same moment. Nothing here holds a vendor key; the model is the QA org's.
 */
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { randomUUID } from 'crypto'
import { ClientFactory, ClientFactoryOptions, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client'
import { test, expect, screenshotThis } from './support/fixtures'
import { connectApi, idFromUrl } from './support/flows'
import { BERLIN, OPEN_METEO_SPEC, berlinDaily } from './support/open-meteo'
import { data } from './support/qa-api'
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from '@playwright/test'
import type { Gate } from './support/fixtures'

const MAIN_MODEL = process.env.GATE_MAIN_MODEL || 'gpt-4.1-mini'

/** Pick a model in an open model picker by searching for it. */
async function pickModel(page: Page, picker: Locator, model: string): Promise<void> {
  await picker.click()
  await page.getByRole('searchbox', { name: 'Search models' }).fill(model)
  const option = page.getByRole('option', { name: new RegExp(model.replace(/[.]/g, '\\.')) }).first()
  await expect(option, `${model} should be offered by a connected provider`).toBeVisible()
  await option.click()
  await expect(picker).not.toContainText('Choose a model')
}

/** Tomorrow's date in Berlin, as Open-Meteo writes it (YYYY-MM-DD). */
function berlinTomorrow(): string {
  const now = new Date(Date.now() + 24 * 3600_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

const QUESTION = (day: string) =>
  `What is the maximum temperature in Berlin (latitude ${BERLIN.latitude}, longitude ${BERLIN.longitude}) on ${day}? ` +
  'Use timezone Europe/Berlin. Answer with the number in °C.'

/** Open-Meteo's own maximum for Berlin on `day`, read now. */
async function liveMax(day: string): Promise<number> {
  const daily = await berlinDaily(3)
  const idx = daily.time.indexOf(day)
  expect(idx, `Open-Meteo should forecast ${day}`).toBeGreaterThanOrEqual(0)
  return daily.temperature_2m_max[idx]
}

/** The answer states the temperature Open-Meteo gives (the agent may round to a whole degree). */
function expectTemperature(text: string, expected: number, day: string, where: string): void {
  const temps = [...text.matchAll(/(-?\d+(?:[.,]\d+)?)\s*°/g)].map((m) => Number(m[1].replace(',', '.')))
  expect(temps.length, `the ${where} answer "${text}" should state a temperature`).toBeGreaterThan(0)
  for (const t of temps) {
    expect(Math.abs(t - expected), `the ${where} answer "${text}" should give ${expected} °C (Open-Meteo, ${day})`).toBeLessThanOrEqual(0.5)
  }
}

interface WeatherAgent {
  agentId: string
  agentName: string
  apiName: string
}

/**
 * The agent every channel test puts in front of people: Open-Meteo
 * connected by link, an autonomous agent on a connected model with all of
 * its tools, switched on.
 */
async function weatherAgent(
  page: Page,
  gate: Gate,
  what: string,
  days = 'start_date and end_date set to the day asked',
): Promise<WeatherAgent> {
  const apiName = gate.name(`${what}-openmeteo`)
  await connectApi(page, gate, {
    kind: /OpenAPI \/ Swagger/,
    name: apiName,
    fill: async (p) => {
      await p.getByRole('textbox', { name: 'Link to the description' }).fill(OPEN_METEO_SPEC)
    },
  })
  const agentName = gate.name(`${what}-agent`)
  await page.goto('/agents/new')
  await page.getByRole('textbox', { name: 'Agent name' }).fill(agentName)
  await expect(page.getByRole('button', { name: 'Autonomous' })).toHaveAttribute('aria-pressed', 'true')
  await pickModel(page, page.getByRole('combobox', { name: 'Model' }), MAIN_MODEL)
  await page.getByRole('textbox', { name: 'Instructions' }).fill(
    'You report weather. Always call the Open-Meteo forecast tool for the numbers ' +
      `(daily=temperature_2m_max, timezone=Europe/Berlin, ${days}). ` +
      'Report exactly the value the tool returned, in °C, with one decimal. Never invent numbers.',
  )
  await page.getByRole('textbox', { name: 'Search tools' }).fill(apiName)
  await page.getByRole('checkbox', { name: new RegExp(`^All tools of ${apiName}`) }).check()
  await expect(page.getByText(`${apiName}, all tools`)).toBeVisible()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page).toHaveURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 60_000 })
  const agentId = idFromUrl(page)
  gate.track('agent', agentId)

  await page.goto(`/agents/${agentId}`)
  await expect(page.getByRole('heading', { name: agentName, level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Activate', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Deactivate', exact: true })).toBeVisible()
  return { agentId, agentName, apiName }
}

/**
 * Channels tab › Add channel › the kind. Lands on the channel's page and
 * registers the channel for deletion (deleting it takes its gateway down).
 */
async function addChannel(page: Page, gate: Gate, qa: APIRequestContext, agent: WeatherAgent, kind: 'web' | 'widget' | 'a2a'): Promise<string> {
  await page.goto(`/agents/${agent.agentId}?tab=channels`)
  await page.getByRole('tabpanel', { name: 'Channels' }).getByRole('link', { name: 'Add channel' }).first().click()
  await expect(page).toHaveURL(/\/channels\/new$/)
  await page.getByTestId(`channel-${kind}`).click()
  await expect(page, 'adding a channel should open its page').toHaveURL(/\/channels\/[0-9a-f-]{36}$/, { timeout: 30_000 })
  const channelId = page.url().match(/\/channels\/([0-9a-f-]{36})$/)![1]
  gate.defer(`delete channel ${channelId}`, async () => {
    const res = await qa.delete(`/agents/${agent.agentId}/channels/${channelId}`)
    if (!res.ok() && res.status() !== 404) throw new Error(`delete channel: ${res.status()}`)
  })
  return channelId
}

/** Publish from the channel page and wait for it to say it is live. */
async function publish(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unpublish', exact: true }), 'publishing should make the channel live').toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('main').getByText(/^Live$/).first()).toBeVisible()
}

/** Unpublish from the channel page, as an owner taking it down. */
async function unpublish(page: Page, channelUrl: string): Promise<void> {
  await page.goto(channelUrl)
  await page.getByRole('button', { name: 'Unpublish', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible({ timeout: 30_000 })
}

/** A browser context with nothing of the QA user's: a visitor. */
async function visitorContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 900 } })
}

/** Publish a web chat for the agent; returns its public address. */
async function publishWebChat(page: Page, gate: Gate, qa: APIRequestContext, agent: WeatherAgent): Promise<{ url: string; channelUrl: string }> {
  await addChannel(page, gate, qa, agent, 'web')
  const channelUrl = page.url()
  await publish(page)
  const url = (await page.getByTestId('web-address').locator('code').innerText()).trim()
  expect(url, 'the web chat should live on *.staging.almyty.app').toMatch(/^https:\/\/[a-z0-9-]+\.staging\.almyty\.app$/)
  return { url, channelUrl }
}

/** The visitor's last reply bubble on the hosted chat. */
function lastReply(chat: Page): Locator {
  return chat.locator('main div.bg-muted.rounded-2xl').last()
}

/** Ask on the hosted chat page. */
async function askHostedChat(chat: Page, question: string): Promise<void> {
  const box = chat.getByRole('textbox', { name: 'Message' })
  await expect(box, 'the web chat should open for a visitor').toBeVisible({ timeout: 60_000 })
  await box.fill(question)
  await chat.getByRole('button', { name: 'Send' }).click()
}

test.describe('J9 channels', () => {
  test('J9 web chat on *.staging.almyty.app answers a visitor from the live tool', async ({ page, gate, qa, browser }) => {
    const agent = await weatherAgent(page, gate, 'webchat')
    const { url, channelUrl } = await publishWebChat(page, gate, qa, agent)

    const visitor = await visitorContext(browser)
    const chat = await visitor.newPage()
    screenshotThis(chat)
    await chat.goto(url)
    await expect(chat.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 })

    const day = berlinTomorrow()
    await askHostedChat(chat, QUESTION(day))
    const expected = await liveMax(day)
    const reply = lastReply(chat)
    await expect(reply, 'the visitor should get an answer with a temperature').toContainText(/\d\s*°/, { timeout: 180_000 })
    // Let the stream finish before reading it.
    await expect(chat.getByRole('button', { name: 'Send' }).locator('svg.animate-spin')).toHaveCount(0, { timeout: 120_000 })
    expectTemperature(await reply.innerText(), expected, day, 'web chat')

    await unpublish(page, channelUrl)
  })

  test('J9 web chat: an approval rule holds the tool call until the QA user approves it', async ({ page, gate, qa, browser }) => {
    // The agent always asks Open-Meteo for three days, so every forecast
    // call carries forecast_days = 3.
    const agent = await weatherAgent(page, gate, 'approval', 'forecast_days=3, and read the day asked from the list')
    const toolIdent = `${agent.apiName.replace(/-/g, '_')}_get_v1_forecast`

    // Ask before the agent's own forecast tool runs with forecast_days over
    // 0. The rule names this one tool, so nothing else in the org waits on it.
    const ruleName = gate.name('approval-rule')
    await page.goto('/settings/approvals/rules/new')
    await page.locator('#rule-name').fill(ruleName)
    await page.locator('#rule-tool').click()
    await page.getByRole('option', { name: new RegExp(toolIdent) }).click()
    await page.locator('#rule-argument').click()
    await page.getByRole('option', { name: /^forecast_days/ }).click()
    await page.locator('#rule-amount').fill('0')
    await expect(page.getByTestId('amount-rule-summary')).toContainText(/forecast_days/)
    const created = page.waitForResponse((r) => /\/approval-rules$/.test(r.url()) && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Create rule' }).click()
    const res = await created
    expect(res.ok(), `creating the rule answered ${res.status()}`).toBeTruthy()
    const rule = await data<any>(res)
    expect(rule?.id, 'creating the rule should return it').toBeTruthy()
    gate.defer(`delete approval rule ${rule.id}`, async () => {
      const del = await qa.delete(`/approval-rules/${rule.id}`)
      if (!del.ok() && del.status() !== 404) throw new Error(`delete approval rule: ${del.status()}`)
    })

    const { url } = await publishWebChat(page, gate, qa, agent)
    const visitor = await visitorContext(browser)
    const chat = await visitor.newPage()
    screenshotThis(chat)
    await chat.goto(url)
    const day = berlinTomorrow()
    await askHostedChat(chat, QUESTION(day))

    // The visitor is told the step waits for a person.
    await expect(
      chat.getByRole('status').filter({ hasText: 'Waiting for a person on the team to approve this step.' }),
      'the visitor should be told the step waits for approval',
    ).toBeVisible({ timeout: 180_000 })

    // The QA user approves it in Approvals.
    await page.goto('/approvals')
    const card = page
      .locator('div')
      .filter({ has: page.getByRole('link', { name: agent.agentName, exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Approve' }) })
      .last()
    await expect(card, 'the held step should be listed in Approvals').toBeVisible({ timeout: 60_000 })
    await card.getByRole('button', { name: 'Approve' }).click()
    const form = page.getByRole('form', { name: 'Approve this action' })
    const decided = page.waitForResponse((r) => /\/approve$/.test(r.url()) && r.request().method() === 'POST')
    await form.getByRole('button', { name: 'Approve' }).click()
    expect((await decided).ok(), 'approving should be accepted').toBeTruthy()

    // The visitor then gets the answer.
    const expected = await liveMax(day)
    const reply = lastReply(chat)
    await expect(reply, 'the visitor should get the answer once the step is approved').toContainText(/\d\s*°/, { timeout: 180_000 })
    await expect(chat.getByRole('status').filter({ hasText: 'Waiting for a person' })).toHaveCount(0)
    await expect(chat.getByRole('button', { name: 'Send' }).locator('svg.animate-spin')).toHaveCount(0, { timeout: 120_000 })
    expectTemperature(await reply.innerText(), expected, day, 'approved web chat')
  })

  test('J9 website widget embedded on a local page answers from the live tool', async ({ page, gate, qa, browser }) => {
    const agent = await weatherAgent(page, gate, 'widget')
    await addChannel(page, gate, qa, agent, 'widget')
    const channelUrl = page.url()
    await publish(page)

    // The line to paste, as the channel page gives it.
    const snippet = (await page.locator('#widget-embed-snippet').or(page.getByRole('main').locator('code').filter({ hasText: '<script' })).first().innerText()).trim()
    expect(snippet, 'the widget page should give a script tag to paste').toMatch(/^<script[^>]+src="https:\/\/[^"]+widget\.js"[^>]*><\/script>$/)

    // A local site with the snippet before </body>.
    const server: Server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><head><title>${gate.name('widget-site')}</title></head><body><h1>A site with the chat</h1>${snippet}</body></html>`)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    gate.defer('stop the local site', () => new Promise<void>((resolve) => server.close(() => resolve())))
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    // Allow that site on the widget, as its owner would.
    await page.getByRole('textbox', { name: 'Add a site' }).fill(origin)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('main').getByText(origin)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled({ timeout: 15_000 })

    const visitor = await visitorContext(browser)
    const site = await visitor.newPage()
    screenshotThis(site)
    await site.goto(origin)
    await site.getByRole('button', { name: 'Open chat' }).click()
    const input = site.getByPlaceholder('Type a message…')
    await expect(input, 'the widget should open on the page').toBeVisible({ timeout: 30_000 })
    const day = berlinTomorrow()
    await input.fill(QUESTION(day))
    await site.locator('.almyty-widget-form').getByRole('button', { name: 'Send' }).click()
    const expected = await liveMax(day)
    const reply = site.locator('.almyty-widget-msg-agent').filter({ hasText: /\d\s*°/ }).last()
    await expect(reply, 'the widget should show the answer with a temperature').toBeVisible({ timeout: 180_000 })
    // The reply streams in: read it once it has stopped growing.
    let text = ''
    await expect(async () => {
      const now = await reply.innerText()
      const same = now === text
      text = now
      expect(same).toBe(true)
    }).toPass({ timeout: 60_000, intervals: [2000] })
    expectTemperature(text, expected, day, 'widget')

    await unpublish(page, channelUrl)
  })

  test('J9 A2A channel answers the official A2A client from the live tool', async ({ page, gate, qa }) => {
    const agent = await weatherAgent(page, gate, 'a2a')
    await addChannel(page, gate, qa, agent, 'a2a')
    const channelUrl = page.url()
    await publish(page)

    const cardUrl = (await page.locator('#a2a-card').or(page.getByRole('main').locator('code').filter({ hasText: 'agent-card.json' })).first().innerText()).trim()
    expect(cardUrl).toMatch(/^https:\/\/.+\/\.well-known\/agent-card\.json$/)

    // A caller key, made on the channel page. Read once, never printed.
    const signIn = page.getByTestId('gateway-sign-in-methods')
    const apiKeyBox = signIn.getByRole('checkbox', { name: 'Keys', exact: true })
    if (!(await apiKeyBox.isChecked())) await apiKeyBox.check()
    await signIn.getByRole('button', { name: 'New key' }).click()
    const keyForm = page.getByRole('form', { name: 'New key' })
    await keyForm.getByRole('textbox', { name: 'Name' }).fill(gate.name('a2a-caller'))
    await keyForm.getByRole('button', { name: 'Make key' }).click()
    const shown = page.getByTestId('generated-api-key')
    await expect(shown, 'Make key should make the caller key and show it once').toBeVisible()
    const key = (await shown.locator('code, input').first().evaluate((el) => (el as HTMLInputElement).value || el.textContent || '')).trim()
    expect(key.length, 'the page should show the new key once').toBeGreaterThan(16)

    const withKey: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers)
      headers.set('x-api-key', key)
      return fetch(input, { ...init, headers })
    }
    const factory = new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new JsonRpcTransportFactory({ fetchImpl: withKey, legacyCompat: { enabled: true } })],
        cardResolver: new DefaultAgentCardResolver({ fetchImpl: withKey, legacyCompat: { enabled: true } }),
      }),
    )
    const client = await factory.createFromUrl(cardUrl, '')

    const day = berlinTomorrow()
    const [result, expected] = await Promise.all([
      client.sendMessage({
        message: {
          messageId: randomUUID(),
          role: 1 /* ROLE_USER */,
          parts: [{ content: { $case: 'text', value: QUESTION(day) } }],
        },
        configuration: { blocking: true, acceptedOutputModes: ['text/plain'] },
      } as any),
      liveMax(day),
    ])
    const texts = textsOf(result)
    const answer = texts.filter((t) => /°/.test(t)).join('\n')
    expect(answer, `the A2A answer should state a temperature: ${JSON.stringify(result).slice(0, 600)}`).toMatch(/\d\s*°/)
    expectTemperature(answer, expected, day, 'A2A')

    await unpublish(page, channelUrl)
  })
})

/** Every text an A2A result carries: the task's status message, its artifacts and history, or the message itself. */
function textsOf(value: unknown): string[] {
  const out: string[] = []
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return
    if (Array.isArray(v)) return v.forEach(walk)
    if (v.$case === 'text' && typeof v.value === 'string') out.push(v.value)
    if (v.kind === 'text' && typeof v.text === 'string') out.push(v.text)
    if (typeof v.text === 'string' && !v.kind) out.push(v.text)
    for (const k of Object.keys(v)) walk(v[k])
  }
  walk(value)
  return out
}
