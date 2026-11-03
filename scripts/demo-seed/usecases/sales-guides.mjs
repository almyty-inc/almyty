#!/usr/bin/env node
// Walks five example guides in docs-site/content/examples through the UI,
// step by step as their text says, and takes the screenshots they show:
// docs-deflection-bot, lead-enrichment-routing, meeting-notes-to-crm,
// agent-that-remembers and connect-google-sharepoint.
//
// It needs the demo stack started with USECASES=1 and sales-upstream.mjs
// already listening on USECASE_PORT (start it before stack.sh, which then
// leaves its own stand-in off): the stand-in for Intercom, HubSpot, Google
// Drive and Slack, and the scripted model in sales-model.mjs. Nothing
// reaches a real account and every run answers the same way.
//
// It works as Sofia Marques, head of sales at Parcelwise (made up), in an
// organization of her own. What differs from a real account, because the
// stand-in is on localhost: the organization allows localhost, the API
// addresses are set to the stand-in under Advanced, the model key is sent
// with the stand-in's address, Google's sign-in page is never opened (a
// token is pasted instead), and Slack messages are shown as the stand-in
// received them, rendered as a page. The API descriptions are the real
// public ones, read from their links as a user would.
//
//   node scripts/demo-seed/usecases/sales-guides.mjs [--fresh] [docs leads notes memory drive]
//   node scripts/demo-seed/usecases/sales-guides.mjs --register [shot...]
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
const UP = process.env.DEMO_USECASE_URL || 'http://localhost:4292'
const PSQL = process.env.DEMO_PSQL || 'docker exec -i almyty-demo-pg psql -U postgres -d almyty_qa'
const OUT = join(process.env.SHOT_DIR || '/tmp/almyty-demo/shots', 'examples')
mkdirSync(OUT, { recursive: true })

const SOFIA = { email: 'sofia.marques@parcelwise.example', password: 'Parcelwise-2026!', firstName: 'Sofia', lastName: 'Marques', organizationName: 'Parcelwise' }
const SLACK_SIGNING_SECRET = 'local-test-signing-secret-parcelwise-01'
const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()
const upstream = async (path, init) => (await fetch(`${UP}${path}`, init)).json()
// Sofia's organization: these checks are hers, not another walk's on the same stack
// (the biz-dev tutorial makes a "HubSpot private app" and "HubSpot Companies" too).
const orgOf = () => sql(`SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${SOFIA.email}' LIMIT 1`)

// The shared UI (components/ui, components/layout, index.css) is never a source: check-screenshots rejects it as too broad.
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const NEW_API = ['frontend/src/pages/api-new.tsx']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const SCHEDULE = ['frontend/src/pages/agent-schedule.tsx']
const MODELS = ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']
const SLACK_RENDER = ['backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']

