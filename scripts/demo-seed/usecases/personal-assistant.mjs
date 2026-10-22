#!/usr/bin/env node
// Walks the personal-assistant tutorial (docs-site/content/tutorials/
// personal-assistant.mdx) through the UI and takes its screenshots into
// $SHOT_DIR/tutorials/personal (default /tmp/almyty-demo/shots/tutorials/personal).
//
// Needs the demo stack with USECASES=1 and the stand-in started as Elena:
//   USECASE_PERSONA=elena (usecases/upstream.mjs serves her calendars, mail and tasks)
//   PUBLIC_API_URL set on the API, so publishing the Telegram channel registers its webhook
//     (with the stand-in instead of Telegram: redirect-fetch.mjs sends api.telegram.org there).
//
// It works as Elena Park, in an organization of her own. What differs from a
// real account, because the stand-in is on localhost: the organization allows
// localhost, the API addresses are set to the stand-in under Advanced, the
// model key is sent with the stand-in's address, Google's sign-in page is never
// opened (a token is pasted instead), her Telegram messages are posted to the
// channel the way Telegram posts them (with the secret token it was given),
// and the Telegram chat is shown as the stand-in received it, rendered as a page.
//
//   node scripts/demo-seed/usecases/personal-assistant.mjs [stage...]   setup agent telegram alwayson privacy intro flight yes after
//   node scripts/demo-seed/usecases/personal-assistant.mjs --register [shot...]
import { createRequire } from 'node:module'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(ROOT, 'frontend/package.json'))
const { chromium } = require('@playwright/test')

const WEB = process.env.DEMO_WEB_URL || 'http://localhost:3210'
const API = process.env.DEMO_API_URL || 'http://localhost:4210'
const UP = process.env.DEMO_USECASE_URL || 'http://localhost:4291'
const PSQL = process.env.DEMO_PSQL || 'docker exec -i almyty-demo-pg psql -U postgres -d almyty_qa'
const OUT = join(process.env.SHOT_DIR || '/tmp/almyty-demo/shots', 'tutorials', 'personal')
mkdirSync(OUT, { recursive: true })

export const ELENA = { email: 'elena.park@example.com', password: 'Elena-Park-2026!', firstName: 'Elena', lastName: 'Park', organizationName: 'Elena Park' }
// Her Telegram account: the number Telegram gives it, which is also her 1:1 chat with the bot.
const TG_USER = 581234907
const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()
const upstream = async (path, init) => (await fetch(`${UP}${path}`, init)).json()
const STATE = join(OUT, 'state.json')
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {}
const keep = () => writeFileSync(STATE, JSON.stringify(state, null, 2))

const UI = ['frontend/src/components/ui', 'frontend/src/components/layout', 'frontend/src/index.css']
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const APPROVALS = ['frontend/src/pages/approvals.tsx', 'frontend/src/lib/email-preview.ts']
const ALWAYS_ON = ['frontend/src/pages/agent-always-on.tsx', 'frontend/src/lib/always-on.ts']
const TELEGRAM = ['backend/src/modules/gateways/channels/adapters/telegram.adapter.ts', 'backend/src/modules/agents/always-on/always-on.service.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']

