#!/usr/bin/env node
// Walks five example guides in docs-site/content/examples through the UI,
// step by step as their text says, and takes the screenshots they show:
// stripe-payout-reconciliation, nightly-data-quality-digest,
// nl-query-your-database, cross-vendor-contract-review and govern-ai-spend.
//
// It needs the demo stack started with USECASES=1 and data-upstream.mjs
// already listening on USECASE_PORT (start it before stack.sh, which then
// leaves its own stand-in off): the stand-in for Stripe, Xero, BigQuery,
// Slack (messages and shared files) and the OpenAI, Mistral and Anthropic
// APIs, answered by the scripted models in data-model.mjs. Nothing reaches
// a real account and every run answers the same way.
//
//   CONTRACT_PDF=$SHOT_DIR/examples/northgate-fulfilment-agreement.pdf \
//     USECASE_PORT=4293 node scripts/demo-seed/usecases/data-upstream.mjs &
//   USECASES=1 USECASE_PORT=4293 MODEL_PRICE_FEED_DISABLED=false scripts/demo-seed/stack.sh up
//   DEMO_USECASE_URL=http://localhost:4293 node scripts/demo-seed/usecases/data-guides.mjs --fresh
//
// The contract PDF is printed from data-contract.html on the first run.
//
// It works as Ines Duarte, head of finance and operations at Larkspur Home
// (made up), in an organization of her own. What differs from a real
// account, because the stand-in is on localhost: the organization allows
// localhost, the API addresses are set to the stand-in under Advanced, the
// model keys are sent with the stand-in's address, Google's and Xero's
// sign-in pages are never opened (a token is pasted instead), and Slack
// messages are shown as the stand-in received them, rendered as a page. The
// API descriptions are the real public ones, read from their links as a
// user would.
//
//   node scripts/demo-seed/usecases/data-guides.mjs [--fresh] [payouts quality ask contract spend]
//   node scripts/demo-seed/usecases/data-guides.mjs --register [shot...]
import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ALMYTY_ROOT || join(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(ROOT, 'frontend/package.json'))
const { chromium } = require('@playwright/test')

const WEB = process.env.DEMO_WEB_URL || 'http://localhost:3210'
const API = process.env.DEMO_API_URL || 'http://localhost:4210'
const UP = process.env.DEMO_USECASE_URL || 'http://localhost:4293'
const PSQL = process.env.DEMO_PSQL || 'docker exec -i almyty-demo-pg psql -U postgres -d almyty_qa'
const OUT = join(process.env.SHOT_DIR || '/tmp/almyty-demo/shots', 'examples')
mkdirSync(OUT, { recursive: true })

const INES = { email: 'ines.duarte@larkspurhome.example', password: 'Larkspur-2026!', firstName: 'Ines', lastName: 'Duarte', organizationName: 'Larkspur Home' }
const SLACK_SIGNING_SECRET = 'local-test-signing-secret-larkspur-01'
const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()
const upstream = async (path, init) => (await fetch(`${UP}${path}`, init)).json()
const orgOf = () => sql(`SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${INES.email}' LIMIT 1`)

// The shared UI (components/ui, components/layout, index.css) is never a source: check-screenshots rejects it as too broad.
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const NEW_API = ['frontend/src/pages/api-new.tsx']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const SCHEDULE = ['frontend/src/pages/agent-schedule.tsx']
const MODELS = ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']
const SLACK_RENDER = ['backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']
const ANALYTICS = ['frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics']
const BUDGET = ['frontend/src/pages/analytics-budget.tsx', 'frontend/src/components/analytics/budget-form.tsx']

// shot: [published path under screenshots/examples, title, sources]
export const SHOTS = {}
const RENDERED = {}

// ---------- the account ----------
async function account() {
  if (sql(`SELECT count(*) FROM users WHERE email = '${INES.email}'`) === '0') {
    const r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INES) })
    if (!r.ok) throw new Error(`register ${r.status} ${await r.text()}`)
  }
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${INES.email}'`)
  const [orgId, slug] = sql(`SELECT o.id || '|' || o.slug FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${INES.email}' AND o.name = '${INES.organizationName}' LIMIT 1`).split('|')
  sql(`UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
  return { orgId, slug }
}

const HIDE = '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }'
async function session(browser) {
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'light', timezoneId: 'UTC', locale: 'en-US', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light') } catch {} })
  await ctx.route(/accounts\.google\.com|login\.xero\.com|dashboard\.stripe\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Stopped before the real page (local demo).</p>' }))
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.goto('/auth/login')
  await page.locator('#email').fill(INES.email)
  await page.locator('#password').fill(INES.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
  // Model keys go to the stand-in instead of the vendor.
  await page.route('**/llm-providers/connect', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    const type = String(body.type || body.providerType || '')
    const vendor = /anthropic/i.test(type) ? 'anthropic' : /mistral/i.test(type) ? 'mistral' : 'openai'
    body.configuration = { ...(body.configuration || {}), apiUrl: `${UP}/${vendor}/v1` }
    await route.continue({ postData: JSON.stringify(body) })
  })
  return { ctx, page }
}

const results = existsSync(join(OUT, 'captures.json')) ? JSON.parse(readFileSync(join(OUT, 'captures.json'), 'utf8')) : {}
function helpers(page) {
  const wait = (ms = 900) => page.waitForTimeout(ms)
  const shot = async (name, opts = {}) => {
    await page.addStyleTag({ content: HIDE })
    await page.mouse.move(0, 0)
    await wait()
    const file = join(OUT, `${name}.png`)
    await page.screenshot({ path: file, ...opts })
    const url = new URL(page.url())
    results[name] = { file, route: RENDERED[name] ?? url.pathname + url.search, at: new Date().toISOString() }
    writeFileSync(join(OUT, 'captures.json'), JSON.stringify(results, null, 2))
    console.log('shot', name, RENDERED[name] ?? url.pathname)
  }
  const top = (locator, offset = 120) => locator.evaluate((e, o) => { e.scrollIntoView({ block: 'start' }); const m = document.querySelector('main'); if (m) m.scrollBy(0, -o); window.scrollBy(0, -o) }, offset)
  const id = () => page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]
  const toTop = () => page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) })
  const render = async (name, html) => {
    const file = join(OUT, `${name}.html`)
    writeFileSync(file, html)
    await page.setViewportSize({ width: 1440, height: 300 })
    await page.goto(`file://${file}`)
    await wait(800)
    await shot(name, { fullPage: true })
    await page.setViewportSize({ width: 1440, height: 900 })
  }
  const debug = async (name) => { await page.screenshot({ path: join(OUT, `debug-${name}.png`), fullPage: true }); console.log('debug', name, page.url()) }
  return { wait, shot, top, id, toTop, render, debug }
}