// shot: [published path under screenshots/examples, title, sources]
export const SHOTS = {
  'docs-00': ['docs-deflection-bot/00-slack-thread.png', 'Docs assistant answering in a Slack thread', SLACK_RENDER],
  'docs-01': ['docs-deflection-bot/01-connect-model.png', 'Connect a provider: OpenAI', MODELS],
  'docs-02': ['docs-deflection-bot/02-intercom-link.png', 'Intercom API description link', NEW_API],
  'docs-03': ['docs-deflection-bot/03-intercom-token.png', 'Intercom access token', SETUP],
  'docs-04': ['docs-deflection-bot/04-agent.png', 'Docs assistant: model and instructions', BUILDER],
  'docs-05': ['docs-deflection-bot/05-tools.png', 'Docs assistant: Intercom tools', BUILDER],
  'docs-06': ['docs-deflection-bot/06-try-answer.png', 'Docs assistant: an answer with its source', AGENT],
  'docs-07': ['docs-deflection-bot/07-try-ticket.png', 'Docs assistant: a docs gap ticket', AGENT],
  'docs-08': ['docs-deflection-bot/08-slack-keys.png', 'Slack channel: bot token and signing secret', CHANNEL],
  'docs-09': ['docs-deflection-bot/09-slack-live.png', 'Slack channel, live', CHANNEL],
  'docs-10': ['docs-deflection-bot/10-access.png', 'Access: let the agent use Intercom for everyone who asks', [...AGENT, 'frontend/src/components/agents/builder/capabilities-section.tsx']],
  'leads-00': ['lead-enrichment-routing/00-slack-hot-leads.png', 'Hot leads posted to Slack', SLACK_RENDER],
  'leads-01': ['lead-enrichment-routing/01-hubspot-link.png', 'HubSpot Contacts description link', NEW_API],
  'leads-02': ['lead-enrichment-routing/02-hubspot-token.png', 'HubSpot private app token', SETUP],
  'leads-03': ['lead-enrichment-routing/03-apis.png', 'HubSpot Contacts, Companies and Owners connected', ['frontend/src/pages/apis.tsx']],
  'leads-04': ['lead-enrichment-routing/04-agent.png', 'Lead scorer: instructions with the scoring rules', BUILDER],
  'leads-05': ['lead-enrichment-routing/05-tools.png', 'Lead scorer: HubSpot tools', BUILDER],
  'leads-06': ['lead-enrichment-routing/06-try.png', 'Lead scorer: a test run', AGENT],
  'leads-07': ['lead-enrichment-routing/07-run-steps.png', 'Lead scorer: what the run did in HubSpot', AGENT],
  'leads-08': ['lead-enrichment-routing/08-slack-live.png', 'Slack channel for the lead scorer, live', CHANNEL],
  'leads-09': ['lead-enrichment-routing/09-schedule.png', 'Schedule: every hour, posted to #sales-leads', SCHEDULE],
  'leads-10': ['lead-enrichment-routing/10-schedule-card.png', 'The schedule on the agent page', AGENT],
  'notes-00': ['meeting-notes-to-crm/00-result.png', 'Call notes turned into HubSpot updates and an email draft', AGENT],
  'notes-01': ['meeting-notes-to-crm/01-notes-link.png', 'HubSpot Notes description link', NEW_API],
  'notes-02': ['meeting-notes-to-crm/02-pick-key.png', 'HubSpot Notes: pick the saved key', SETUP],
  'notes-03': ['meeting-notes-to-crm/03-apis.png', 'HubSpot Deals, Notes and Tasks connected', ['frontend/src/pages/apis.tsx']],
  'notes-04': ['meeting-notes-to-crm/04-agent.png', 'Call notes assistant: instructions', BUILDER],
  'notes-05': ['meeting-notes-to-crm/05-tools.png', 'Call notes assistant: HubSpot tools', BUILDER],
  'notes-06': ['meeting-notes-to-crm/06-run-steps.png', 'Call notes assistant: what the run changed', AGENT],
  'memory-00': ['agent-that-remembers/00-second-run.png', 'A later run using what it remembered', AGENT],
  'memory-01': ['agent-that-remembers/01-instructions.png', 'Account notes: instructions', BUILDER],
  'memory-02': ['agent-that-remembers/02-memory-settings.png', 'Account notes: memory settings', BUILDER],
  'memory-03': ['agent-that-remembers/03-first-run.png', 'Account notes: first run stores facts', AGENT],
  'memory-04': ['agent-that-remembers/04-memory-tab.png', 'What the agent remembers', AGENT],
  'memory-05': ['agent-that-remembers/05-org-memory.png', 'Memory in the sidebar: everything the organization keeps', ['frontend/src/pages/memories.tsx']],
  'drive-00': ['connect-google-sharepoint/00-answer.png', 'An answer from Google Drive documents, with sources', AGENT],
  'drive-01': ['connect-google-sharepoint/01-drive-link.png', 'Google Drive description link', NEW_API],
  'drive-02': ['connect-google-sharepoint/02-drive-setup.png', 'Finish connecting Google Drive', SETUP],
  'drive-03': ['connect-google-sharepoint/03-google-sign-in.png', 'Google sign-in: client ID, secret and permissions', SETUP],
  'drive-04': ['connect-google-sharepoint/04-signed-in.png', 'Google Drive signed in', SETUP],
  'drive-05': ['connect-google-sharepoint/05-test-tool.png', 'Testing the Drive search tool', ['frontend/src/pages/tool-detail.tsx']],
  'drive-06': ['connect-google-sharepoint/06-agent.png', 'Sales documents assistant: instructions', BUILDER],
  'drive-07': ['connect-google-sharepoint/07-tools.png', 'Sales documents assistant: Drive tools', BUILDER],
}
const RENDERED = { 'docs-00': '/agents/:id/channels/:id', 'leads-00': '/agents/:id/schedule' }

