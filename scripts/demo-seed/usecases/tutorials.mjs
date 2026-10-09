#!/usr/bin/env node
// Walks the two beginner tutorials in docs-site/content/tutorials (the
// founder's associate and the biz-dev assistant) through the UI, step by
// step as their text says, and takes the screenshots they show into
// $SHOT_DIR/tutorials (default /tmp/almyty-demo/shots/tutorials) for review.
//
// It needs the demo stack started with USECASES=1 (stack.sh), which runs
// usecases/upstream.mjs: a stand-in for Google Calendar, Gmail, Google
// Tasks, HubSpot, Slack, Resend and a scripted model, so nothing reaches a
// real account and every run answers the same way. A fresh stack is best:
// the upstream keeps what was sent in memory.
//
// It works as Maya Chen in an organization of her own, "Lumen" (a local
// test credential). What differs from a real account, because the stand-in
// is on localhost: the organization allows localhost, the API addresses are
// set to the stand-in under Advanced, the model key is sent with the
// stand-in's address, Google's sign-in page is never opened (a token is
// pasted instead), and the Slack message and the email are shown as the
// stand-in received them, rendered as a page.
//
// The API descriptions are the real public ones (Google's discovery
// documents, HubSpot's published specs), read from their links as a user
// would; the APIs themselves are never called.
//
//   node scripts/demo-seed/usecases/tutorials.mjs                 both tutorials
//   node scripts/demo-seed/usecases/tutorials.mjs founder         only this one
//   node scripts/demo-seed/usecases/tutorials.mjs --fresh         Maya's organization removed first
//   node scripts/demo-seed/usecases/tutorials.mjs --register [shot...]
import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'
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
const OUT = join(process.env.SHOT_DIR || '/tmp/almyty-demo/shots', 'tutorials')
mkdirSync(OUT, { recursive: true })

export const MAYA = { email: 'maya.chen@lumenlabs.example', password: 'Lumen-Labs-2026!', firstName: 'Maya', lastName: 'Chen', organizationName: 'Lumen' }
const SLACK_SIGNING_SECRET = 'local-test-signing-secret-0123456789'
const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()
const upstream = async (path, init) => (await fetch(`${UP}${path}`, init)).json()

const UI = ['frontend/src/components/ui', 'frontend/src/components/layout', 'frontend/src/index.css']
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const APPROVALS = ['frontend/src/pages/approvals.tsx', 'frontend/src/lib/email-preview.ts']
const ALWAYS_ON = ['frontend/src/pages/agent-always-on.tsx']