async function pickTools(page, names) {
  const search = page.getByRole('textbox', { name: 'Search tools' })
  for (const t of names) {
    await search.fill(t)
    await page.waitForTimeout(500)
    for (const b of await page.getByRole('button', { name: /\d+ tools?/ }).all()) if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click()
    await page.getByRole('checkbox', { name: t, exact: true }).check()
  }
  await search.fill('')
}

async function until(what, check, ms = 180000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await check()
    if (v) return v
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ---------- shared steps ----------
async function connectModel(page, h, { name = 'OpenAI', provider = 'OpenAI', key = 'sk-proj-0000000000000000000000000000000000000000', shotName } = {}) {
  if (sql(`SELECT count(*) FROM llm_providers WHERE "organizationId" = '${orgOf()}' AND name = '${name}'`) !== '0') return
  await page.goto('/models/providers/new')
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByRole('combobox', { name: 'Provider' }).click()
  await page.getByPlaceholder('Search providers').fill(provider)
  await page.getByRole('option', { name: provider, exact: true }).click()
  await h.wait(500)
  await page.getByLabel(/API key/).first().fill(key)
  if (shotName) await h.shot(shotName)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/models\/providers\/[0-9a-f-]{36}/, { timeout: 60000 })
  await h.wait(1500)
}

async function importApi(page, h, { link, name, address, linkShot, kind = 'openapi' }) {
  await page.goto(`/apis/new/${kind}`)
  await page.getByLabel('Link to the description').fill(link)
  if (linkShot) await h.shot(linkShot)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Address', { exact: true }).fill(address) // the local stand-in
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 180000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 300000 })
  await h.wait(800)
}

async function newAgent(page, { name, personality, instructions, model = /gpt-4o(?!-mini)/ }) {
  await page.goto('/agents/new')
  await page.getByRole('button', { name: 'Autonomous' }).click()
  await page.getByRole('textbox', { name: 'Agent name' }).fill(name)
  await page.getByRole('combobox', { name: 'Model' }).first().click()
  await page.getByRole('option', { name: model }).first().click()
  if (personality) await page.getByRole('textbox', { name: 'Personality and style' }).fill(personality)
  await page.getByRole('textbox', { name: 'Instructions' }).fill(instructions)
}

async function saveAndActivate(page, h) {
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
  const agent = h.id()
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('button', { name: 'Activate' }).click()
  await h.wait(1500)
  return agent
}

async function tryIt(page, h, agent, message, waitFor, shotName) {
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  const box = page.getByPlaceholder('Type a message to test this agent...')
  await box.fill(message)
  await box.press('Enter')
  await page.getByRole('status').filter({ hasText: waitFor }).waitFor({ timeout: 180000 })
  await h.wait(1200)
  await h.top(page.getByText('Try it', { exact: true }).first(), 90)
  if (shotName) await h.shot(shotName)
}

async function runSteps(page, h, agent, shotName) {
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('tab', { name: 'Runs' }).click()
  await h.wait(1500)
  await page.locator('main tbody tr').first().click()
  await h.wait(2000)
  if (shotName) await h.shot(shotName)
}

// Who writes on a channel is not the owner: the agent may use only what it was given.
async function giveAccess(page, h, agent, shotName) {
  await page.goto(`/agents/${agent}`)
  await h.wait(2000)
  const card = page.getByTestId('agent-access-card')
  await h.top(card, 140)
  if (shotName) await h.shot(shotName)
  for (let i = 0; i < 6; i++) {
    const b = card.getByRole('button', { name: /^Let this agent use/ }).first()
    if (!(await b.count())) break
    await b.click()
    await h.wait(1500)
  }
}