// ---------- the account ----------
async function account() {
  if (sql(`SELECT count(*) FROM users WHERE email = '${SOFIA.email}'`) === '0') {
    const r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(SOFIA) })
    if (!r.ok) throw new Error(`register ${r.status} ${await r.text()}`)
  }
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${SOFIA.email}'`)
  const [orgId, slug] = sql(`SELECT o.id || '|' || o.slug FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${SOFIA.email}' AND o.name = '${SOFIA.organizationName}' LIMIT 1`).split('|')
  sql(`UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
  return { orgId, slug }
}

const HIDE = '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }'
async function session(browser) {
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'light', timezoneId: 'UTC', locale: 'en-US', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light') } catch {} })
  await ctx.route(/accounts\.google\.com|app\.hubspot\.com|app\.intercom\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Stopped before the real page (local demo).</p>' }))
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.goto('/auth/login')
  await page.locator('#email').fill(SOFIA.email)
  await page.locator('#password').fill(SOFIA.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
  // The model key goes to the stand-in instead of OpenAI.
  await page.route('**/llm-providers/connect', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    body.configuration = { ...(body.configuration || {}), apiUrl: `${UP}/openai/v1` }
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
  return { wait, shot, top, id, toTop, render }
}

async function pickTools(page, names) {
  const search = page.getByRole('textbox', { name: 'Search tools' })
  for (const t of names) {
    await search.fill(t)
    await page.waitForTimeout(400)
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
async function connectModel(page, h, shotName) {
  if (sql(`SELECT count(*) FROM llm_providers WHERE "organizationId" = (SELECT "organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${SOFIA.email}' LIMIT 1)`) !== '0') return
  await page.goto('/models/providers/new')
  await page.getByLabel('Name', { exact: true }).fill('OpenAI')
  await page.getByRole('combobox', { name: 'Provider' }).click()
  await page.getByPlaceholder('Search providers').fill('OpenAI')
  await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
  await h.wait(500)
  await page.getByLabel(/API key/).first().fill('sk-proj-0000000000000000000000000000000000000000')
  if (shotName) await h.shot(shotName)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/models\/providers\/[0-9a-f-]{36}/, { timeout: 60000 })
  await h.wait(1500)
}

async function importApi(page, h, { link, name, address, linkShot }) {
  await page.goto('/apis/new/openapi')
  await page.getByLabel('Link to the description').fill(link)
  if (linkShot) await h.shot(linkShot)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Address', { exact: true }).fill(address) // the local stand-in
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 90000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 180000 })
  await h.wait(800)
}

async function pickSignIn(page, name) {
  await page.getByRole('combobox', { name: 'Sign-in' }).click()
  await page.getByRole('option', { name }).click()
  await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
}