// shot: [published path under screenshots/tutorials, title, sources]
export const SHOTS = {
  'founder-00': ['founder/00-morning-brief.png', "Founder's associate: the morning brief email", ['frontend/src/pages/agent-schedule.tsx', 'backend/src/modules/gateways/channels/adapters/email.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']],
  'founder-01': ['founder/01-connect-openai.png', 'Connect a provider: OpenAI', ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']],
  'founder-02': ['founder/02-openai-connected.png', 'OpenAI connected, its models', ['frontend/src/components/llm-providers']],
  'founder-03': ['founder/03-connect-an-api.png', 'Connect an API', ['frontend/src/pages/api-new.tsx']],
  'founder-04': ['founder/04-calendar-link.png', 'Google Calendar description link', ['frontend/src/pages/api-new.tsx']],
  'founder-05': ['founder/05-finish-connecting.png', 'Finish connecting Google Calendar', SETUP],
  'founder-06': ['founder/06-google-sign-in.png', 'Google sign-in: redirect address, client ID, secret and permissions', SETUP],
  'founder-07': ['founder/07-calendar-signed-in.png', 'Google Calendar signed in', SETUP],
  'founder-08': ['founder/08-apis.png', 'The three Google APIs', ['frontend/src/pages/apis.tsx']],
  'founder-09': ['founder/09-tools-search.png', 'Searching the tools', ['frontend/src/pages/tools.tsx']],
  'founder-10': ['founder/10-test-tool.png', 'Testing a calendar tool', ['frontend/src/pages/tool-detail.tsx']],
  'founder-11': ['founder/11-agent-instructions.png', "Founder's associate: model and instructions", BUILDER],
  'founder-12': ['founder/12-agent-memory.png', "Founder's associate: memory", BUILDER],
  'founder-13': ['founder/13-agent-tools.png', "Founder's associate: tools", BUILDER],
  'founder-14': ['founder/14-first-run.png', "Founder's associate: first test run", AGENT],
  'founder-15': ['founder/15-run-steps.png', 'A run, step by step', AGENT],
  'founder-16': ['founder/16-add-channel.png', 'Add channel', ['frontend/src/pages/agent-channel-new.tsx']],
  'founder-17': ['founder/17-email-key.png', 'Email channel: the Resend key', CHANNEL],
  'founder-18': ['founder/18-email-live.png', 'Email channel, live', CHANNEL],
  'founder-19': ['founder/19-schedule.png', 'Set up a schedule', ['frontend/src/pages/agent-schedule.tsx']],
  'founder-20': ['founder/20-schedule-card.png', 'The schedule on the agent page', AGENT],
  'founder-21': ['founder/21-memory.png', 'What the associate remembers', AGENT],
  'bizdev-00': ['bizdev/00-approve-email.png', 'Approving an outreach email', APPROVALS],
  'bizdev-01': ['bizdev/01-hubspot-link.png', 'HubSpot Companies description link', ['frontend/src/pages/api-new.tsx']],
  'bizdev-02': ['bizdev/02-hubspot-default-key.png', 'HubSpot: a sign-in needed', SETUP],
  'bizdev-03': ['bizdev/03-hubspot-bearer.png', 'HubSpot sign-in form, with pasting a token instead', SETUP],
  'bizdev-04': ['bizdev/04-hubspot-token.png', 'HubSpot private app token', SETUP],
  'bizdev-05': ['bizdev/05-apis.png', 'HubSpot and Google APIs', ['frontend/src/pages/apis.tsx']],
  'bizdev-06': ['bizdev/06-agent-instructions.png', 'Biz-dev assistant: model, instructions, memory', BUILDER],
  'bizdev-07': ['bizdev/07-agent-tools.png', 'Biz-dev assistant: tools', BUILDER],
  'bizdev-08': ['bizdev/08-slack-channel.png', 'Slack channel', CHANNEL],
  'bizdev-09': ['bizdev/09-slack-token.png', 'Slack bot token', CHANNEL],
  'bizdev-10': ['bizdev/10-slack-live.png', 'Slack channel, live', CHANNEL],
  'bizdev-11': ['bizdev/11-always-on.png', 'Always on: standing instructions and timer', ALWAYS_ON],
  'bizdev-12': ['bizdev/12-ask-first.png', 'Always on: ask before sending email', ALWAYS_ON],
  'bizdev-13': ['bizdev/13-always-on-card.png', 'Always on, on the agent page', AGENT],
  'bizdev-14': ['bizdev/14-approve-note.png', 'Approve with a note', APPROVALS],
  'bizdev-15': ['bizdev/15-followup-approval.png', 'The follow-up waiting for approval', APPROVALS],
  'bizdev-16': ['bizdev/16-slack-reports.png', 'Biz-dev reports as posted to Slack', ['frontend/src/pages/agent-always-on.tsx', 'backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']],
  'bizdev-17': ['bizdev/17-what-woke-it.png', 'What woke it lately', ALWAYS_ON],
}
// Shots of what the stand-in received, rendered as a page, and the route the message came from.
const RENDERED = { 'founder-00': '/agents/:id/schedule', 'bizdev-16': '/agents/:id/always-on' }

// ---------- the account ----------

async function account() {
  if (sql(`SELECT count(*) FROM users WHERE email = '${MAYA.email}'`) === '0') {
    const r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(MAYA) })
    if (!r.ok) throw new Error(`register ${r.status} ${await r.text()}`)
  }
  // Nobody can click the verification mail on a local stack.
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${MAYA.email}'`)
  const org = sql(`SELECT o.id || '|' || o.slug FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${MAYA.email}' AND o.name = '${MAYA.organizationName}' LIMIT 1`)
  const [orgId, slug] = org.split('|')
  // The stand-in is on localhost: the organization says that host is its own.
  sql(`UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
  return { orgId, slug }
}

// ---------- the browser ----------

const HIDE = '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }'

async function session(browser) {
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'dark', timezoneId: 'UTC', locale: 'en-US', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark') } catch {} })
  // A real sign-in page is never opened.
  await ctx.route(/accounts\.google\.com|app\.hubspot\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Stopped before the real sign-in page (local demo).</p>' }))
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.goto('/auth/login')
  await page.locator('#email').fill(MAYA.email)
  await page.locator('#password').fill(MAYA.password)
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
    console.log('shot', name, RENDERED[name] ?? url.pathname)
  }
  const top = (locator, offset = 120) => locator.evaluate((e, o) => { e.scrollIntoView({ block: 'start' }); const m = document.querySelector('main'); if (m) m.scrollBy(0, -o); window.scrollBy(0, -o) }, offset)
  const id = () => page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]
  // Show a page of HTML (an email, Slack messages) and take it whole.
  const render = async (name, html) => {
    const file = join(OUT, `${name}.html`)
    writeFileSync(file, html)
    await page.goto(`file://${file}`)
    await wait(800)
    await shot(name, { fullPage: true })
  }
  return { wait, shot, top, id, render }
}