// shot: [published path under screenshots/tutorials, title, sources]
export const SHOTS = {
  'pa-00': ['personal/00-telegram-flight.png', 'Personal assistant: the flight change in Telegram', TELEGRAM],
  'pa-01': ['personal/01-calendar-scopes.png', 'Google Calendar sign-in: permission to change events', SETUP],
  'pa-02': ['personal/02-apis.png', 'Google Calendar, Gmail and Google Tasks connected', ['frontend/src/pages/apis.tsx']],
  'pa-03': ['personal/03-agent-instructions.png', 'Personal assistant: model, personality and instructions', BUILDER],
  'pa-04': ['personal/04-agent-memory.png', 'Personal assistant: memory', BUILDER],
  'pa-05': ['personal/05-agent-tools.png', 'Personal assistant: tools', BUILDER],
  'pa-06': ['personal/06-telegram-token.png', 'Telegram channel: the bot token', CHANNEL],
  'pa-07': ['personal/07-telegram-live.png', 'Telegram channel, live and registered with Telegram', CHANNEL],
  'pa-08': ['personal/08-always-on.png', 'Always on: standing instructions and what wakes it', ALWAYS_ON],
  'pa-09': ['personal/09-talk-and-ask-first.png', 'Always on: talk to it in Telegram, ask first before every change', ALWAYS_ON],
  'pa-10': ['personal/10-reports.png', 'Always on: reports to Telegram', ALWAYS_ON],
  'pa-11': ['personal/11-always-on-card.png', 'Always on, on the agent page', AGENT],
  'pa-12': ['personal/12-privacy.png', 'Settings, Compliance: hide personal data', ['frontend/src/components/settings/compliance-settings.tsx', 'frontend/src/pages/settings.tsx']],
  'pa-13': ['personal/13-telegram-intro.png', 'Telling the assistant about yourself in Telegram', TELEGRAM],
  'pa-14': ['personal/14-memory.png', 'What the assistant remembers about Elena', AGENT],
  'pa-15': ['personal/15-approve-move.png', 'Approving the moved meeting', APPROVALS],
  'pa-16': ['personal/16-approve-email.png', 'Approving the email to Tom', APPROVALS],
  'pa-17': ['personal/17-what-woke-it.png', 'What woke it lately', ALWAYS_ON],
  'pa-18': ['personal/18-memory-after.png', 'The assistant remembers what Elena said yes to', AGENT],
}
const RENDERED = { 'pa-00': '/agents/:id/always-on', 'pa-13': '/agents/:id/always-on' }

// ---------- the account ----------

async function account() {
  if (sql(`SELECT count(*) FROM users WHERE email = '${ELENA.email}'`) === '0') {
    const r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ELENA) })
    if (!r.ok) throw new Error(`register ${r.status} ${await r.text()}`)
  }
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${ELENA.email}'`)
  const org = sql(`SELECT o.id || '|' || o.slug FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${ELENA.email}' LIMIT 1`)
  const [orgId, slug] = org.split('|')
  sql(`UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
  return { orgId, slug }
}

// ---------- the browser ----------

const HIDE = '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }'

async function session(browser) {
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'light', timezoneId: 'UTC', locale: 'en-US', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light') } catch {} })
  await ctx.route(/accounts\.google\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Stopped before the real sign-in page (local demo).</p>' }))
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.goto('/auth/login')
  await page.locator('#email').fill(ELENA.email)
  await page.locator('#password').fill(ELENA.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
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
  const render = async (name, html) => {
    const file = join(OUT, `${name}.html`)
    writeFileSync(file, html)
    await page.goto(`file://${file}`)
    await wait(800)
    await shot(name, { fullPage: true })
  }
  return { wait, shot, top, id, render }
}

async function pickTools(page, names) {
  const search = page.getByRole('textbox', { name: 'Search tools' })
  for (const t of names) {
    await search.fill(t)
    await page.waitForTimeout(300)
    for (const b of await page.getByRole('button', { name: /\d+ tools?/ }).all()) if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click()
    await page.getByRole('checkbox', { name: t, exact: true }).check()
  }
  await search.fill('')
}

async function connectApi(page, { link, name, address }) {
  await page.goto('/apis/new/openapi')
  await page.getByLabel('Link to the description').fill(link)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Address', { exact: true }).fill(address) // the local stand-in
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 60000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 120000 })
}