async function newAgent(page, { name, personality, instructions }) {
  await page.goto('/agents/new')
  await page.getByRole('button', { name: 'Autonomous' }).click()
  await page.getByRole('textbox', { name: 'Agent name' }).fill(name)
  await page.getByRole('combobox', { name: 'Model' }).first().click()
  await page.getByRole('option', { name: /gpt-4o(?!-mini)/ }).first().click()
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
  await page.getByRole('status').filter({ hasText: waitFor }).waitFor({ timeout: 120000 })
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
  await h.shot(shotName)
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

async function slackChannel(page, h, agent, { keysShot, liveShot }) {
  await page.goto(`/agents/${agent}/channels/new`)
  await h.wait(1200)
  await page.getByRole('button', { name: /^Slack/ }).click()
  await h.wait(2000)
  await page.getByRole('button', { name: /^Advanced/ }).click()
  const existing = page.getByRole('combobox').filter({ hasText: 'Pick a credential' }).last()
  let created = false
  if (sql(`SELECT count(*) FROM credentials WHERE name = 'Slack bot (Parcelwise)' AND "organizationId" = '${orgOf()}'`) === '0') {
    await page.getByRole('button', { name: 'Create one here' }).last().click()
    await page.getByRole('button', { name: 'More options' }).click()
    await page.getByRole('radio', { name: 'Bot token' }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Slack bot (Parcelwise)')
    await page.getByRole('textbox', { name: 'Bot user OAuth token' }).fill('xoxb-local-test-0000000000-222222222')
    await page.getByRole('textbox', { name: 'Signing secret' }).fill(SLACK_SIGNING_SECRET)
    await page.getByRole('textbox', { name: 'Bot user OAuth token' }).scrollIntoViewIfNeeded()
    if (keysShot) await h.shot(keysShot)
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await h.wait(4000)
    created = true
  } else {
    await existing.click()
    await page.getByRole('option', { name: /Slack bot \(Parcelwise\)/ }).click()
    await h.wait(1500)
  }
  const save = page.getByRole('button', { name: 'Save', exact: true }).last()
  if (await save.isEnabled().catch(() => false)) { await save.click(); await h.wait(2500) }
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await h.wait(3500)
  await h.toTop()
  if (liveShot) await h.shot(liveShot)
  return { channel: page.url().match(/channels\/([0-9a-f-]{36})/)[1], created }
}

function slackEvent(slug, gatewayId, { text, channel = 'C0ASKPRODUCT', user = 'U0TOM', ts }) {
  ts = ts || String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    token: 'x', team_id: 'T0PARCEL', api_app_id: 'A0APP', type: 'event_callback', event_id: `Ev${Date.now()}`, event_time: Number(ts),
    event: { type: 'app_mention', channel, user, text, ts: `${ts}.000100`, event_ts: `${ts}.000100` },
  })
  const sig = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')
  return fetch(`${API}/${slug}/channels/${gatewayId}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts } })
}

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const slackHtml = (text) => escapeHtml(text)
  .replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>')
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1<b>$2</b>')
const PAGE = (title, body, note) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:860px;margin:32px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px;border-bottom:1px solid #f4f4f5;display:flex;gap:12px}
.av{width:36px;height:36px;border-radius:6px;flex:none;color:#fff;font-weight:600;display:flex;align-items:center;justify-content:center;font-size:14px}
.who{font-weight:600;font-size:15px;margin-bottom:4px}.who span{font-size:10px;background:#e4e4e7;border-radius:3px;padding:1px 4px;margin-left:4px;color:#52525b;font-weight:500}
.reply{margin-left:48px;border-left:2px solid #e4e4e7}.thread{font-size:12px;color:#71717a;padding:6px 24px 0 72px}
.text{white-space:pre-wrap;font-size:15px;line-height:1.5}a{color:#1264a3}.mention{background:#e8f5fa;color:#1264a3;border-radius:3px;padding:0 2px}
.note{max-width:860px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>${body}<div class="note">${escapeHtml(note)}</div></body></html>`
const msg = (who, color, text, { app = false, reply = false } = {}) => `<div class="msg${reply ? ' reply' : ''}"><div class="av" style="background:${color}">${escapeHtml(who[0])}</div><div><div class="who">${escapeHtml(who)}${app ? ' <span>APP</span>' : ''}</div><div class="text">${text}</div></div></div>`

// ---------- 1. answer from the help center (docs-deflection-bot) ----------
const DOCS_INSTRUCTIONS = `You answer questions from Parcelwise colleagues about the product, using only the Parcelwise help center in Intercom.

For every question:
1. Search the help center for it.
2. If an article answers it, answer in a few lines and end with "Source:" and a link to the article. Copy plan limits and carrier names exactly as the article says them.
3. If no article answers it, do not guess. Open a ticket of the type "Docs gap" for the docs team, with the question as its title and docs@parcelwise.example as the contact, and say that you did.

Never invent a feature, a limit or a price that is not in an article.`

async function docs(page, h, { slug }) {
  await connectModel(page, h, 'docs-01')
  await importApi(page, h, { link: 'https://raw.githubusercontent.com/intercom/Intercom-OpenAPI/main/descriptions/2.11/api.intercom.io.yaml', name: 'Intercom', address: `${UP}/intercom`, linkShot: 'docs-02' })
  await page.getByRole('button', { name: 'Create one here' }).first().click()
  await h.wait(800)
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Intercom (Parcelwise help center)')
  await page.getByRole('textbox', { name: /token|Key/i }).last().fill('dG9rOmxvY2FsLWRlbW8tMDAwMDAwMDAwMDAwMDAwMDAwMDA=')
  await h.shot('docs-03')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })

  await newAgent(page, { name: 'Docs assistant', personality: 'Short and plain. Answers first, then how. No filler and no exclamation marks.', instructions: DOCS_INSTRUCTIONS })
  await h.toTop()
  await h.shot('docs-04')
  await pickTools(page, ['intercom_search_articles', 'intercom_list_ticket_types', 'intercom_create_ticket'])
  await page.getByText('Tools and APIs').first().scrollIntoViewIfNeeded()
  await h.shot('docs-05')
  const agent = await saveAndActivate(page, h)

  await tryIt(page, h, agent, 'Can customers print DHL return labels in bulk?', /Source/, 'docs-06')
  await tryIt(page, h, agent, 'Is there a rate limit on the Parcelwise REST API?', /ticket|could not find/i, 'docs-07')

  const { channel } = await slackChannel(page, h, agent, { keysShot: 'docs-08', liveShot: 'docs-09' })
  await giveAccess(page, h, agent, 'docs-10')
  const before = (await upstream('/_admin/state')).outbox.length
  const q1 = '<@U0BOT> can customers print DHL return labels in bulk? A prospect asked on a call.'
  const r = await slackEvent(slug, channel, { text: q1 })
  if (!r.ok) throw new Error(`slack event ${r.status} ${await r.text()}`)
  const answer = await until('the Slack answer', async () => (await upstream('/_admin/state')).outbox.slice(before).find((o) => o.url.includes('chat.postMessage') && /Source/.test(o.body?.text ?? ''))?.body.text, 150000)
  await h.render('docs-00', PAGE('Slack thread', `<div class="wrap"><div class="chan"># ask-product</div>
${msg('Tom Becker', '#7c3aed', `<span class="mention">@Docs assistant</span> can customers print DHL return labels in bulk? A prospect asked on a call.`)}
<div class="thread">1 reply</div>
${msg('Docs assistant', '#0891b2', slackHtml(answer), { app: true, reply: true })}</div>`,
  'The reply exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).'))
}