// Tick the tools by their machine names in the agent builder's picker.
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

async function approveAll(page, note) {
  for (let i = 0; i < 8; i++) {
    await page.goto('/approvals')
    await page.waitForTimeout(2500)
    const btn = page.getByRole('button', { name: 'Approve', exact: true }).first()
    if (!(await btn.count())) return i
    await btn.click()
    await page.waitForTimeout(700)
    if (note) await page.getByRole('textbox', { name: 'Note (optional)' }).fill(note)
    await page.getByRole('form', { name: 'Approve this action' }).getByRole('button', { name: 'Approve' }).click()
    await page.waitForTimeout(6000)
  }
  return 8
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

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const PAGE = (title, body, note) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:860px;margin:32px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.head{padding:20px 28px;border-bottom:1px solid #e4e4e7}.subj{font-size:22px;font-weight:600;margin-bottom:10px}
.meta{font-size:14px;color:#52525b;line-height:1.6}.body{padding:24px 28px;font-size:15px;line-height:1.55}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px;border-bottom:1px solid #f4f4f5}
.who{font-weight:600;font-size:15px;margin-bottom:4px}.who span{font-size:10px;background:#e4e4e7;border-radius:3px;padding:1px 4px;margin-left:4px;color:#52525b}
.text{white-space:pre-wrap;font-size:15px;line-height:1.5}a{color:#1264a3}
.note{max-width:860px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>${body}<div class="note">${escapeHtml(note)}</div></body></html>`

// Slack mrkdwn as Slack shows it: *bold*, <url|text>, bullets as written.
const slackHtml = (text) => escapeHtml(text)
  .replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>')
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1<b>$2</b>')

// ---------- the founder's associate ----------

async function founder(page, h) {
  // 1. A model
  await page.goto('/models/providers/new')
  await page.getByLabel('Name', { exact: true }).fill('OpenAI')
  await page.getByRole('combobox', { name: 'Provider' }).click()
  await page.getByPlaceholder('Search providers').fill('OpenAI')
  await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
  await h.wait(500)
  await page.getByLabel(/API key/).first().fill('sk-proj-0000000000000000000000000000000000000000')
  await h.shot('founder-01')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/models\/providers\/[0-9a-f-]{36}/, { timeout: 60000 })
  await h.wait(1500)
  await h.shot('founder-02')

  // 3. Google Calendar
  await page.goto('/apis/new')
  await h.wait(1200)
  await h.shot('founder-03')
  await page.getByRole('button', { name: /OpenAPI \/ Swagger/ }).click()
  await page.getByLabel('Link to the description').fill('https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest')
  await h.shot('founder-04')
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Google Calendar')
  await page.getByLabel('Address', { exact: true }).fill(`${UP}/calendar/v3`) // the local stand-in
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 60000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 120000 })
  await h.wait(800)
  await h.shot('founder-05')
  await page.getByRole('button', { name: 'Create one here' }).click()
  await page.getByLabel('Client ID').fill('123456789012-abc123def456.apps.googleusercontent.com')
  await page.getByLabel('Client secret').fill('GOCSPX-local-test-secret')
  await page.getByTestId('api-oauth-redirect').waitFor({ timeout: 10000 })
  // Only the two read-only calendar permissions stay ticked.
  for (const cb of await page.getByTestId('api-oauth-scopes').getByRole('checkbox').all()) {
    const scope = (await cb.getAttribute('aria-label')) || ''
    if (/calendar\.readonly$|calendar\.events\.readonly$/.test(scope)) await cb.check(); else await cb.uncheck()
  }
  await page.getByTestId('api-oauth-scopes').locator('.overflow-y-auto').evaluate((e) => { e.scrollTop = 0 })
  await h.top(page.getByTestId('api-oauth-redirect'))
  await h.shot('founder-06')
  // A real sign-in goes to Google here; the local stand-in takes a pasted token.
  await page.getByRole('button', { name: 'Paste an access token instead' }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Google account (Maya)')
  await page.getByRole('textbox', { name: 'Access token' }).fill('local-test-google-token')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) })
  await h.shot('founder-07')

  // 4. Gmail and Google Tasks
  await connectApi(page, { link: 'https://gmail.googleapis.com/$discovery/rest?version=v1', name: 'Gmail', address: `${UP}/` })
  await pickSignIn(page, /Google account \(Maya\)/)
  await connectApi(page, { link: 'https://tasks.googleapis.com/$discovery/rest?version=v1', name: 'Google Tasks', address: `${UP}/` })
  await pickSignIn(page, /Google account \(Maya\)/)
  await page.goto('/apis')
  await h.wait(1500)
  await h.shot('founder-08')

  // 5. Check a tool
  await page.goto('/tools')
  await h.wait(1200)
  await page.getByPlaceholder('Search tools...').fill('calendar_events_list')
  await h.wait(1500)
  await h.shot('founder-09')
  await page.getByText('google_calendar_calendar_events_list', { exact: true }).first().click()
  await h.wait(1500)
  await page.getByRole('tab', { name: 'Test tool' }).click()
  await page.getByPlaceholder('Enter calendarId').fill('primary')
  await page.getByRole('button', { name: 'Execute Tool' }).click()
  await page.getByText('Response Data:').waitFor({ timeout: 20000 })
  await page.getByText('Response Data:').scrollIntoViewIfNeeded()
  await h.shot('founder-10')

  // 6. The assistant
  await page.goto('/agents/new')
  await page.getByRole('button', { name: 'Autonomous' }).click()
  await page.getByRole('textbox', { name: 'Agent name' }).fill("Founder's associate")
  await page.getByRole('combobox', { name: 'Model' }).first().click()
  await page.getByRole('option', { name: /gpt-4o(?!-mini)/ }).first().click()
  await page.getByRole('textbox', { name: 'Personality and style' }).fill(
    'Calm, brief and specific, like a trusted chief of staff. Facts first, no filler. If something is unclear or missing, say so instead of guessing.')
  await page.getByRole('textbox', { name: 'Instructions' }).fill(`You are Maya's associate at Lumen.

Every morning, write Maya a short brief for the day:
1. Conflicts first: any meetings that overlap, across all her calendars (work, team and personal), with a suggestion for which one to move.
2. Today's meetings from all her calendars, in time order.
3. Open tasks that are due today or overdue.
4. The top three priorities for the day, based on the meetings, the tasks and recent emails.

Before each meeting with someone from outside the company, add a short prep note: who they are, how Maya knows them (check what you remember and past emails), what was discussed last time, and the open points.

Remember new facts about people: who introduced whom, where they work, what they care about.

Only read calendars, emails and tasks. Never send email, answer invitations or change tasks.`)
  await h.shot('founder-11')
  await page.getByRole('switch', { name: 'Remember between conversations' }).click()
  await page.getByRole('combobox', { name: 'Whose memory' }).click()
  await page.getByRole('option', { name: /This agent's own/ }).click()
  await page.getByRole('combobox', { name: 'What it saves' }).click()
  await page.getByRole('option', { name: /Facts it learns/ }).click()
  await page.getByRole('heading', { name: 'Memory' }).scrollIntoViewIfNeeded()
  await h.shot('founder-12')
  await pickTools(page, ['google_calendar_calendar_calendar_list_list', 'google_calendar_calendar_events_list', 'gmail_gmail_users_messages_list', 'gmail_gmail_users_messages_get', 'google_tasks_tasks_tasklists_list', 'google_tasks_tasks_tasks_list'])
  await page.getByRole('heading', { name: 'Tools and APIs' }).scrollIntoViewIfNeeded()
  await h.shot('founder-13')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
  const agent = h.id()

  // 7. Try it
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('button', { name: 'Activate' }).click()
  await h.wait(1500)
  const box = page.getByPlaceholder('Type a message to test this agent...')
  await box.fill('Write my morning brief for today.')
  await box.press('Enter')
  await page.getByText(/Conflicts/).first().waitFor({ timeout: 90000 })
  await h.wait(1500)
  await page.getByRole('heading', { name: 'Try it' }).scrollIntoViewIfNeeded()
  await h.shot('founder-14')
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('tab', { name: 'Runs' }).click()
  await h.wait(1500)
  await page.locator('main tbody tr').first().click()
  await h.wait(1500)
  await h.shot('founder-15')
  await page.getByRole('tab', { name: 'Memory' }).click()
  await h.wait(1500)
  await h.shot('founder-21')

  // 8. The email channel
  await page.goto(`/agents/${agent}/channels/new`)
  await h.wait(1200)
  await h.shot('founder-16')
  await page.getByRole('button', { name: /^Email/ }).click()
  await h.wait(2000)
  await page.getByRole('button', { name: 'Create one here' }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Resend (Lumen)')
  await page.getByRole('textbox', { name: 'API key' }).fill('re_localtest_0123456789abcdef')
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('textbox', { name: 'From address' }).fill('associate@lumen.example')
  await page.getByRole('textbox', { name: 'Inbound address' }).fill('associate@in.lumen.example')
  await page.getByRole('textbox', { name: 'From address' }).scrollIntoViewIfNeeded()
  await h.shot('founder-17')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await h.wait(4000)
  const save = page.getByRole('button', { name: 'Save', exact: true }).last()
  if (await save.isEnabled().catch(() => false)) { await save.click(); await h.wait(2500) }
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByText(/Live|Published/).first().waitFor({ timeout: 20000 }).catch(() => {})
  await h.wait(2000)
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) })
  await h.shot('founder-18')

  // 9. Every morning
  const schedule = async (time, shotName) => {
    await page.goto(`/agents/${agent}/schedule`)
    await h.wait(1500)
    await page.getByRole('textbox', { name: 'Time' }).fill(time)
    await page.getByRole('combobox', { name: 'Where' }).click()
    await page.getByRole('option', { name: /Email/ }).first().click()
    await h.wait(600)
    const to = page.getByRole('textbox', { name: /address|Email/i })
    if (await to.count()) await to.first().fill(MAYA.email)
    await page.getByRole('textbox', { name: 'Message' }).fill('Write my morning brief for today: conflicts first, then meetings, tasks due, top three priorities, and a prep note for every meeting with someone from outside the company.')
    if (shotName) await h.shot(shotName)
    await page.getByRole('button', { name: 'Save schedule' }).click()
    await h.wait(2000)
  }
  await schedule('07:00', 'founder-19')
  await page.getByRole('heading', { name: 'Schedule' }).scrollIntoViewIfNeeded()
  await h.shot('founder-20')

  // The brief as it arrives: the schedule set to the next minutes once, then back to 07:00.
  const soon = new Date(Date.now() + 2 * 60000)
  await schedule(`${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')}`)
  const mail = await until('the morning brief email', async () => {
    const state = await upstream('/_admin/state')
    return state.outbox.filter((o) => o.url.includes('resend') && JSON.stringify(o.body ?? '').includes(MAYA.email)).pop()?.body
  }, 300000)
  await schedule('07:00')
  await h.render('founder-00', PAGE(mail.subject, `<div class="wrap"><div class="head"><div class="subj">${escapeHtml(mail.subject)}</div>
<div class="meta">From: ${escapeHtml(mail.from)}<br>To: ${escapeHtml([].concat(mail.to).join(', '))}</div></div><div class="body">${mail.html}</div></div>`,
  'The email exactly as almyty handed it to the email provider (local demo; nothing was sent).'))
}

// ---------- the biz-dev assistant ----------

function slackEvent(slug, gatewayId, text) {
  const ts = String(Math.floor(Date.now() / 1000))
  const body = JSON.stringify({
    token: 'x', team_id: 'T0LUMEN', api_app_id: 'A0APP', type: 'event_callback', event_id: `Ev${Date.now()}`, event_time: Number(ts),
    event: { type: 'message', channel_type: 'im', channel: 'D0MAYA', user: 'U0MAYA', text, ts: `${ts}.000100`, event_ts: `${ts}.000100` },
  })
  const sig = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')
  return fetch(`${API}/${slug}/channels/${gatewayId}`, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts } })
}

async function bizdev(page, h, { slug }) {
  // 1. HubSpot, in three parts
  const R = 'https://raw.githubusercontent.com/HubSpot/HubSpot-public-api-spec-collection/main/PublicApiSpecs/CRM/'
  const parts = [['Companies/Rollouts/424/v3/companies.json', 'HubSpot Companies'], ['Contacts/Rollouts/424/v3/contacts.json', 'HubSpot Contacts'], ['Deals/Rollouts/424/v3/deals.json', 'HubSpot Deals']]
  let first = true
  for (const [path, name] of parts) {
    await page.goto('/apis/new/openapi')
    await page.getByLabel('Link to the description').fill(R + path)
    if (first) await h.shot('bizdev-01')
    await page.getByRole('button', { name: 'Advanced' }).click()
    await page.getByLabel('Name', { exact: true }).fill(name)
    await page.getByLabel('Address', { exact: true }).fill(UP) // the local stand-in
    await page.getByRole('button', { name: 'Connect API' }).click()
    await page.waitForURL(/\/setup/, { timeout: 60000 })
    await page.getByText(/Found \d+ operation/).waitFor({ timeout: 120000 })
    if (first) {
      await h.wait(800)
      await h.shot('bizdev-02')
      await page.getByRole('button', { name: 'Create one here' }).click()
      await h.wait(600)
      await page.getByRole('button', { name: 'Paste an access token instead' }).evaluate((e) => e.scrollIntoView({ block: 'end' }))
      await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollBy(0, 40); window.scrollBy(0, 40) })
      await h.shot('bizdev-03')
      await page.getByRole('button', { name: 'Paste an access token instead' }).click()
      await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('HubSpot private app')
      await page.getByRole('textbox', { name: /Access token|Key|token/ }).last().fill('local-demo-hubspot-token-0000000000000000000')
      await h.shot('bizdev-04')
      await page.getByRole('button', { name: 'Save', exact: true }).first().click()
      await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
    } else {
      await pickSignIn(page, /HubSpot private app/)
    }
    first = false
  }
  // Gmail is the founder tutorial's: the biz-dev tutorial starts with it connected.
  await page.goto('/apis')
  await h.wait(1500)
  await h.shot('bizdev-05')

  // 2. The assistant
  await page.goto('/agents/new')
  await page.getByRole('button', { name: 'Autonomous' }).click()
  await page.getByRole('textbox', { name: 'Agent name' }).fill('Biz-dev assistant')
  await page.getByRole('combobox', { name: 'Model' }).first().click()
  await page.getByRole('option', { name: /gpt-4o(?!-mini)/ }).first().click()
  await page.getByRole('textbox', { name: 'Personality and style' }).fill(
    'Warm, direct and brief. Writes like a founder, not like a marketer: no buzzwords, no exclamation marks, one clear ask.')
  await page.getByRole('textbox', { name: 'Instructions' }).fill(`You help Maya at Lumen with business development (outreach to new prospects).

Target profile: logistics, trucking or courier companies with 100 or more employees that are still a "lead" in the CRM.

When Maya asks you to find prospects:
1. Search the CRM for companies that match the target profile.
2. For each one, find the decision maker: the COO, a VP or the Head of Operations.
3. Skip anyone Maya has emailed in the last 30 days.
4. Write each person a short, personal email (under 120 words) that mentions something specific about their company, and send it from Maya's Gmail. Every email waits for Maya's approval before it goes out.
5. Add a deal for each company you wrote to, with a note of when to follow up.
6. Write a LinkedIn message for each person for Maya to send herself. Never send anything on LinkedIn.

At every wake, check for replies to your outreach:
- When someone replied, move their deal to "Qualified to buy" and tell Maya what they said.
- When someone has not answered after 3 days, send one short follow-up in the same email thread. It waits for approval too. Never follow up more than once.`)
  await page.getByRole('switch', { name: 'Remember between conversations' }).click()
  await page.getByRole('combobox', { name: 'Whose memory' }).click()
  await page.getByRole('option', { name: /This agent's own/ }).click()
  await page.getByRole('combobox', { name: 'What it saves' }).click()
  await page.getByRole('option', { name: /Facts it learns/ }).click()
  await h.shot('bizdev-06')
  await pickTools(page, [
    'hubspot_companies_post_crm_v3_objects_companies_search_do_search',
    'hubspot_contacts_post_crm_v3_objects_contacts_search_do_search',
    'hubspot_deals_post_crm_v3_objects_0_3_create',
    'hubspot_deals_post_crm_v3_objects_0_3_search_do_search',
    'hubspot_deals_patch_crm_v3_objects_0_3_deal_id_update',
    'gmail_gmail_users_messages_list',
    'gmail_gmail_users_messages_send',
    'gmail_gmail_users_threads_get',
  ])
  await page.getByText('Tools and APIs').first().scrollIntoViewIfNeeded()
  await h.shot('bizdev-07')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
  const agent = h.id()
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('button', { name: 'Activate' }).click()
  await h.wait(1500)

  // 3. Slack
  await page.goto(`/agents/${agent}/channels/new`)
  await h.wait(1200)
  await page.getByRole('button', { name: /^Slack/ }).click()
  await h.wait(2000)
  await h.shot('bizdev-08')
  await page.getByRole('button', { name: /^Advanced/ }).click()
  await page.getByRole('button', { name: 'Create one here' }).last().click()
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('radio', { name: 'Bot token' }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Slack bot (Lumen)')
  await page.getByRole('textbox', { name: 'Bot user OAuth token' }).fill('xoxb-local-test-0000000000-111111111')
  await page.getByRole('textbox', { name: 'Signing secret' }).fill(SLACK_SIGNING_SECRET)
  await page.getByRole('textbox', { name: 'Bot user OAuth token' }).scrollIntoViewIfNeeded()
  await h.shot('bizdev-09')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await h.wait(4000)
  const save = page.getByRole('button', { name: 'Save', exact: true }).last()
  if (await save.isEnabled().catch(() => false)) { await save.click(); await h.wait(2500) }
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await h.wait(3500)
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) })
  await h.shot('bizdev-10')
  // Slack posts its events to the channel's own address.
  const channel = page.url().match(/channels\/([0-9a-f-]{36})/)[1]

  // 4. Always on
  await page.goto(`/agents/${agent}/always-on`)
  await h.wait(1500)
  await page.getByRole('textbox', { name: 'Standing instructions' }).fill(
    'Keep the outreach moving. At every wake, check Maya\'s sent emails for replies from the prospects you wrote to. When someone replied, move their deal to "Qualified to buy" and tell Maya what they said. When someone has not answered for 3 days, send one short, friendly follow-up in the same thread (Maya approves it first). Never follow up twice.')
  await page.getByRole('spinbutton', { name: 'Every' }).fill('4')
  await page.getByRole('combobox', { name: 'Unit' }).click()
  await page.getByRole('option', { name: 'hours' }).click()
  await page.getByRole('combobox', { name: 'Channel' }).click()
  await page.getByRole('option', { name: /Slack/ }).first().click()
  await h.wait(500)
  await page.getByRole('textbox', { name: 'Your address there' }).fill('U0MAYA')
  await page.getByRole('combobox', { name: 'On its own, it' }).click()
  await page.getByRole('option', { name: /Does things/ }).click()
  await h.wait(800)
  // Only Gmail's send stays on the ask-first list; it adds and moves deals on its own.
  for (const cb of await page.getByRole('checkbox', { name: /^hubspot_/ }).all()) if (await cb.isChecked()) await cb.uncheck()
  await page.getByRole('combobox', { name: 'Post reports to' }).click()
  await page.getByRole('option', { name: /Slack/ }).first().click()
  await h.wait(600)
  await page.getByPlaceholder('C0123ABCDEF').fill('C0SALES')
  await page.getByRole('switch', { name: 'Always on' }).click()
  await page.getByRole('heading', { name: 'What wakes it' }).scrollIntoViewIfNeeded()
  await h.shot('bizdev-11')
  await h.top(page.getByText('Ask me first before', { exact: true }), 260)
  await h.shot('bizdev-12')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await h.wait(2500)
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('heading', { name: 'Always on' }).scrollIntoViewIfNeeded()
  await h.shot('bizdev-13')

  // 5. "Find new prospects" in Slack, then the emails wait for approval
  const r = await slackEvent(slug, channel, 'Find new prospects that match our target profile and reach out to them.')
  if (!r.ok) throw new Error(`slack event ${r.status} ${await r.text()}`)
  await until('the first outreach approval', async () => sql(`SELECT count(*) FROM approval_requests WHERE "organizationId" = (SELECT "organizationId" FROM agents WHERE id = '${agent}') AND status = 'pending'`) !== '0', 120000)
  await h.wait(3000)
  await page.goto('/approvals')
  await h.wait(3000)
  await h.shot('bizdev-00')
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click()
  await h.wait(700)
  await page.getByRole('textbox', { name: 'Note (optional)' }).fill('Looks good, send it.')
  await h.shot('bizdev-14')
  await page.getByRole('form', { name: 'Approve this action' }).getByRole('button', { name: 'Approve' }).click()
  await h.wait(6000)
  await approveAll(page, 'Looks good, send it.')

  // 6. Three days later: one prospect answered, one did not
  // Its reports in the sales channel (it also says there when something waits for approval).
  const salesReports = async () => (await upstream('/_admin/state')).outbox.filter((o) => o.url.includes('chat.postMessage') && o.body?.channel === 'C0SALES' && /Outreach, |Follow-up check/.test(o.body?.text ?? ''))
  await until('the outreach report in Slack', async () => (await salesReports()).length > 0, 120000)
  await upstream('/_admin/age?days=4', { method: 'POST' })
  await upstream('/_admin/reply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: 'jonas.weber@bluefin.example', body: 'Hi Maya, good timing: we are adding two depots next quarter and planning is already painful. Could we talk Tuesday afternoon?' }) })
  await page.goto(`/agents/${agent}`)
  await h.wait(2000)
  await page.getByRole('button', { name: 'Wake now' }).click()
  await until('the follow-up approval', async () => sql(`SELECT count(*) FROM approval_requests WHERE "organizationId" = (SELECT "organizationId" FROM agents WHERE id = '${agent}') AND status = 'pending'`) !== '0', 120000)
  await h.wait(3000)
  await page.goto('/approvals')
  await h.wait(3000)
  await h.shot('bizdev-15')
  await approveAll(page)
  const reports = await until('the follow-up report in Slack', async () => {
    const posted = (await salesReports()).map((o) => o.body.text)
    return posted.length >= 2 ? posted : null
  }, 120000)
  await page.goto(`/agents/${agent}/always-on`)
  await h.wait(2000)
  await page.getByRole('heading', { name: 'What woke it lately' }).scrollIntoViewIfNeeded()
  await h.shot('bizdev-17')
  await h.render('bizdev-16', PAGE('Slack messages', `<div class="wrap"><div class="chan">#sales</div>${reports.map((t) => `<div class="msg"><div class="who">Biz-dev assistant <span>APP</span></div><div class="text">${slackHtml(t)}</div></div>`).join('')}</div>`,
    'The messages exactly as almyty posted them to Slack, shown the way Slack formats them (local demo; Slack itself was not used).'))
}

// ---------- run ----------

async function walk(names, { fresh }) {
  // --fresh: Maya's account and organization go first, so the walk starts where a new customer starts.
  if (fresh) {
    sql(`DELETE FROM organizations WHERE id IN (SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${MAYA.email}')`)
    sql(`DELETE FROM users WHERE email = '${MAYA.email}'`)
  }
  // The stand-in keeps what was sent; a used one would mix an earlier run into these pictures.
  if (names.includes('founder') && (await upstream('/_admin/state')).outbox.length) {
    throw new Error(`${UP} already holds messages from an earlier run: restart it (stack.sh down, then USECASES=1 stack.sh up)`)
  }
  const { slug } = await account()
  const browser = await chromium.launch()
  const { ctx, page } = await session(browser)
  const h = helpers(page)
  try {
    if (names.includes('founder')) await founder(page, h)
    if (names.includes('bizdev')) await bizdev(page, h, { slug })
  } catch (e) {
    console.log('FAILED', e.message.split('\n')[0])
    await page.screenshot({ path: join(OUT, 'FAILED.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    writeFileSync(join(OUT, 'captures.json'), JSON.stringify(results, null, 2))
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
    const notes = 'Tutorial step, walked through the UI on the local demo stack with USECASES=1 (scripts/demo-seed/usecases/tutorials.mjs): real public API descriptions, a local stand-in for Google, HubSpot, Slack and Resend, and a scripted stand-in model; fictional people and companies. Not staging or production data.' +
      (RENDERED[shot] ? ' The page renders the message exactly as almyty handed it to the provider; that provider was not used.' : '')
    execFileSync(process.execPath, [join(ROOT, 'docs-site/scripts/record-screenshot.mjs'), '--image', c.file, '--path', `screenshots/tutorials/${path}`, '--title', title, '--captured-at', c.at, '--route', route, '--environment', 'local-demo',
      '--notes', notes, ...[...sources, ...UI].flatMap((s) => ['--sources', s])], { stdio: 'inherit' })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--register') register(args.slice(1))
else {
  const fresh = args.includes('--fresh')
  const names = args.filter((a) => a !== '--fresh')
  await walk(names.length ? names : ['founder', 'bizdev'], { fresh })
}