async function pickSignIn(page, name) {
  await page.getByRole('combobox', { name: 'Sign-in' }).click()
  await page.getByRole('option', { name }).click()
  await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
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

const pending = () => Number(sql(`SELECT count(*) FROM approval_requests WHERE "organizationId" = '${state.orgId}' AND status = 'pending'`))

// Elena writes to the bot: Telegram posts the update to the channel's address with the secret it was given.
// Telegram numbers its updates and repeats a number only on a retry, which almyty drops; each run continues the count.
let updateId = Math.floor(Date.now() / 1000)
async function telegram(text) {
  const update = { update_id: ++updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), text, chat: { id: TG_USER, type: 'private', first_name: 'Elena' }, from: { id: TG_USER, is_bot: false, first_name: 'Elena', last_name: 'Park', language_code: 'en' } } }
  const r = await fetch(`${API}/${state.slug}/channels/${state.channel}`, { method: 'POST', body: JSON.stringify(update), headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': state.tgSecret } })
  if (!r.ok) throw new Error(`telegram update ${r.status} ${await r.text()}`)
  state.chat = [...(state.chat || []), { who: 'me', text, at: new Date().toISOString() }]
  keep()
}
// What the bot said, as the stand-in received it.
async function botMessages() {
  return (await upstream('/_admin/state')).outbox.filter((o) => /api\.telegram\.org\/bot[^/]+\/sendMessage/.test(o.url) && String(o.body?.chat_id) === String(TG_USER)).map((o) => ({ who: 'bot', text: o.body.text, at: o.at }))
}

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// A Telegram chat as Telegram's desktop app lays it out: her bubbles right, the bot's left.
async function chatPage(title, from) {
  const msgs = [...(state.chat || []), ...(await botMessages())].filter((m) => !from || m.at >= from).sort((a, b) => a.at.localeCompare(b.at))
  const time = (iso) => new Date(iso).toISOString().slice(11, 16)
  const bubble = (m) => `<div class="row ${m.who}"><div class="b"><div class="t">${escapeHtml(m.text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</div><div class="tm">${time(m.at)}</div></div></div>`
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#e7ebf0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#000}
.wrap{max-width:760px;margin:24px auto;background:#a7c4a0 linear-gradient(160deg,#c9dcb8,#9fbf9a);border-radius:12px;overflow:hidden;border:1px solid #cfd6dd}
.head{background:#fff;padding:12px 18px;border-bottom:1px solid #dfe3e8}.name{font-weight:600;font-size:16px}.sub{font-size:13px;color:#8a96a3}
.chat{padding:16px 14px}.row{display:flex;margin:6px 0}.row.me{justify-content:flex-end}
.b{max-width:78%;padding:7px 11px 5px;border-radius:12px;box-shadow:0 1px 1px #0002;background:#fff}.row.me .b{background:#e1fec6}
.t{white-space:pre-wrap;font-size:15px;line-height:1.4}.tm{text-align:right;font-size:11px;color:#6d8a6b;margin-top:2px}
.note{max-width:760px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>
<div class="wrap"><div class="head"><div class="name">Elena's assistant</div><div class="sub">bot</div></div><div class="chat">${msgs.map(bubble).join('')}</div></div>
<div class="note">The messages exactly as almyty sent them to Telegram, and Elena's as Telegram delivered them, laid out the way Telegram shows a chat (local demo; Telegram itself was not used).</div></body></html>`
}

// ---------- the stages ----------

const STAGES = {
  // 1. A model and Google, as in the founder's associate, with the permissions to change events and send email.
  async setup(page, h) {
    await page.goto('/models/providers/new')
    await page.getByLabel('Name', { exact: true }).fill('OpenAI')
    await page.getByRole('combobox', { name: 'Provider' }).click()
    await page.getByPlaceholder('Search providers').fill('OpenAI')
    await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
    await h.wait(500)
    await page.getByLabel(/API key/).first().fill('sk-proj-0000000000000000000000000000000000000000')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForURL(/\/models\/providers\/[0-9a-f-]{36}/, { timeout: 60000 })

    await page.goto('/apis/new/openapi')
    await page.getByLabel('Link to the description').fill('https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest')
    await page.getByRole('button', { name: 'Advanced' }).click()
    await page.getByLabel('Name', { exact: true }).fill('Google Calendar')
    await page.getByLabel('Address', { exact: true }).fill(`${UP}/calendar/v3`)
    await page.getByRole('button', { name: 'Connect API' }).click()
    await page.waitForURL(/\/setup/, { timeout: 60000 })
    await page.getByText(/Found \d+ operation/).waitFor({ timeout: 120000 })
    await page.getByRole('button', { name: 'Create one here' }).click()
    await page.getByLabel('Client ID').fill('123456789012-elenapark0001.apps.googleusercontent.com')
    await page.getByLabel('Client secret').fill('GOCSPX-local-test-secret')
    await page.getByTestId('api-oauth-redirect').waitFor({ timeout: 10000 })
    // To move a meeting it needs calendar.events; nothing wider.
    for (const cb of await page.getByTestId('api-oauth-scopes').getByRole('checkbox').all()) {
      const scope = (await cb.getAttribute('aria-label')) || ''
      if (/\/auth\/calendar\.events$/.test(scope)) await cb.check(); else await cb.uncheck()
    }
    await page.getByTestId('api-oauth-scopes').locator('.overflow-y-auto').evaluate((e) => { e.scrollTop = 0 })
    await h.top(page.getByTestId('api-oauth-redirect'))
    await h.shot('pa-01')
    await page.getByRole('button', { name: 'Paste an access token instead' }).click()
    await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Google Calendar (Elena)')
    await page.getByRole('textbox', { name: 'Access token' }).fill('local-test-google-calendar-token')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })

    for (const [link, name] of [['https://gmail.googleapis.com/$discovery/rest?version=v1', 'Gmail'], ['https://tasks.googleapis.com/$discovery/rest?version=v1', 'Google Tasks']]) {
      await connectApi(page, { link, name, address: `${UP}/` })
      await page.getByRole('button', { name: 'Create one here' }).click()
      await page.getByLabel('Client ID').fill('123456789012-elenapark0001.apps.googleusercontent.com')
      await page.getByLabel('Client secret').fill('GOCSPX-local-test-secret')
      await page.getByRole('button', { name: 'Paste an access token instead' }).click()
      await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill(`${name} (Elena)`)
      await page.getByRole('textbox', { name: 'Access token' }).fill(`local-test-${name.toLowerCase().replace(/\s/g, '-')}-token`)
      await page.getByRole('button', { name: 'Save', exact: true }).first().click()
      await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
    }
    await page.goto('/apis')
    await h.wait(1500)
    await h.shot('pa-02')
  },

  // 2. The assistant
  async agent(page, h) {
    await page.goto('/agents/new')
    await page.getByRole('button', { name: 'Autonomous' }).click()
    await page.getByRole('textbox', { name: 'Agent name' }).fill("Elena's assistant")
    await page.getByRole('combobox', { name: 'Model' }).first().click()
    await page.getByRole('option', { name: /gpt-4o(?!-mini)/ }).first().click()
    await page.getByRole('textbox', { name: 'Personality and style' }).fill(PERSONALITY)
    await page.getByRole('textbox', { name: 'Instructions' }).fill(INSTRUCTIONS)
    await page.getByRole('textbox', { name: 'Instructions' }).evaluate((e) => { e.scrollTop = 0 })
    await h.top(page.getByRole('textbox', { name: 'Personality and style' }), 260)
    await h.shot('pa-03')
    await page.getByRole('switch', { name: 'Remember between conversations' }).click()
    await page.getByRole('combobox', { name: 'Whose memory' }).click()
    await page.getByRole('option', { name: /This agent's own/ }).click()
    await page.getByRole('combobox', { name: 'What it saves' }).click()
    await page.getByRole('option', { name: /Facts it learns/ }).click()
    await page.getByRole('heading', { name: 'Memory' }).scrollIntoViewIfNeeded()
    await h.shot('pa-04')
    await pickTools(page, TOOLS)
    await page.getByRole('heading', { name: 'Tools and APIs' }).scrollIntoViewIfNeeded()
    await h.shot('pa-05')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
    state.agent = h.id(); keep()
    await page.goto(`/agents/${state.agent}`)
    await h.wait(1500)
    await page.getByRole('button', { name: 'Activate' }).click()
    await h.wait(1500)
  },

  // 3. Telegram: the bot she talks to
  async telegram(page, h) {
    await page.goto(`/agents/${state.agent}/channels/new`)
    await h.wait(1200)
    await page.getByRole('button', { name: /^Telegram/ }).click()
    await h.wait(2000)
    await page.getByRole('button', { name: 'Create one here' }).last().click()
    await h.wait(800)
    await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Telegram bot (Elena)')
    await page.getByRole('textbox', { name: 'Bot token' }).fill('7000001234:AAH-local-test-token-elena-0123456789')
    await page.getByRole('textbox', { name: 'Bot token' }).scrollIntoViewIfNeeded()
    await h.shot('pa-06')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await h.wait(4000)
    const save = page.getByRole('button', { name: 'Save', exact: true }).last()
    if (await save.isEnabled().catch(() => false)) { await save.click(); await h.wait(2500) }
    await page.getByRole('button', { name: 'Publish', exact: true }).click()
    await page.getByText('Registered with Telegram.').waitFor({ timeout: 20000 })
    await h.wait(1500)
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) })
    await h.shot('pa-07')
    state.channel = page.url().match(/channels\/([0-9a-f-]{36})/)[1]
    // The secret token almyty gave Telegram when it registered the webhook; Telegram sends it back with every update.
    const reg = (await upstream('/_admin/state')).outbox.filter((o) => /\/setWebhook/.test(o.url)).pop()
    state.tgSecret = new URL(`http://x${reg.url.slice(reg.url.indexOf('/setWebhook'))}`).searchParams.get('secret_token')
    keep()
  },

  // 4. Always on: wakes by itself, talks to her in Telegram, asks before every change
  async alwayson(page, h) {
    await page.goto(`/agents/${state.agent}/always-on`)
    await h.wait(1500)
    await page.getByRole('textbox', { name: 'Standing instructions' }).fill(STANDING)
    await page.getByRole('spinbutton', { name: 'Every' }).fill('30')
    await page.getByRole('combobox', { name: 'Unit' }).click()
    await page.getByRole('option', { name: 'minutes' }).click()
    await page.getByRole('switch', { name: 'Always on' }).click()
    await h.top(page.getByText('What it keeps doing', { exact: true }), 140)
    await h.shot('pa-08')
    await page.getByRole('combobox', { name: 'Channel' }).click()
    await page.getByRole('option', { name: /Telegram/ }).first().click()
    await h.wait(500)
    await page.getByRole('textbox', { name: 'Your address there' }).fill(String(TG_USER))
    await page.getByRole('combobox', { name: 'On its own, it' }).click()
    await page.getByRole('option', { name: /Does things/ }).click()
    await h.wait(800)
    await h.top(page.getByText('Talk to it yourself', { exact: true }), 140)
    await h.shot('pa-09')
    await page.getByRole('combobox', { name: 'Post reports to' }).click()
    await page.getByRole('option', { name: /Telegram/ }).first().click()
    await h.wait(600)
    await page.getByPlaceholder('-1001234567890 or @yourchannel').fill(String(TG_USER))
    await page.getByRole('combobox', { name: 'When' }).click()
    await page.getByRole('option', { name: 'After every wake' }).click()
    await h.top(page.getByRole('heading', { name: 'Reports' }), 60)
    await h.shot('pa-10')
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await h.wait(2500)
    await page.goto(`/agents/${state.agent}`)
    await h.wait(1500)
    await page.getByRole('heading', { name: 'Always on' }).scrollIntoViewIfNeeded()
    await h.shot('pa-11')
  },

  // 5. The privacy filter: personal data hidden in records and in answers to outsiders
  async privacy(page, h) {
    await page.goto('/settings')
    await h.wait(1200)
    await page.getByRole('tab', { name: 'Advanced' }).click()
    await h.wait(800)
    await page.getByText('Compliance', { exact: true }).first().click()
    await h.wait(1200)
    const pii = page.getByRole('switch', { name: 'Enforce PII filter' })
    if ((await pii.getAttribute('aria-checked')) !== 'true') await pii.click()
    await h.wait(600)
    await h.top(page.getByRole('heading', { name: 'Compliance policy' }), 140)
    await h.shot('pa-12')
    await page.getByRole('button', { name: 'Save compliance policy' }).click()
    await h.wait(2000)
  },

  // 6. She tells it about herself, in Telegram
  async intro(page, h) {
    const from = new Date().toISOString()
    await telegram(INTRO)
    await until('its answer in Telegram', async () => (await botMessages()).some((m) => m.at >= from && /I will remember/.test(m.text)), 180000)
    await h.render('pa-13', await chatPage('Telegram', from))
    await page.goto(`/agents/${state.agent}`)
    await h.wait(1500)
    await page.getByRole('tab', { name: 'Memory' }).click()
    await h.wait(2000)
    await h.shot('pa-14')
  },

  // 7. Her flight moves: the airline's email arrives, and at its next wake it notices the clash.
  async flight(page, h) {
    state.flightFrom = new Date().toISOString(); keep()
    await upstream('/_admin/mail', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(FLIGHT_MAIL) })
    await page.goto(`/agents/${state.agent}`)
    await h.wait(2000)
    await page.getByRole('button', { name: 'Wake now' }).click()
    await until('the offer in Telegram', async () => (await botMessages()).some((m) => m.at >= state.flightFrom && /Shall I move/.test(m.text)), 180000)
  },

  // 8. She says yes; each change still waits for her OK in Approvals.
  async yes(page, h) {
    await telegram('Yes please, do that.')
    await until('the calendar change waiting for approval', async () => pending() > 0, 180000)
    await h.wait(2000)
    await page.goto('/approvals')
    await h.wait(3000)
    // A calendar change has no preview of its own: what it changes is under Action details.
    await page.getByText('Action details').first().click()
    await h.wait(800)
    await h.shot('pa-15')
    await approveOne(page)
    await until('the email to Tom waiting for approval', async () => pending() > 0, 180000)
    await h.wait(2000)
    await page.goto('/approvals')
    await h.wait(3000)
    await h.shot('pa-16')
    await approveOne(page)
    await until('its answer in Telegram', async () => (await botMessages()).some((m) => m.at >= state.flightFrom && /^Done\./.test(m.text)), 180000)
    await h.render('pa-00', await chatPage('Telegram', state.flightFrom))
  },

  // 9. Afterwards: what woke it, and what it remembers now.
  async after(page, h) {
    await page.goto(`/agents/${state.agent}/always-on`)
    await h.wait(2000)
    await page.getByRole('heading', { name: 'What woke it lately' }).scrollIntoViewIfNeeded()
    await h.shot('pa-17')
    await page.goto(`/agents/${state.agent}`)
    await h.wait(1500)
    await page.getByRole('tab', { name: 'Memory' }).click()
    await h.wait(2000)
    await h.shot('pa-18')
  },
}

export const PERSONALITY = 'Friendly, calm and short. Lead with the news, then one clear question. No filler, no exclamation marks.'
export const INSTRUCTIONS = `You are Elena Park's personal assistant. You look after her calendar, her email and her tasks.

Get to know her. When she tells you something about herself (what she likes, her routines, the people in her life, how she wants things done), remember it. When she says yes or no to something you offered, remember that too, and use it next time.

Look ahead. At every wake, check the next two days of her calendars, her new email and her open tasks. Tell her only about what needs her: a clash, a change (a moved flight, a cancelled meeting), something due soon, an email that needs an answer. If nothing needs her, stay quiet.

When you see a problem, offer one concrete fix and ask: "Shall I ...?". Never change anything before she says yes: no email, no calendar change, no task change.

If you cannot see something because you have no access to it, say so plainly.`
export const STANDING = 'Look after Elena. At every wake, check the next two days of her calendars, her email from the last day and her open tasks. If something needs her (a clash, a change, something due soon), tell her in one or two sentences and offer one fix. If nothing needs her, answer only: Nothing needs you right now.'
export const INTRO = "Hi, a few things about me. I don't take meetings before 9, except when I travel. Keep your messages short. Tom Becker is my manager at Northwind Studio; he is fine with short-notice changes if I tell him early. Ana is my sister, we have lunch whenever I am in Berlin. I always take a window seat, and it takes me about 40 minutes from Berlin airport to the office."
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
export const FLIGHT_MAIL = {
  from: 'Atlantica Airways <noreply@atlantica-air.example>',
  subject: 'Schedule change: your flight AT 552 to Berlin',
  body: `Dear Elena Park,\n\nYour flight AT 552 from Lisbon (LIS) to Berlin (BER) on ${tomorrow} has a new schedule.\n\nNew departure 07:10, new arrival 09:20 (was 06:00 and 08:10).\n\nYour seat 14A and booking QX7P2L stay the same. You do not need to do anything.\n\nAtlantica Airways`,
}

async function approveOne(page) {
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
  await page.waitForTimeout(700)
  await page.getByRole('form', { name: 'Approve this action' }).getByRole('button', { name: 'Approve' }).click()
  await page.waitForTimeout(5000)
}
export const TOOLS = [
  'google_calendar_calendar_calendar_list_list',
  'google_calendar_calendar_events_list',
  'google_calendar_calendar_events_patch',
  'gmail_gmail_users_messages_list',
  'gmail_gmail_users_messages_get',
  'gmail_gmail_users_messages_send',
  'google_tasks_tasks_tasks_list',
]

// ---------- run ----------

async function walk(names) {
  const { orgId, slug } = await account()
  Object.assign(state, { orgId, slug }); keep()
  const browser = await chromium.launch()
  const { ctx, page } = await session(browser)
  const h = helpers(page)
  try {
    for (const n of names) { console.log('stage', n); await STAGES[n](page, h) }
  } catch (e) {
    console.log('FAILED', e.message.split('\n')[0])
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
    const notes = 'Tutorial step, walked through the UI on the local demo stack with USECASES=1 and USECASE_PERSONA=elena (scripts/demo-seed/usecases/personal-assistant.mjs): real public API descriptions, a local stand-in for Google and Telegram, and a scripted stand-in model; a fictional person. Not staging or production data.' +
      (RENDERED[shot] ? ' The page lays out the messages exactly as almyty sent them to Telegram; Telegram was not used.' : '')
    execFileSync(process.execPath, [join(ROOT, 'docs-site/scripts/record-screenshot.mjs'), '--image', c.file, '--path', `screenshots/tutorials/${path}`, '--title', title, '--captured-at', c.at, '--route', route, '--environment', 'local-demo',
      '--notes', notes, ...[...sources, ...UI].flatMap((s) => ['--sources', s])], { stdio: 'inherit' })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--register') register(args.slice(1))
else {
  // --fresh: Elena's account and organization go first, so the walk starts where a new customer starts.
  if (args.includes('--fresh')) {
    if ((await upstream('/_admin/state')).outbox.length) throw new Error(`${UP} already holds messages from an earlier run: restart it with USECASE_PERSONA=elena`)
    sql(`DELETE FROM organizations WHERE id IN (SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${ELENA.email}')`)
    sql(`DELETE FROM users WHERE email = '${ELENA.email}'`)
    for (const k of Object.keys(state)) delete state[k]
    keep()
  }
  const names = args.filter((a) => a !== '--fresh')
  await walk(names.length ? names : Object.keys(STAGES))
}