// ---------- 2. score and route new leads (lead-enrichment-routing) ----------
const HS = 'https://raw.githubusercontent.com/HubSpot/HubSpot-public-api-spec-collection/main/PublicApiSpecs/CRM/'
const LEADS_INSTRUCTIONS = `You score new leads in HubSpot for Parcelwise, shipping software for online shops, and route the good ones.

Find contacts whose lifecycle stage is "lead" and that have no fit score yet. For each one, read their company and score the fit from 0 to 100:
- 30 points if the company is an online shop (industry Retail, Consumer Goods, Sporting Goods, Apparel & Fashion or Food & Beverages).
- 25 points for 50 to 500 employees, 15 points for 20 to 49.
- 20 points if their message mentions order volume, shipping, returns, labels or a carrier.
- 15 points if their job title is Founder, Head of, Director or VP.

Save on the contact: fit_score (the number), fit_reason (one line with the reasons) and the lead status: "Open" for 70 or more, "Unqualified" below 70.
For 70 or more, also set the contact owner: companies in Europe go to the owner in the team "Sales EMEA", everyone else to the team "Sales Americas".

Then report the hot leads first (name, title, company, city, size, score, owner, and what they wrote), then the others in one line each. Never email a lead.`

async function leads(page, h) {
  await upstream('/_admin/reset', { method: 'POST' })
  await connectModel(page, h)
  const parts = [['Contacts/Rollouts/424/v3/contacts.json', 'HubSpot Contacts'], ['Companies/Rollouts/424/v3/companies.json', 'HubSpot Companies'], ['Crm%20Owners/Rollouts/146888/v3/crmOwners.json', 'HubSpot Owners']]
  let first = true
  for (const [path, name] of parts) {
    if (sql(`SELECT count(*) FROM apis WHERE name = '${name}' AND "organizationId" = '${orgOf()}'`) !== '0') continue
    await importApi(page, h, { link: HS + path, name, address: `${UP}/hubspot`, linkShot: first ? 'leads-01' : null })
    if (first && sql(`SELECT count(*) FROM credentials WHERE name = 'HubSpot private app' AND "organizationId" = '${orgOf()}'`) === '0') {
      await page.getByRole('button', { name: 'Create one here' }).click()
      await h.wait(600)
      const paste = page.getByRole('button', { name: 'Paste an access token instead' })
      if (await paste.count()) await paste.click()
      await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('HubSpot private app')
      await page.getByRole('textbox', { name: /Access token|Key|token/ }).last().fill('local-demo-hubspot-token-0000000000000000000')
      await h.shot('leads-02')
      await page.getByRole('button', { name: 'Save', exact: true }).first().click()
      await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
    } else {
      await pickSignIn(page, /HubSpot private app/)
    }
    first = false
  }
  await page.goto('/apis')
  await h.wait(1500)
  await h.shot('leads-03')

  await newAgent(page, { name: 'Lead scorer', instructions: LEADS_INSTRUCTIONS })
  await h.toTop()
  await h.shot('leads-04')
  await pickTools(page, [
    'hubspot_contacts_post_crm_v3_objects_contacts_search_do_search',
    'hubspot_contacts_patch_crm_v3_objects_contacts_contact_id_update',
    'hubspot_companies_get_crm_v3_objects_companies_company_id_937ca5',
    'hubspot_owners_get_crm_v3_owners_crm_v3_owners',
  ])
  await page.getByText('Tools and APIs').first().scrollIntoViewIfNeeded()
  await h.shot('leads-05')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, 'Score the new leads.', /hot lead/, 'leads-06')
  await runSteps(page, h, agent, 'leads-07')

  await slackChannel(page, h, agent, { liveShot: 'leads-08' })
  // The test run scored them; the stand-in forgets the scores so the scheduled run finds them again.
  await upstream('/_admin/reset', { method: 'POST' })
  const schedule = async ({ every, unit, shotName }) => {
    await page.goto(`/agents/${agent}/schedule`)
    await h.wait(1500)
    await page.getByRole('combobox', { name: 'Repeat' }).click()
    await page.getByRole('option', { name: 'Every few minutes or hours' }).click()
    await page.getByRole('spinbutton', { name: 'Every' }).fill(String(every))
    await page.getByRole('combobox', { name: 'Unit' }).click()
    await page.getByRole('option', { name: unit, exact: true }).click()
    await page.getByRole('combobox', { name: 'Where' }).click()
    await page.getByRole('option', { name: /Slack/ }).first().click()
    await h.wait(800)
    await page.getByRole('combobox').filter({ hasText: /slack channel|sales-leads/i }).last().click()
    await page.getByRole('option', { name: /sales-leads/ }).click()
    await page.getByRole('textbox', { name: 'Message' }).fill('Score the new leads.')
    if (shotName) { await h.top(page.getByText('Every', { exact: true }).first(), 150); await h.shot(shotName) }
    await page.getByRole('button', { name: 'Save schedule' }).click()
    await h.wait(2000)
  }
  await schedule({ every: 1, unit: 'hours', shotName: 'leads-09' })
  await page.getByRole('heading', { name: 'Schedule' }).scrollIntoViewIfNeeded()
  await h.shot('leads-10')
  const before = (await upstream('/_admin/state')).outbox.length
  await schedule({ every: 1, unit: 'minutes' })
  const post = await until('the hot leads in Slack', async () => (await upstream('/_admin/state')).outbox.slice(before).find((o) => o.url.includes('chat.postMessage') && /hot lead/.test(o.body?.text ?? ''))?.body.text, 240000)
  await schedule({ every: 1, unit: 'hours' })
  await h.render('leads-00', PAGE('Slack messages', `<div class="wrap"><div class="chan"># sales-leads</div>${msg('Lead scorer', '#0891b2', slackHtml(post), { app: true })}</div>`,
    'The message exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).'))
}