async function slackChannel(page, h, agent, { keysShot, liveShot } = {}) {
  await page.goto(`/agents/${agent}/channels/new`)
  await h.wait(1200)
  await page.getByRole('button', { name: /^Slack/ }).click()
  await h.wait(2000)
  await page.getByRole('button', { name: /^Advanced/ }).click()
  if (sql(`SELECT count(*) FROM credentials WHERE name = 'Slack bot (Larkspur)'`) === '0') {
    await page.getByRole('button', { name: 'Create one here' }).last().click()
    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('radio', { name: 'Bot token' }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Slack bot (Larkspur)')
    await page.getByRole('textbox', { name: 'Bot user OAuth token' }).fill('xoxb-local-test-0000000000-333333333')
    await page.getByRole('textbox', { name: 'Signing secret' }).fill(SLACK_SIGNING_SECRET)
    await page.getByRole('textbox', { name: 'Bot user OAuth token' }).scrollIntoViewIfNeeded()
    if (keysShot) await h.shot(keysShot)
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await h.wait(4000)
  } else {
    await page.getByRole('combobox').filter({ hasText: 'Pick a credential' }).last().click()
    await page.getByRole('option', { name: /Slack bot \(Larkspur\)/ }).click()
    await h.wait(1500)
  }
  const save = page.getByRole('button', { name: 'Save', exact: true }).last()
  if (await save.isEnabled().catch(() => false)) { await save.click(); await h.wait(2500) }
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await h.wait(3500)
  await h.toTop()
  if (liveShot) await h.shot(liveShot)
  return { channel: page.url().match(/channels\/([0-9a-f-]{36})/)[1] }
}

function slackEvent(slug, gatewayId, { text, channel = 'C0ASKDATA', user = 'U0FENNA', ts, threadTs, files }) {
  ts = ts || String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    token: 'x', team_id: 'T0LARKSPUR', api_app_id: 'A0APP', type: 'event_callback', event_id: `Ev${Date.now()}`, event_time: Number(ts),
    event: { type: 'app_mention', channel, user, text, ts: `${ts}.000100`, event_ts: `${ts}.000100`, ...(threadTs ? { thread_ts: threadTs } : {}), ...(files ? { files } : {}) },
  })
  const sig = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')
  return fetch(`${API}/${slug}/channels/${gatewayId}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts } })
}

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const slackHtml = (text) => escapeHtml(text)
  .replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>')
  .replace(/```([\s\S]+?)```/g, '<pre>$1</pre>')
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1<b>$2</b>')
const PAGE = (title, body, note) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:860px;margin:32px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px;border-bottom:1px solid #f4f4f5;display:flex;gap:12px}
.av{width:36px;height:36px;border-radius:6px;flex:none;color:#fff;font-weight:600;display:flex;align-items:center;justify-content:center;font-size:14px}
.who{font-weight:600;font-size:15px;margin-bottom:4px}.who span{font-size:10px;background:#e4e4e7;border-radius:3px;padding:1px 4px;margin-left:4px;color:#52525b;font-weight:500}
.reply{margin-left:48px;border-left:2px solid #e4e4e7}.thread{font-size:12px;color:#71717a;padding:6px 24px 0 72px}
.text{white-space:pre-wrap;font-size:15px;line-height:1.5}a{color:#1264a3}.mention{background:#e8f5fa;color:#1264a3;border-radius:3px;padding:0 2px}
code,pre{font-family:Menlo,Consolas,monospace;font-size:12.5px;background:#f6f6f7;border:1px solid #e4e4e7;border-radius:4px}code{padding:0 3px;color:#c01343}pre{padding:8px 10px;margin:6px 0;white-space:pre-wrap}
  .file{margin-top:8px;display:inline-flex;gap:10px;align-items:center;border:1px solid #e4e4e7;border-radius:8px;padding:8px 12px;font-size:14px}.file span{font-size:11px;color:#fff;background:#e5484d;border-radius:3px;padding:1px 5px}
.note{max-width:860px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>${body}<div class="note">${escapeHtml(note)}</div></body></html>`
const msg = (who, color, text, { app = false, reply = false } = {}) => `<div class="msg${reply ? ' reply' : ''}"><div class="av" style="background:${color}">${escapeHtml(who[0])}</div><div><div class="who">${escapeHtml(who)}${app ? ' <span>APP</span>' : ''}</div><div class="text">${text}</div></div></div>`
const SLACK_NOTE = 'The message exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).'

async function schedule(page, h, agent, { kind = 'days', every, unit, time = '07:00', days = 'Weekdays (Monday to Friday)', zone = 'Europe/Amsterdam', channel, message, shotName }) {
  await page.goto(`/agents/${agent}/schedule`)
  await h.wait(1500)
  await page.locator('#schedule-kind').click()
  await page.getByRole('option', { name: kind === 'days' ? 'At a time of day' : 'Every few minutes or hours' }).click()
  if (kind === 'days') {
    await page.locator('#schedule-days').click()
    await page.getByRole('option', { name: days }).click()
    await page.locator('input#schedule-time').fill(time)
    await page.locator('#schedule-timezone').click()
    await page.getByRole('option', { name: zone }).first().click()
  } else {
    await page.getByRole('spinbutton', { name: 'Every' }).fill(String(every))
    await page.getByRole('combobox', { name: 'Unit' }).click()
    await page.getByRole('option', { name: unit, exact: true }).click()
  }
  await page.getByRole('combobox', { name: 'Where' }).click()
  await page.getByRole('option', { name: /Slack/ }).first().click()
  await h.wait(800)
  await page.locator('#schedule-destination').click()
  await page.getByRole('option', { name: new RegExp(channel) }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill(message)
  if (shotName) { await h.top(page.locator('#schedule-days'), 60); await h.shot(shotName) }
  await page.getByRole('button', { name: 'Save schedule' }).click()
  await h.wait(2000)
}

// A schedule's real run, posted to Slack: every minute until it posts, then back to the real time.
async function scheduledPost(page, h, agent, { channel, message, match, real }) {
  const before = (await upstream('/_admin/state')).outbox.length
  await schedule(page, h, agent, { kind: 'interval', every: 1, unit: 'minutes', channel, message })
  const post = await until(`the scheduled post in #${channel}`, async () => (await upstream('/_admin/state')).outbox.slice(before).find((o) => o.url.includes('chat.postMessage') && match.test(o.body?.text ?? ''))?.body.text, 300000)
  await schedule(page, h, agent, { ...real, channel, message })
  return post
}

// ---------- 1. Stripe payouts against Xero (stripe-payout-reconciliation) ----------
const XERO_TENANT = '7a3c51e2-0d4b-4c7e-9a52-6f1e8b2d4c90'
const PAYOUT_INSTRUCTIONS = `You check Larkspur Home's Stripe payouts against Xero every morning and report only what needs a person.

1. List yesterday's Stripe payouts: status "paid", arrival_date set to yesterday 00:00 UTC as a Unix timestamp. Stripe pays out once a day per currency (EUR, GBP and USD).
2. For each payout, list its balance transactions (payout set to the payout id, limit 100) and add up the charges, refunds and fees.
3. In Xero, list the bank transactions with xero-tenant-id ${XERO_TENANT} and where set to: Type=="RECEIVE" AND Contact.Name=="Stripe" AND Date>=DateTime(yesterday's year, month, day).
4. Match each payout to the Xero transaction whose Reference is the payout id. It matches when the Xero total equals the payout amount to the cent.
5. Report the payouts that need a look first: not in Xero, or a different amount (give the difference and the breakdown from step 2). Then the ones that match, one line each. Then every refund of 500 or more in any currency, with the order number.

You only read. Never create, change or delete anything in Stripe or Xero.`

SHOTS['pay-00'] = ['stripe-payout-reconciliation/00-slack-report.png', 'The morning payout check in #finance-ops', SLACK_RENDER]; RENDERED['pay-00'] = '/agents/:id/schedule'
SHOTS['pay-01'] = ['stripe-payout-reconciliation/01-stripe-link.png', "Stripe's API description link", NEW_API]
SHOTS['pay-02'] = ['stripe-payout-reconciliation/02-stripe-key.png', 'The Stripe restricted key, saved as the username', SETUP]
SHOTS['pay-03'] = ['stripe-payout-reconciliation/03-xero-sign-in.png', 'Xero sign-in: client ID, secret and one scope', SETUP]
SHOTS['pay-04'] = ['stripe-payout-reconciliation/04-agent.png', 'Payout check: instructions', BUILDER]
SHOTS['pay-05'] = ['stripe-payout-reconciliation/05-tools.png', 'Payout check: three read-only tools', BUILDER]
SHOTS['pay-06'] = ['stripe-payout-reconciliation/06-try.png', 'Payout check: a test run', AGENT]
SHOTS['pay-07'] = ['stripe-payout-reconciliation/07-run-steps.png', 'Payout check: the Stripe and Xero calls of the run', AGENT]
SHOTS['pay-08'] = ['stripe-payout-reconciliation/08-schedule.png', 'Schedule: weekdays at 07:00, posted to #finance-ops', SCHEDULE]

async function payouts(page, h) {
  await connectModel(page, h)
  if (sql(`SELECT count(*) FROM apis WHERE name = 'Stripe' AND "organizationId" = '${orgOf()}'`) === '0') {
    await importApi(page, h, { link: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json', name: 'Stripe', address: `${UP}/stripe`, linkShot: 'pay-01' })
    // Stripe's description offers a bearer token next to basic auth; almyty picks the token.
    await page.getByTestId('api-key-sent-as').getByText('Sent as a bearer token').waitFor({ timeout: 15000 })
    await page.getByRole('button', { name: 'Create one here' }).first().click()
    await h.wait(800)
    await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Stripe restricted key (read only)')
    await page.getByRole('textbox', { name: /token|key/i }).last().fill('local-demo-stripe-restricted-key')
    await h.shot('pay-02')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
  }
  if (sql(`SELECT count(*) FROM apis WHERE name = 'Xero Accounting' AND "organizationId" = '${orgOf()}'`) === '0') {
    await importApi(page, h, { link: 'https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml', name: 'Xero Accounting', address: `${UP}/xero/api.xro/2.0` })
    await page.getByRole('button', { name: 'Create one here' }).click()
    await page.getByLabel('Client ID').fill('3F9A1C0E7B2D4E5F8A6B9C0D1E2F3A4B')
    await page.getByLabel('Client secret').fill('local-test-xero-client-secret')
    await page.getByTestId('api-oauth-redirect').waitFor({ timeout: 10000 })
    for (const cb of await page.getByTestId('api-oauth-scopes').getByRole('checkbox').all()) {
      const scope = (await cb.getAttribute('aria-label')) || ''
      if (scope === 'accounting.transactions.read') await cb.check(); else await cb.uncheck()
    }
    await page.getByTestId('api-oauth-scopes').getByRole('checkbox', { name: 'accounting.transactions.read', exact: true }).evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await h.top(page.getByTestId('api-oauth-redirect'))
    await h.shot('pay-03')
    await page.getByRole('button', { name: 'Paste an access token instead' }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Xero (Larkspur Home B.V.)')
    await page.getByRole('textbox', { name: 'Access token' }).fill('local-test-xero-token')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
  }
  await newAgent(page, { name: 'Payout check', personality: 'Precise and brief, like a good bookkeeper. Amounts always with currency and two decimals.', instructions: PAYOUT_INSTRUCTIONS })
  await h.toTop()
  await h.shot('pay-04')
  await pickTools(page, ['stripe_get_payouts', 'stripe_get_balance_transactions', 'xero_accounting_get_bank_transactions'])
  await page.getByText('Tools and APIs').first().scrollIntoViewIfNeeded()
  await h.shot('pay-05')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, "Check yesterday's payouts.", /need a look|match Xero|could not/, 'pay-06')
  await runSteps(page, h, agent, 'pay-07')
  await slackChannel(page, h, agent)
  const real = { kind: 'days', time: '07:00', days: 'Weekdays (Monday to Friday)', zone: 'Europe/Amsterdam' }
  await schedule(page, h, agent, { ...real, channel: 'finance-ops', message: "Check yesterday's payouts.", shotName: 'pay-08' })
  const post = await scheduledPost(page, h, agent, { channel: 'finance-ops', message: "Check yesterday's payouts.", match: /need a look|match Xero/, real })
  await h.render('pay-00', PAGE('Slack messages', `<div class="wrap"><div class="chan"># finance-ops</div>${msg('Payout check', '#0891b2', slackHtml(post), { app: true })}</div>`, SLACK_NOTE))
}

// ---------- 2. Ask the data warehouse in Slack (nl-query-your-database) ----------
const ASK_INSTRUCTIONS = `You answer questions about Larkspur Home's shop data from BigQuery (project larkspur-analytics, dataset shop), for colleagues in Slack.

Tables:
- shop.orders: order_id, created_at, customer_id, shipping_country (ISO code, for example DE), channel (web or app), status (paid, shipped, delivered, cancelled), total_eur, shipped_at
- shop.order_items: order_id, sku, quantity, line_total_eur
- shop.products: sku, name, category, price_eur
- shop.payments: payment_id, order_id, created_at, payment_method, amount_eur, status

For every question:
1. Write one standard SQL SELECT and run it with the query tool: projectId larkspur-analytics, defaultDataset with projectId larkspur-analytics and datasetId shop, useLegacySql false, maximumBytesBilled 1000000000, maxResults 100. Name tables without project or backticks, like orders.
2. Answer in one or two sentences with the numbers, then show the query you ran in a code block, so anyone can check it.

"Last week" means Monday to Sunday of the previous week. Money is in euros.
Only ever run SELECT. If someone asks you to change or delete data, say that you only read, and run nothing.`

SHOTS['ask-00'] = ['nl-query-your-database/00-slack-answer.png', 'A question in #ask-data, answered with the number and the query', SLACK_RENDER]; RENDERED['ask-00'] = '/agents/:id/channels/:id'
SHOTS['ask-01'] = ['nl-query-your-database/01-bigquery-link.png', 'BigQuery API description link', NEW_API]
SHOTS['ask-02'] = ['nl-query-your-database/02-google-sign-in.png', 'Google sign-in for BigQuery: one read-only scope', SETUP]
SHOTS['ask-03'] = ['nl-query-your-database/03-agent.png', 'Data questions: instructions with the tables', BUILDER]
SHOTS['ask-04'] = ['nl-query-your-database/04-tools.png', 'Data questions: the BigQuery query tool', BUILDER]
SHOTS['ask-05'] = ['nl-query-your-database/05-try.png', 'Data questions: best sellers, with the query', AGENT]
SHOTS['ask-06'] = ['nl-query-your-database/06-try-delete.png', 'Data questions: a request to delete data, refused', AGENT]
SHOTS['ask-07'] = ['nl-query-your-database/07-slack-live.png', 'Slack channel for Data questions, live', CHANNEL]
SHOTS['ask-08'] = ['nl-query-your-database/08-access.png', 'Access: let the agent use BigQuery for everyone who asks', [...AGENT, 'frontend/src/components/agents/builder/capabilities-section.tsx']]

async function connectBigQuery(page, h, { linkShot, signInShot } = {}) {
  if (sql(`SELECT count(*) FROM apis WHERE name = 'BigQuery' AND "organizationId" = '${orgOf()}'`) !== '0') return
  await page.goto('/apis/new/openapi')
  await page.getByLabel('Link to the description').fill('https://www.googleapis.com/discovery/v1/apis/bigquery/v2/rest')
  if (linkShot) await h.shot(linkShot)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill('BigQuery')
  await page.getByLabel('Address', { exact: true }).fill(`${UP}/bigquery/v2`)
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 90000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 180000 })
  await h.wait(800)
  await page.getByRole('button', { name: 'Create one here' }).click()
  await page.getByLabel('Client ID').fill('482910375521-lh0data7questions.apps.googleusercontent.com')
  await page.getByLabel('Client secret').fill('GOCSPX-local-test-secret')
  await page.getByTestId('api-oauth-redirect').waitFor({ timeout: 10000 })
  for (const cb of await page.getByTestId('api-oauth-scopes').getByRole('checkbox').all()) {
    const scope = (await cb.getAttribute('aria-label')) || ''
    if (/cloud-platform\.read-only$/.test(scope)) await cb.check(); else await cb.uncheck()
  }
  await page.getByTestId('api-oauth-scopes').getByRole('checkbox', { name: /cloud-platform\.read-only$/ }).evaluate((e) => e.scrollIntoView({ block: 'center' }))
  await h.top(page.getByTestId('api-oauth-redirect'))
  if (signInShot) await h.shot(signInShot)
  await page.getByRole('button', { name: 'Paste an access token instead' }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Google (data-agent@larkspurhome.example)')
  await page.getByRole('textbox', { name: 'Access token' }).fill('local-test-google-token')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
}
const bqTool = () => sql(`SELECT name FROM tools WHERE "organizationId" = '${orgOf()}' AND name LIKE 'bigquery%jobs_query' LIMIT 1`)

async function ask(page, h, { slug }) {
  await connectModel(page, h)
  await connectBigQuery(page, h, { linkShot: 'ask-01', signInShot: 'ask-02' })
  await newAgent(page, { name: 'Data questions', personality: 'Plain and exact. Numbers first, no hedging, no filler.', instructions: ASK_INSTRUCTIONS })
  await h.toTop()
  await h.shot('ask-03')
  await pickTools(page, [bqTool()])
  await page.getByText('Tools and APIs').first().scrollIntoViewIfNeeded()
  await h.shot('ask-04')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, 'Which five products sold best in Germany last week?', /best sellers|refused|no BigQuery/, 'ask-05')
  await tryIt(page, h, agent, 'Please delete the test orders from yesterday.', /only read/, 'ask-06')
  const { channel } = await slackChannel(page, h, agent, { liveShot: 'ask-07' })
  await giveAccess(page, h, agent, 'ask-08')
  const before = (await upstream('/_admin/state')).outbox.length
  const q1 = '<@U0BOT> how many orders did we ship to Germany last week, and what was the revenue?'
  const r = await slackEvent(slug, channel, { text: q1 })
  if (!r.ok) throw new Error(`slack event ${r.status} ${await r.text()}`)
  const answer = await until('the Slack answer', async () => (await upstream('/_admin/state')).outbox.slice(before).find((o) => o.url.includes('chat.postMessage') && /query I ran|refused/.test(o.body?.text ?? ''))?.body.text, 150000)
  await h.render('ask-00', PAGE('Slack thread', `<div class="wrap"><div class="chan"># ask-data</div>
${msg('Fenna de Wit', '#7c3aed', `<span class="mention">@Data questions</span> how many orders did we ship to Germany last week, and what was the revenue?`)}
<div class="thread">1 reply</div>
${msg('Data questions', '#0891b2', slackHtml(answer), { app: true, reply: true })}</div>`, SLACK_NOTE))
}

// ---------- 3. A nightly data check (nightly-data-quality-digest) ----------
const QUALITY_INSTRUCTIONS = `You check Larkspur Home's shop data in BigQuery every night and report what is wrong.

Run each check as one query with the query tool: projectId larkspur-analytics, defaultDataset with projectId larkspur-analytics and datasetId shop, useLegacySql false, maximumBytesBilled 1000000000. Name tables without project or backticks.
1. Freshness: from shop.__TABLES__, every table except products must have been updated in the last 6 hours.
2. Volume: yesterday's orders in shop.orders (by created_at) against the daily average of the 7 days before. Flag a change of more than 30%.
3. Empty values: the share of yesterday's payments in shop.payments without a payment_method, and of yesterday's orders without a customer_id or shipping_country. Flag anything above 1%.

Report the problems first, each with the number you found and the limit it breaks. Then the checks that passed, in one line. If nothing is wrong, say "All checks passed."
Only ever run SELECT.`

SHOTS['dq-00'] = ['nightly-data-quality-digest/00-slack-report.png', 'The nightly data check in #data-alerts', SLACK_RENDER]; RENDERED['dq-00'] = '/agents/:id/schedule'
SHOTS['dq-01'] = ['nightly-data-quality-digest/01-agent.png', 'Data check: the three checks as instructions', BUILDER]
SHOTS['dq-02'] = ['nightly-data-quality-digest/02-try.png', 'Data check: a test run finds two problems', AGENT]
SHOTS['dq-03'] = ['nightly-data-quality-digest/03-run-steps.png', 'Data check: the three queries of the run', AGENT]
SHOTS['dq-04'] = ['nightly-data-quality-digest/04-schedule.png', 'Schedule: every day at 06:30, posted to #data-alerts', SCHEDULE]

async function quality(page, h) {
  await connectModel(page, h)
  await connectBigQuery(page, h)
  await newAgent(page, { name: 'Data check', personality: 'Short and factual. Problems first, with numbers.', instructions: QUALITY_INSTRUCTIONS })
  await pickTools(page, [bqTool()])
  await h.toTop()
  await h.shot('dq-01')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, 'Run the nightly checks.', /Shop data check|failed|no BigQuery/, 'dq-02')
  await runSteps(page, h, agent, 'dq-03')
  await slackChannel(page, h, agent)
  const real = { kind: 'days', time: '06:30', days: 'Every day', zone: 'Europe/Amsterdam' }
  await schedule(page, h, agent, { ...real, channel: 'data-alerts', message: 'Run the nightly checks.', shotName: 'dq-04' })
  const post = await scheduledPost(page, h, agent, { channel: 'data-alerts', message: 'Run the nightly checks.', match: /Shop data check/, real })
  await h.render('dq-00', PAGE('Slack messages', `<div class="wrap"><div class="chan"># data-alerts</div>${msg('Data check', '#0891b2', slackHtml(post), { app: true })}</div>`, SLACK_NOTE))
}

// ---------- 4. Contract review by a panel of models (cross-vendor-contract-review) ----------
const CONTRACT_INSTRUCTIONS = `You review supplier contracts for Larkspur Home B.V., an online homeware shop in Amsterdam, before anyone signs them.

When someone attaches a contract, write a risk memo:
1. One line: sign as drafted, or not yet.
2. "Must change before signing": the clauses that put real money or data at risk.
3. "Worth negotiating": the rest.
For each clause give its number, what it says in one sentence, why it matters to us, and what to ask for instead. Use the contract's own numbers and dates.
Then say where the readers disagreed.

This memo prepares the conversation with our lawyer. It is not legal advice, and you never say a contract is safe to sign.`

SHOTS['con-00'] = ['cross-vendor-contract-review/00-slack-memo.png', 'The risk memo for the Northgate draft, in a Slack thread', SLACK_RENDER]; RENDERED['con-00'] = '/agents/:id/channels/:id'
SHOTS['con-01'] = ['cross-vendor-contract-review/01-connect-anthropic.png', 'Connect a second provider: Anthropic', MODELS]
SHOTS['con-02'] = ['cross-vendor-contract-review/02-agent.png', 'Contract review: instructions', BUILDER]
SHOTS['con-03'] = ['cross-vendor-contract-review/03-panel.png', 'Work mode Panel: a main model, two panelists from two vendors, a judge', BUILDER]
SHOTS['con-04'] = ['cross-vendor-contract-review/04-panelist-angle.png', "A panelist's extra instructions: read it as the supplier's lawyer", BUILDER]
SHOTS['con-05'] = ['cross-vendor-contract-review/05-slack-live.png', 'Slack channel for Contract review, live', CHANNEL]
SHOTS['con-06'] = ['cross-vendor-contract-review/06-run-roles.png', 'The run: what each model did and what it cost', AGENT]

const PANEL = [
  { slot: 'main', model: /gpt-4o(?!-mini)/ },
  { slot: 'panelist_1', model: /claude-sonnet-4-5/, name: 'Northgate side', instructions: "Read the contract as Northgate's lawyer: which clauses they will defend hardest, and where they can give way." },
  { slot: 'panelist_2', model: /gpt-4\.1/, name: 'Dutch and EU law', instructions: 'Check the contract against Dutch and EU law: GDPR (a data processing agreement, sub-processors), governing law and courts, and clauses a Dutch court may not enforce.' },
]

const JUDGE = { slot: 'judge', name: 'Judge', instructions: 'Do not pick one reading. Combine every clause the readers raised into one risk memo: one line (sign as drafted, or not yet), then "Must change before signing", then "Worth negotiating", each with the clause number, what it says, why it matters and what to ask for. End with where the readers disagreed.' }

async function pickSlotModel(page, slot, model) {
  const card = page.getByTestId(`slot-${slot}`)
  await card.getByRole('combobox').first().click()
  await page.getByRole('option', { name: model }).first().click()
  await page.waitForTimeout(400)
}

async function contract(page, h, { slug }) {
  await connectModel(page, h)
  await connectModel(page, h, { name: 'Anthropic', provider: 'Anthropic', key: 'sk-ant-local-demo-key', shotName: 'con-01' })
  const pdf = join(OUT, 'northgate-fulfilment-agreement.pdf')
  if (!existsSync(pdf)) {
    const p2 = await page.context().newPage()
    await p2.goto(`file://${join(dirname(fileURLToPath(import.meta.url)), 'data-contract.html')}`)
    await p2.pdf({ path: pdf, format: 'A4', margin: { top: '22mm', bottom: '22mm', left: '22mm', right: '22mm' } })
    await p2.close()
  }
  await newAgent(page, { name: 'Contract review', personality: 'Plain English, no legalese. Short sentences. Numbers exactly as the contract has them.', instructions: CONTRACT_INSTRUCTIONS })
  await h.toTop()
  await h.shot('con-02')
  await page.getByTestId('work-mode-select').click()
  await page.getByRole('option', { name: 'Panel' }).click()
  await h.wait(800)
  for (const p of PANEL.slice(1)) await pickSlotModel(page, p.slot, p.model)
  await page.getByRole('button', { name: /Add a judge/ }).click()
  await h.wait(500)
  await pickSlotModel(page, 'judge', /claude-sonnet-4-5/)
  for (const p of [...PANEL.slice(1), JUDGE]) {
    const card = page.getByTestId(`slot-${p.slot}`)
    await card.getByRole('button', { name: /Name, sampling, extra instructions/ }).click()
    await page.locator(`#role-${p.slot}-name`).fill(p.name)
    await page.locator(`#role-${p.slot}-instructions`).fill(p.instructions)
  }
  await h.top(page.getByTestId('work-mode-card'), 90)
  await h.shot('con-03')
  await h.top(page.getByTestId('slot-panelist_1'), 90)
  await h.shot('con-04')
  const agent = await saveAndActivate(page, h)
  const { channel } = await slackChannel(page, h, agent, { liveShot: 'con-05' })
  await upstream('/_admin/reset', { method: 'POST' })
  const text = '<@U0BOT> Northgate sent their draft for the Venlo warehouse. Can you review it before my call with them on Friday?'
  const file = { id: 'F0NGF0412', name: 'northgate-fulfilment-agreement.pdf', title: 'northgate-fulfilment-agreement.pdf', mimetype: 'application/pdf', filetype: 'pdf', size: readFileSync(pdf).length, url_private: 'https://files.slack.com/files-pri/T0LARKSPUR-F0NGF0412/northgate-fulfilment-agreement.pdf', url_private_download: 'https://files.slack.com/files-pri/T0LARKSPUR-F0NGF0412/download/northgate-fulfilment-agreement.pdf' }
  const r = await slackEvent(slug, channel, { text, channel: 'C0LEGAL', user: 'U0INES', files: [file] })
  if (!r.ok) throw new Error(`slack event ${r.status} ${await r.text()}`)
  const answer = await until('the memo in Slack', async () => (await upstream('/_admin/state')).outbox.find((o) => o.url.includes('chat.postMessage') && /Risk memo|cannot see a contract/.test(o.body?.text ?? ''))?.body.text, 240000)
  await h.render('con-00', PAGE('Slack thread', `<div class="wrap"><div class="chan"># legal-review</div>
${msg('Ines Duarte', '#7c3aed', `<span class="mention">@Contract review</span> Northgate sent their draft for the Venlo warehouse. Can you review it before my call with them on Friday?<div class="file"><b>northgate-fulfilment-agreement.pdf</b><span>PDF</span></div>`)}
<div class="thread">1 reply</div>
${msg('Contract review', '#0891b2', slackHtml(answer), { app: true, reply: true })}</div>`, SLACK_NOTE))
  await runSteps(page, h, agent, 'con-06')
}

// ---------- 5. Cap AI spending (govern-ai-spend) ----------
const COPY_INSTRUCTIONS = `You write product descriptions for new products in the Larkspur Home shop.

For each product in the message, write a bold product name and one paragraph of 50 to 70 words: what it is made of, its size, how to care for it. Plain and warm, no superlatives, no exclamation marks. Never invent a material, a size or a certificate the message does not give.`
const COPY_MESSAGE = 'Write product descriptions for: oak serving board (FSC European oak, linseed oil, fits a cheese board for six); linen napkins (set of 4, stonewashed, 45x45 cm, 40 degree wash); ceramic pendant lamp (chalk glaze, 28 cm, 1.5 m cotton cord, E27 up to 60 W).'

SHOTS['spend-00'] = ['govern-ai-spend/00-budgets.png', 'Two budgets and the alert from the one that blocked', ANALYTICS]
SHOTS['spend-01'] = ['govern-ai-spend/01-cost.png', 'Analytics, Cost: spend per day and per agent', ANALYTICS]
SHOTS['spend-02'] = ['govern-ai-spend/02-org-budget.png', 'New budget: the whole organization, $300 a month, warn only', BUDGET]
SHOTS['spend-03'] = ['govern-ai-spend/03-agent-budget.png', 'New budget: one agent, $5 a day, block new runs', BUDGET]
SHOTS['spend-04'] = ['govern-ai-spend/04-run-limit.png', 'Run limits: a spending cap of $0.50 per run', BUILDER]
SHOTS['spend-05'] = ['govern-ai-spend/05-blocked.png', 'A run refused because the daily budget is used up', AGENT]
SHOTS['spend-06'] = ['govern-ai-spend/06-notification.png', 'The alert in notifications', ['frontend/src/pages/notifications.tsx']]

async function budgetForm(page, h, { scope, agent, limit, period, behavior, warn = '80', shotName, edit }) {
  if (!edit) await page.goto('/analytics/budgets/new')
  await h.wait(1200)
  if (!edit) {
    await page.locator('#budget-scope').click()
    await page.getByRole('option', { name: scope === 'agent' ? 'A single agent' : 'The whole organization' }).click()
    if (scope === 'agent') {
      await page.locator('#budget-agent').click()
      await page.getByRole('option', { name: agent }).click()
    }
  }
  await page.locator('#budget-limit').fill(limit)
  if (period) {
    await page.locator('#budget-period').click()
    await page.getByRole('option', { name: period }).click()
  }
  if (behavior) {
    await page.locator('#budget-behavior').click()
    await page.getByRole('option', { name: behavior }).click()
  }
  await page.locator('#budget-soft-threshold').fill(warn)
  if (shotName) { await h.toTop(); await h.shot(shotName) }
  await page.getByRole('button', { name: edit ? 'Save budget' : 'Create budget' }).click()
  await h.wait(2000)
}

async function spend(page, h) {
  await connectModel(page, h)
  await newAgent(page, { name: 'Product copy drafts', personality: 'Warm and plain.', instructions: COPY_INSTRUCTIONS })
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, COPY_MESSAGE, /Oak serving board/)
  await page.goto('/analytics/cost')
  await h.wait(2500)
  await h.shot('spend-01')
  await budgetForm(page, h, { scope: 'org', limit: '300', period: 'Per month', behavior: 'Warn only', shotName: 'spend-02' })
  await budgetForm(page, h, { scope: 'agent', agent: 'Product copy drafts', limit: '5', period: 'Per day', behavior: 'Block new runs', shotName: 'spend-03' })
  // the per-run cap, on the agent's edit page
  await page.goto(`/agents/${agent}/edit`)
  await h.wait(2000)
  const limits = page.getByText('Run limits', { exact: true }).first()
  await limits.scrollIntoViewIfNeeded()
  await page.getByRole('button', { name: /Change steps, cost, time/ }).click()
  await page.locator('#run-limit-cost').fill('0.50')
  await h.top(limits, 100)
  await h.shot('spend-04')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await h.wait(2500)
  // See the block work: lower the agent's budget below what it already spent today, try it, then put it back.
  await page.goto('/analytics/budgets')
  await h.wait(1500)
  const editLinks = page.getByRole('link', { name: 'Edit budget' })
  const n = await editLinks.count()
  let agentBudget = null
  for (let i = 0; i < n; i++) {
    const row = editLinks.nth(i).locator('xpath=ancestor::tr')
    if (/Product copy drafts/.test(await row.innerText().catch(() => ''))) { agentBudget = editLinks.nth(i); break }
  }
  await agentBudget.click()
  await budgetForm(page, h, { limit: '0.02', edit: true })
  for (let i = 0; i < 10; i++) {
    await page.goto(`/agents/${agent}`)
    await h.wait(1500)
    const box = page.getByPlaceholder('Type a message to test this agent...')
    await box.fill(COPY_MESSAGE)
    await box.press('Enter')
    await h.wait(7000)
    const said = await page.locator('main').innerText()
    if (/budget/i.test(said)) break
  }
  await h.top(page.getByText('Try it', { exact: true }).first(), 90)
  await h.shot('spend-05')
  await page.goto('/notifications')
  await h.wait(2000)
  await h.shot('spend-06')
  // back to the real limit
  await page.goto('/analytics/budgets')
  await h.wait(1500)
  for (let i = 0; i < n; i++) {
    const link = page.getByRole('link', { name: 'Edit budget' }).nth(i)
    if (/Product copy drafts/.test(await link.locator('xpath=ancestor::tr').innerText().catch(() => ''))) { await link.click(); break }
  }
  await budgetForm(page, h, { limit: '5', edit: true })
  await page.goto('/analytics/budgets')
  await h.wait(2500)
  await h.shot('spend-00')
}