// ---------- 3. call notes to HubSpot (meeting-notes-to-crm) ----------
const NOTES_INSTRUCTIONS = `You turn a sales rep's call notes into HubSpot updates for Parcelwise.

When a rep pastes call notes:
1. Find the deal for the company named in the notes.
2. Update the deal: move the stage to "Presentation scheduled" when a demo was agreed, set the close date when the notes give a decision date, and write the next step in one line.
3. Add the notes to the deal as a note, as short bullet points.
4. Create a task for the deal owner for the first thing that was promised, due the next working day at 09:00.
5. Reply with what you changed (old and new values) and a short follow-up email the rep can send. Never send email yourself.

Only write what the notes say. Never invent a date, an amount or a promise.`
const CALL_NOTES = 'Call with Lena Fischer (Kaffeewerk), 22 Oct. They ship about 1,200 orders a week, mostly DHL, and around 8% come back. Return labels are made by hand today, which is the main pain. Shopify store, 2 warehouse staff. Budget is approved for Q1, decision by end of November. They want a demo for Jonas, their warehouse lead, on Thursday 30 Oct. Asked for pricing for 8 seats on the Business plan, with DHL return labels.'

async function notes(page, h) {
  await connectModel(page, h)
  const parts = [['Deals/Rollouts/424/v3/deals.json', 'HubSpot Deals'], ['Notes/Rollouts/424/v3/notes.json', 'HubSpot Notes'], ['Tasks/Rollouts/424/v3/tasks.json', 'HubSpot Tasks']]
  for (const [path, name] of parts) {
    if (sql(`SELECT count(*) FROM apis WHERE name = '${name}' AND "organizationId" = '${orgOf()}'`) !== '0') continue
    await importApi(page, h, { link: HS + path, name, address: `${UP}/hubspot`, linkShot: name === 'HubSpot Notes' ? 'notes-01' : null })
    await page.getByRole('combobox', { name: 'Sign-in' }).click()
    await page.getByRole('option', { name: /HubSpot private app/ }).click()
    await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
    if (name === 'HubSpot Notes') { await h.toTop(); await h.shot('notes-02') }
  }
  await page.goto('/apis')
  await h.wait(1500)
  await h.shot('notes-03')
  await newAgent(page, { name: 'Call notes to HubSpot', personality: 'Brief and factual. Writes emails the way a busy account executive does: short, friendly, one clear next step.', instructions: NOTES_INSTRUCTIONS })
  await h.toTop()
  await h.shot('notes-04')
  await pickTools(page, [
    'hubspot_deals_post_crm_v3_objects_0_3_search_do_search',
    'hubspot_deals_patch_crm_v3_objects_0_3_deal_id_update',
    'hubspot_notes_post_crm_v3_objects_notes_create',
    'hubspot_tasks_post_crm_v3_objects_tasks_create',
  ])
  await page.getByText('Tools and APIs').first().scrollIntoViewIfNeeded()
  await h.shot('notes-05')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, CALL_NOTES, /Updated in HubSpot/, 'notes-00')
  await runSteps(page, h, agent, 'notes-06')
}

// ---------- 4. an assistant that remembers (agent-that-remembers) ----------
const MEMORY_INSTRUCTIONS = `You are the account notes assistant for Parcelwise account managers.

When someone gives you notes about a customer, remember each lasting fact on its own: who decides, how they like to be contacted, their budget cycle, and what they are waiting for. Say back what you will remember.

When someone asks you to draft something for a customer, first look up what you remember about that customer and use it. Say which remembered facts you used. If you remember nothing about them, say so and ask.`
async function memory(page, h) {
  await connectModel(page, h)
  await newAgent(page, { name: 'Account notes', personality: 'Brief and practical.', instructions: MEMORY_INSTRUCTIONS })
  await h.toTop()
  await h.shot('memory-01')
  await page.getByRole('switch', { name: 'Remember between conversations' }).click()
  await page.getByRole('combobox', { name: 'Whose memory' }).click()
  await page.getByRole('option', { name: /Shared by all agents/ }).click()
  await page.getByRole('combobox', { name: 'What it saves' }).click()
  await page.getByRole('option', { name: /Facts it learns/ }).click()
  await page.getByRole('heading', { name: 'Memory' }).scrollIntoViewIfNeeded()
  await h.shot('memory-02')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, "Notes from today's check-in with Kestrel Coffee Co.: their financial year starts in July, so next year's budget is decided in May. Priya Raman (Operations Director) signs off on renewals; she prefers short emails with no attachments. They want the DPD integration before peak season.", /remember/, 'memory-03')
  await page.getByRole('tab', { name: 'Memory' }).click()
  await h.wait(2000)
  await h.shot('memory-04')
  await tryIt(page, h, agent, 'Draft the renewal email for Kestrel Coffee Co.', /Subject/, 'memory-00')
  await memoriesPage(page, h)
}
async function memoriesPage(page, h) {
  await page.goto('/memories')
  await h.wait(2000)
  await h.shot('memory-05')
}