// ---------- run ----------
async function walk(names, { fresh }) {
  if (fresh) {
    sql(`DELETE FROM organizations WHERE id IN (SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${INES.email}')`)
    sql(`DELETE FROM users WHERE email = '${INES.email}'`)
  }
  const { slug } = await account()
  const browser = await chromium.launch()
  const { ctx, page } = await session(browser)
  const h = helpers(page)
  try {
    if (names.includes('payouts')) await payouts(page, h, { slug })
    if (names.includes('ask')) await ask(page, h, { slug })
    if (names.includes('quality')) await quality(page, h, { slug })
    if (names.includes('contract')) await contract(page, h, { slug })
    if (names.includes('spend')) await spend(page, h, { slug })
  } catch (e) {
    console.log('FAILED', e.message.split('\n').slice(0, 3).join(' | '))
    await page.screenshot({ path: join(OUT, 'FAILED.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    await ctx.close()
    await browser.close()
  }
}

function register(shots) {
  for (const shot of shots.length ? shots : Object.keys(SHOTS)) {
    const c = results[shot]
    if (!c) { console.log('not captured', shot); continue }
    const [path, title, sources] = SHOTS[shot]
    const route = c.route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
    const notes = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed/usecases/data-guides.mjs): real public API descriptions, a local stand-in for Stripe, Xero, BigQuery and Slack, and scripted stand-in models; fictional people and companies. Not staging or production data.' +
      (RENDERED[shot] ? ' The page renders the message exactly as almyty handed it to Slack; Slack itself was not used.' : '')
    execFileSync(process.execPath, [join(ROOT, 'docs-site/scripts/record-screenshot.mjs'), '--image', c.file, '--path', `screenshots/examples/${path}`, '--title', title, '--captured-at', c.at, '--route', route, '--environment', 'local-demo',
      '--notes', notes, ...sources.flatMap((s) => ['--sources', s])], { stdio: 'inherit' })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--register') register(args.slice(1))
else {
  const fresh = args.includes('--fresh')
  const names = args.filter((a) => a !== '--fresh')
  await walk(names.length ? names : ['payouts', 'quality', 'ask', 'contract', 'spend'], { fresh })
}