// ---------- 5. Google Drive (connect-google-sharepoint) ----------
const DRIVE_INSTRUCTIONS = `You answer Parcelwise sales questions from the documents in the team's Google Drive: pricing, discounts, security, proposals and onboarding.

For every question:
1. Search the "Sales" shared drive for the documents that cover it: search the full text (q: fullText contains 'word'), newest first, with corpora "drive", driveId "0APwSalesShared", and includeItemsFromAllDrives and supportsAllDrives set to true.
2. Read the one or two most relevant documents as plain text.
3. Answer in a few lines, quoting the rule or number the document gives, and end with "Sources:" and a link to each document you used.

If no document covers the question, say so. Never guess a price, a discount or a security claim. You only read: never create, change or share files.`
async function driveGuide(page, h) {
  await connectModel(page, h)
  await page.goto('/apis/new/openapi')
  await page.getByLabel('Link to the description').fill('https://www.googleapis.com/discovery/v1/apis/drive/v3/rest')
  await h.shot('drive-01')
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Google Drive')
  await page.getByLabel('Address', { exact: true }).fill(`${UP}/drive/v3`)
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 90000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 180000 })
  await h.wait(800)
  await h.shot('drive-02')
  await page.getByRole('button', { name: 'Create one here' }).click()
  await page.getByLabel('Client ID').fill('123456789012-pw0drive1sales.apps.googleusercontent.com')
  await page.getByLabel('Client secret').fill('GOCSPX-local-test-secret')
  await page.getByTestId('api-oauth-redirect').waitFor({ timeout: 10000 })
  for (const cb of await page.getByTestId('api-oauth-scopes').getByRole('checkbox').all()) {
    const scope = (await cb.getAttribute('aria-label')) || ''
    if (/drive\.readonly$/.test(scope)) await cb.check(); else await cb.uncheck()
  }
  await page.getByTestId('api-oauth-scopes').locator('.overflow-y-auto').evaluate((e) => { e.scrollTop = 0 }).catch(() => {})
  await h.top(page.getByTestId('api-oauth-redirect'))
  await h.shot('drive-03')
  await page.getByRole('button', { name: 'Paste an access token instead' }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Google account (Sofia)')
  await page.getByRole('textbox', { name: 'Access token' }).fill('local-test-google-token')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
  await h.toTop()
  await h.shot('drive-04')

  await page.goto('/tools')
  await h.wait(1200)
  await page.getByPlaceholder('Search tools...').fill('drive_files_list')
  await h.wait(1500)
  // The list shows the tool's display name; its machine name is the title.
  await page.getByTitle('google_drive_drive_files_list', { exact: true }).first().click()
  await h.wait(1500)
  await page.getByRole('tab', { name: 'Test tool' }).click()
  await page.getByPlaceholder('Enter q', { exact: true }).fill("fullText contains 'discount'")
  await page.getByRole('button', { name: 'Execute Tool' }).click()
  await page.getByText('Response Data:').waitFor({ timeout: 20000 })
  await page.getByText('Response Data:').scrollIntoViewIfNeeded()
  await h.shot('drive-05')

  await newAgent(page, { name: 'Sales documents', personality: 'Direct and exact. Gives the answer first, then the rule it comes from.', instructions: DRIVE_INSTRUCTIONS })
  await h.toTop()
  await h.shot('drive-06')
  await pickTools(page, ['google_drive_drive_files_list', 'google_drive_drive_files_export'])
  await page.getByText('Tools and APIs').first().scrollIntoViewIfNeeded()
  await h.shot('drive-07')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, agent, 'Can I give Kaffeewerk 15% off an annual Business plan with 8 seats?', /Sources/, 'drive-00')
}

// ---------- run ----------
async function walk(names, { fresh }) {
  if (fresh) {
    sql(`DELETE FROM organizations WHERE id IN (SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${SOFIA.email}')`)
    sql(`DELETE FROM users WHERE email = '${SOFIA.email}'`)
  }
  const { slug } = await account()
  const browser = await chromium.launch()
  const { ctx, page } = await session(browser)
  const h = helpers(page)
  try {
    if (names.includes('docs')) await docs(page, h, { slug })
    if (names.includes('leads')) await leads(page, h)
    if (names.includes('notes')) await notes(page, h)
    if (names.includes('memory')) await memory(page, h)
    if (names.includes('drive')) await driveGuide(page, h)
    if (names.includes('memories')) await memoriesPage(page, h)
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
    const notes = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed/usecases/sales-guides.mjs): real public API descriptions, a local stand-in for Intercom, HubSpot, Google Drive and Slack, and a scripted stand-in model; fictional people and companies. Not staging or production data.' +
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
  await walk(names.length ? names : ['docs', 'leads', 'notes', 'memory', 'drive'], { fresh })
}
