#!/usr/bin/env node
// Walks the five engineering examples in docs-site/content/examples through
// the UI, step by step as their text says, and takes the screenshots they
// show into $SHOT_DIR/examples (default /tmp/almyty-demo/shots/examples):
// sort GitHub issues (triage), a first pass on pull requests (review),
// on-call summaries from PagerDuty (oncall), an old SOAP service (soap) and
// several coding assistants through a runner (fleet).
//
// It needs the demo stack (stack.sh up, with USECASES=1 so Slack goes to the
// stand-in) and engineering-upstream.mjs running: a stand-in for GitHub,
// PagerDuty, a SOAP stock system and a scripted model. The API descriptions
// of GitHub and PagerDuty are their real public ones (GitHub's cut down by
// engineering-github-subset.mjs); only the address is the stand-in's, set
// under Advanced when connecting. Nothing reaches a real account, except in
// the fleet walk: there a real runner (@almyty/runner, from
// ALMYTY_RUNNER_BIN or PATH) runs the Claude Code and Codex installed and
// signed in on this machine, on a small sample library it writes to
// /tmp/tidewater/ledgerly-utils.
//
// It works as Ines Duarte of "Tidewater Labs" (a local test account).
//
//   node engineering-guides.mjs triage review oncall soap fleet [--fresh]
//   node engineering-guides.mjs --register [shot...]
import { createRequire } from 'node:module'
import { execSync, execFileSync, spawn } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../..')
const require = createRequire(join(ROOT, 'frontend/package.json'))
const { chromium } = require('@playwright/test')

const WEB = process.env.DEMO_WEB_URL || 'http://localhost:3210'
const API = process.env.DEMO_API_URL || 'http://localhost:4210'
const UP = process.env.ENG_UPSTREAM_URL || 'http://localhost:4292'
const SLACK_UP = process.env.DEMO_USECASE_URL || 'http://localhost:4291'
const PSQL = process.env.DEMO_PSQL || 'docker exec -i almyty-demo-pg psql -U postgres -d almyty_qa'
const OUT = join(process.env.SHOT_DIR || '/tmp/almyty-demo/shots', 'examples')
const GITHUB_FILE = join(ROOT, 'docs-site/public/files/github-issues-and-pulls.openapi.json')
mkdirSync(OUT, { recursive: true })

export const INES = { email: 'ines.duarte@tidewater.example', password: 'Tidewater-Labs-2026!', firstName: 'Ines', lastName: 'Duarte', organizationName: 'Tidewater Labs' }
const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()
const upstream = async (path, init) => (await fetch(`${UP}${path}`, init)).json()

// ---------- screenshots: key -> [published path under screenshots/examples, title, sources] ----------

const UI = ['frontend/src/components/ui', 'frontend/src/components/layout', 'frontend/src/index.css']
const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const MODELS = ['frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers']
const API_NEW = ['frontend/src/pages/api-new-description.tsx']
const API_PAGE = ['frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const TOOL = ['frontend/src/pages/tool-detail.tsx']
const SCHEDULE = ['frontend/src/pages/agent-schedule.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const ALWAYS_ON = ['frontend/src/pages/agent-always-on.tsx']
const RUNNERS = ['frontend/src/pages/runners.tsx', 'frontend/src/pages/runner-new.tsx', 'frontend/src/pages/runner-detail.tsx']
const GATEWAYS = ['frontend/src/pages/gateway-new.tsx', 'frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways']

export const SHOTS = {
  'triage-00-result': ['github-issue-triage/00-result.png', 'Issue triage: the report of a run', AGENT],
  'triage-01-model': ['github-issue-triage/01-model.png', 'OpenAI connected', MODELS],
  'triage-02-connect': ['github-issue-triage/02-connect.png', 'Connect an API: the GitHub file', API_NEW],
  'triage-03-key': ['github-issue-triage/03-key.png', 'GitHub token as a bearer token', SETUP],
  'triage-04-api': ['github-issue-triage/04-api.png', 'GitHub connected: 12 tools', API_PAGE],
  'triage-05-test-tool': ['github-issue-triage/05-test-tool.png', 'Testing github_issues_list_for_repo', TOOL],
  'triage-06-agent': ['github-issue-triage/06-agent.png', 'Issue triage: model and instructions', BUILDER],
  'triage-07-tools': ['github-issue-triage/07-tools.png', 'Issue triage: five tools', BUILDER],
  'triage-08-try': ['github-issue-triage/08-try.png', 'Issue triage: Try it', AGENT],
  'triage-09-run': ['github-issue-triage/09-run.png', 'Issue triage: the run step by step', AGENT],
  'triage-10-schedule': ['github-issue-triage/10-schedule.png', 'Issue triage: every hour', SCHEDULE],

  'review-00-on-github': ['pr-review-bot/00-review-on-github.png', 'The review as sent to GitHub', ['backend/src/modules/tools/executors/tool-http.executor.ts']],
  'review-01-model': ['pr-review-bot/01-model.png', 'OpenAI connected', MODELS],
  'review-02-connect': ['pr-review-bot/02-connect.png', 'Connect an API: the GitHub file', API_NEW],
  'review-03-key': ['pr-review-bot/03-key.png', 'GitHub token as a bearer token', SETUP],
  'review-04-api': ['pr-review-bot/04-api.png', 'GitHub connected: 12 tools', API_PAGE],
  'review-05-agent': ['pr-review-bot/05-agent.png', 'Pull request review: model and instructions', BUILDER],
  'review-06-tools': ['pr-review-bot/06-tools.png', 'Pull request review: five tools', BUILDER],
  'review-07-try': ['pr-review-bot/07-try.png', 'Pull request review: Try it', AGENT],
  'review-08-run': ['pr-review-bot/08-run.png', 'Pull request review: the run step by step', AGENT],
  'review-09-schedule': ['pr-review-bot/09-schedule.png', 'Pull request review: every 30 minutes', SCHEDULE],

  'oncall-00-slack': ['oncall-alert-triage/00-slack.png', 'The on-call summary as posted to Slack', ['frontend/src/pages/agent-always-on.tsx', 'backend/src/modules/gateways/channels/adapters/slack.adapter.ts', 'backend/src/modules/gateways/channels/adapters/channel-markdown.ts']],
  'oncall-01-model': ['oncall-alert-triage/01-model.png', 'OpenAI connected', MODELS],
  'oncall-02-connect': ['oncall-alert-triage/02-connect.png', "PagerDuty's description link", API_NEW],
  'oncall-03-found': ['oncall-alert-triage/03-found.png', 'PagerDuty: 473 tools made, a key needed', SETUP],
  'oncall-04-key': ['oncall-alert-triage/04-key.png', 'The PagerDuty key', SETUP],
  'oncall-05-agent': ['oncall-alert-triage/05-agent.png', 'On-call summaries: model and instructions', BUILDER],
  'oncall-06-tools': ['oncall-alert-triage/06-tools.png', 'On-call summaries: four PagerDuty tools', BUILDER],
  'oncall-07-slack-key': ['oncall-alert-triage/07-slack-key.png', 'Slack bot token and signing secret', CHANNEL],
  'oncall-08-slack-live': ['oncall-alert-triage/08-slack-live.png', 'Slack channel, live', CHANNEL],
  'oncall-09-always-on': ['oncall-alert-triage/09-always-on.png', 'Always on: every 15 minutes', ALWAYS_ON],
  'oncall-10-act': ['oncall-alert-triage/10-act.png', 'Always on: acts on its own', ALWAYS_ON],
  'oncall-11-card': ['oncall-alert-triage/11-card.png', 'The Always on card', AGENT],

  'soap-00-result': ['modernize-legacy-soap/00-result.png', 'Stock assistant: an answer from the SOAP system', AGENT],
  'soap-01-connect': ['modernize-legacy-soap/01-connect.png', 'Connect an API: the WSDL file', ['frontend/src/pages/api-new-description.tsx']],
  'soap-02-api': ['modernize-legacy-soap/02-api.png', 'The SOAP service connected: three tools', API_PAGE],
  'soap-03-key': ['modernize-legacy-soap/03-key.png', 'The service account as a username and password', SETUP],
  'soap-04-test-tool': ['modernize-legacy-soap/04-test-tool.png', 'Testing the stock level tool', TOOL],
  'soap-05-agent': ['modernize-legacy-soap/05-agent.png', 'Stock assistant: model and instructions', BUILDER],
  'soap-06-tools': ['modernize-legacy-soap/06-tools.png', 'Stock assistant: three tools', BUILDER],
  'soap-07-try': ['modernize-legacy-soap/07-try.png', 'Stock assistant: Try it', AGENT],
  'soap-08-run': ['modernize-legacy-soap/08-run.png', 'Stock assistant: the run step by step', AGENT],
  'soap-09-gateway-new': ['modernize-legacy-soap/09-gateway-new.png', 'Create gateway: MCP with the stock tools', GATEWAYS],
  'soap-10-gateway': ['modernize-legacy-soap/10-gateway.png', 'The MCP gateway and its Claude Code command', GATEWAYS],

  'fleet-00-result': ['multi-vendor-coding-fleet/00-result.png', 'Coding lead: the report of a run', AGENT],
  'fleet-01-model': ['multi-vendor-coding-fleet/01-model.png', 'OpenAI connected', MODELS],
  'fleet-02-start-runner': ['multi-vendor-coding-fleet/02-start-runner.png', 'Start a runner: the commands', RUNNERS],
  'fleet-03-runners': ['multi-vendor-coding-fleet/03-runners.png', 'The runner, online', RUNNERS],
  'fleet-04-runner': ['multi-vendor-coding-fleet/04-runner.png', 'The coding assistants the runner found', RUNNERS],
  'fleet-05-agent': ['multi-vendor-coding-fleet/05-agent.png', 'Coding lead: model and instructions', BUILDER],
  'fleet-06-tools': ['multi-vendor-coding-fleet/06-tools.png', 'Coding lead: the runner tools', BUILDER],
  'fleet-07-only-you': ['multi-vendor-coding-fleet/07-only-you.png', 'Coding lead: only you', BUILDER],
  'fleet-08-try': ['multi-vendor-coding-fleet/08-try.png', 'Coding lead: Try it', AGENT],
  'fleet-09-run': ['multi-vendor-coding-fleet/09-run.png', 'Coding lead: the run step by step', AGENT],
}
// Shots of what a stand-in received, rendered as a page, and the route the message came from.
const RENDERED = { 'review-00-on-github': '/agents/:id', 'oncall-00-slack': '/agents/:id/always-on' }

// ---------- the account ----------

// Sign-in is rate limited per account; a walk right after another waits its turn.
async function login() {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: INES.email, password: INES.password }) })
    if (r.status !== 429) return r.headers.getSetCookie().map((c) => c.split(';')[0])
    await new Promise((ok) => setTimeout(ok, 60000))
  }
  throw new Error('still rate limited after 20 minutes')
}

async function account() {
  if (sql(`SELECT count(*) FROM users WHERE email = '${INES.email}'`) === '0') {
    const r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(INES) })
    if (!r.ok) throw new Error(`register ${r.status} ${await r.text()}`)
  }
  // Nobody can click the verification mail on a local stack.
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${INES.email}'`)
  // A fresh walk removed her organization: she makes a new one, as a signed-in user can.
  const mine = () => sql(`SELECT o.id FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${INES.email}' AND o.name = '${INES.organizationName}' LIMIT 1`)
  if (!mine()) {
    const cookie = (await login()).join('; ')
    const r = await fetch(`${API}/organizations`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: INES.organizationName, slug: 'tidewater-labs' }) })
    if (!r.ok) throw new Error(`organization ${r.status} ${await r.text()}`)
  }
  // The stand-in is on localhost: the organization says that host is its own.
  sql(`UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${mine()}'`)
}

// ---------- the browser ----------

const HIDE = '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }'

async function session(browser) {
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'light', timezoneId: 'UTC', locale: 'en-US', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light') } catch {} })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept().catch(() => {}))
  await page.goto('/auth/login')
  await page.locator('#email').fill(INES.email)
  await page.locator('#password').fill(INES.password)
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
const remember = (name, file, route) => {
  results[name] = { file, route, at: new Date().toISOString() }
  writeFileSync(join(OUT, 'captures.json'), JSON.stringify(results, null, 2))
  console.log('shot', name, route)
}

function helpers(page) {
  const wait = (ms = 900) => page.waitForTimeout(ms)
  const shot = async (name, opts = {}) => {
    await page.addStyleTag({ content: HIDE })
    await page.mouse.move(0, 0)
    await wait()
    const file = join(OUT, `${name}.png`)
    const { route, ...shotOpts } = opts
    await page.screenshot({ path: file, ...shotOpts })
    const url = new URL(page.url())
    remember(name, file, RENDERED[name] ?? url.pathname + url.search)
  }
  const top = (locator, offset = 120) => locator.evaluate((e, o) => { e.scrollIntoView({ block: 'start' }); const m = document.querySelector('main'); if (m) m.scrollBy(0, -o); window.scrollBy(0, -o) }, offset)
  const id = () => page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]
  return { wait, shot, top, id }
}

// ---------- shared steps ----------

async function connectOpenAI(page, h, shotName) {
  await page.goto('/models/providers/new')
  await page.getByLabel('Name', { exact: true }).fill('OpenAI')
  await page.getByRole('combobox', { name: 'Provider' }).click()
  await page.getByPlaceholder('Search providers').fill('OpenAI')
  await page.getByRole('option', { name: 'OpenAI', exact: true }).click()
  await h.wait(500)
  await page.getByLabel(/API key/).first().fill('sk-proj-0000000000000000000000000000000000000000')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/models\/providers\/[0-9a-f-]{36}/, { timeout: 60000 })
  await h.wait(1500)
  if (shotName) await h.shot(shotName)
}

// "Add a key" on an API's page: pick how it is sent, then a new credential.
async function addKey(page, h, { how, name, fill, shotName }) {
  await page.getByText('Add a key').click()
  await page.getByRole('combobox', { name: 'How it is sent' }).click()
  await page.getByRole('option', { name: how }).click()
  await page.getByRole('button', { name: 'Create one here' }).click()
  await h.wait(600)
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill(name)
  await fill()
  if (shotName) { await h.top(page.getByText('How it is sent'), 200); await h.shot(shotName) }
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Key saved', { exact: true }).first().waitFor({ state: 'attached', timeout: 15000 })
  await h.wait(1000)
}

async function connectGitHub(page, h, shots = {}) {
  await page.goto('/apis/new/openapi')
  await page.getByRole('tab', { name: 'File' }).click()
  await page.locator('input[type=file]').setInputFiles(GITHUB_FILE)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill('GitHub')
  if (shots.connect) await h.shot(shots.connect)
  await page.getByLabel('Address', { exact: true }).fill(UP) // the local stand-in
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/apis\/[0-9a-f-]{36}/, { timeout: 120000 })
  await page.getByText('Tools generated').waitFor({ timeout: 120000 })
  await h.wait(1500)
  await addKey(page, h, {
    how: 'As a bearer token', name: 'GitHub token (ledgerly)', shotName: shots.key,
    fill: () => page.locator('main input[type=password]').last().fill('github_pat_11BTWLABS0dEmO0nLyLocalTestToken0000000000000000000000000000'),
  })
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) })
  if (shots.api) await h.shot(shots.api)
}

async function newAgent(page, h, { name, model = /gpt-4\.1(?!-mini)/, personality, instructions }) {
  await page.goto('/agents/new')
  await page.getByRole('button', { name: 'Autonomous' }).click()
  await page.getByRole('textbox', { name: 'Agent name' }).fill(name)
  await page.getByRole('combobox', { name: 'Model' }).first().click()
  await page.getByRole('option', { name: model }).first().click()
  if (personality) await page.getByRole('textbox', { name: 'Personality and style' }).fill(personality)
  await page.getByRole('textbox', { name: 'Instructions' }).fill(instructions)
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

async function saveAndActivate(page, h) {
  // A refused save says why only in the response, so it is printed here.
  const refused = []
  const onResponse = async (r) => { if (r.request().method() === 'POST' && /\/agents$/.test(new URL(r.url()).pathname) && r.status() >= 400) refused.push(await r.text().catch(() => '')) }
  page.on('response', onResponse)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 }).catch((e) => { throw new Error(`save refused: ${refused.join(' ') || e.message}`) })
  page.off('response', onResponse)
  const agent = h.id()
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('button', { name: 'Activate' }).click()
  await h.wait(1500)
  return agent
}

async function tryIt(page, h, message, waitFor, shotName, heroName, timeout = 120000) {
  const box = page.getByPlaceholder('Type a message to test this agent...')
  await box.fill(message)
  await box.press('Enter')
  await page.getByText(waitFor).first().waitFor({ timeout })
  await h.wait(2000)
  await page.getByRole('heading', { name: 'Try it' }).scrollIntoViewIfNeeded()
  if (shotName) await h.shot(shotName)
  if (heroName) await hero(page, h, heroName)
}

// The whole Try it card, answer included, for the top of a page.
async function hero(page, h, name) {
  await page.setViewportSize({ width: 1440, height: 2600 })
  await h.wait(800)
  const heading = page.getByRole('heading', { name: 'Try it' })
  await heading.evaluate((el) => el.scrollIntoView({ block: 'start' }))
  await h.wait(500)
  const box = await heading.evaluate((el) => {
    let card = el
    while (card.parentElement && card.getBoundingClientRect().height < 300) card = card.parentElement
    // The answer scrolls inside the card; show all of it for the picture.
    for (const d of card.querySelectorAll('*')) {
      const s = getComputedStyle(d)
      if (/(auto|scroll)/.test(s.overflowY) || s.maxHeight !== 'none') { d.style.maxHeight = 'none'; d.style.overflow = 'visible'; d.style.height = 'auto' }
    }
    const r = card.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 2550 - r.y) }
  })
  await page.addStyleTag({ content: HIDE })
  await page.mouse.move(0, 0)
  const file = join(OUT, `${name}.png`)
  await page.screenshot({ path: file, clip: { x: Math.max(0, box.x - 16), y: Math.max(0, box.y - 16), width: box.width + 32, height: box.height + 32 } })
  await page.setViewportSize({ width: 1440, height: 900 })
  remember(name, file, new URL(page.url()).pathname)
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

async function everyFew(page, h, agent, { every, unit, message, shotName }) {
  await page.goto(`/agents/${agent}/schedule`)
  await h.wait(1500)
  await page.getByRole('combobox', { name: 'Repeat' }).click()
  await page.getByRole('option', { name: 'Every few minutes or hours' }).click()
  await page.getByRole('spinbutton', { name: 'Every' }).fill(String(every))
  await page.getByRole('combobox', { name: 'Unit' }).click()
  await page.getByRole('option', { name: unit }).click()
  await page.getByRole('textbox', { name: 'Message' }).fill(message)
  await h.shot(shotName)
  await page.getByRole('button', { name: 'Save schedule' }).click()
  await h.wait(2000)
}

// A message a stand-in received, laid out the way its service shows it.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const PAGE = (title, body, note) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;background:#f6f8fa;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328}
.wrap{max-width:900px;margin:28px auto;background:#fff;border:1px solid #d0d7de;border-radius:8px;overflow:hidden}
.head{padding:16px 20px;border-bottom:1px solid #d0d7de;background:#f6f8fa;font-size:14px}.head b{font-size:15px}
.body{padding:16px 20px;font-size:14px;line-height:1.55;white-space:pre-wrap}
.file{margin:0 20px 16px;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}.path{padding:8px 12px;background:#f6f8fa;border-bottom:1px solid #d0d7de;font:12px ui-monospace,Menlo,monospace}
.code{font:12px ui-monospace,Menlo,monospace;background:#e6ffec;padding:4px 12px;white-space:pre}.ln{color:#59636e;display:inline-block;width:34px}
.cmt{padding:10px 12px;font-size:14px;line-height:1.5;border-top:1px solid #d0d7de}.who{font-weight:600;margin-bottom:4px}.who span{font-weight:400;color:#59636e}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px}.text{white-space:pre-wrap;font-size:15px;line-height:1.5}
.note{max-width:900px;margin:0 auto 24px;font-size:12px;color:#59636e}</style></head><body>${body}<div class="note">${esc(note)}</div></body></html>`
const md = (t) => esc(t).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>')

async function render(page, h, name, html) {
  const file = join(OUT, `${name}.html`)
  writeFileSync(file, html)
  await page.goto(`file://${file}`)
  await h.wait(800)
  const clip = await page.evaluate(() => { const a = document.querySelector('.wrap').getBoundingClientRect(), b = document.querySelector('.note').getBoundingClientRect(); return { x: a.x - 24, y: Math.max(0, a.y - 24), width: a.width + 48, height: b.bottom - a.y + 40 } })
  await h.shot(name, { fullPage: true, clip })
}

// ---------- sort new GitHub issues ----------

const TRIAGE_INSTRUCTIONS = `You triage new issues in the GitHub repository tidewater-labs/ledgerly.

Every time you run:
1. Read the repository's labels, then list the open issues created in the last 24 hours that have no labels yet.
2. For each one, search the repository for an older issue about the same problem.
3. Add labels: exactly one of bug, feature or question; the area label that fits (area: pdf-export, area: payments, area: invoices, area: mobile); duplicate if an older issue covers it; needs-repro for a bug report without steps to reproduce. Pass the labels as "labels", a list of label names.
4. Comment only in two cases: on a duplicate, link the older issue; on a bug report without steps, ask for them (what they did, web or app and which version, whether it happens every time).
5. Never close, assign or edit an issue, and never use the core-team label.

Finish with a short list: each issue, the labels you added, and who should look at it:
- area: pdf-export: @ines-duarte
- area: payments: @tomas-reyes
- area: invoices: @lena-fischer
- area: mobile: @kai-nakamura
Point out anything that looks urgent, such as something that broke in the last release.`
const TRIAGE_TOOLS = ['github_issues_list_labels_for_repo', 'github_issues_list_for_repo', 'github_search_issues_and_pull_requests', 'github_issues_add_labels', 'github_issues_create_comment']

async function issueTriage(page, h) {
  await connectOpenAI(page, h, 'triage-01-model')
  await connectGitHub(page, h, { connect: 'triage-02-connect', key: 'triage-03-key', api: 'triage-04-api' })
  await page.goto('/tools')
  await h.wait(1200)
  await page.getByPlaceholder('Search tools...').fill('issues_list_for_repo')
  await h.wait(1500)
  await page.getByText('github_issues_list_for_repo', { exact: true }).first().click()
  await h.wait(1500)
  await page.getByRole('tab', { name: 'Test tool' }).click()
  await page.getByPlaceholder('Enter owner').fill('tidewater-labs')
  await page.getByPlaceholder('Enter repo').fill('ledgerly')
  await page.getByRole('button', { name: 'Execute Tool' }).click()
  await page.getByText('Response Data:').waitFor({ timeout: 20000 })
  await page.getByText('Response Data:').scrollIntoViewIfNeeded()
  await h.shot('triage-05-test-tool')

  await newAgent(page, h, { name: 'Issue triage', personality: 'Friendly and short. Thanks people for reporting, never blames them.', instructions: TRIAGE_INSTRUCTIONS })
  await h.shot('triage-06-agent')
  await pickTools(page, TRIAGE_TOOLS)
  await page.getByRole('heading', { name: 'Tools and APIs' }).scrollIntoViewIfNeeded()
  await h.shot('triage-07-tools')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, 'Triage the new issues in tidewater-labs/ledgerly.', /I did not close/, 'triage-08-try', 'triage-00-result')
  await runSteps(page, h, agent, 'triage-09-run')
  await everyFew(page, h, agent, { every: 1, unit: 'hours', message: 'Triage the new issues in tidewater-labs/ledgerly.', shotName: 'triage-10-schedule' })
}

// ---------- a first pass on pull requests ----------

const REVIEW_INSTRUCTIONS = `You give pull requests in tidewater-labs/ledgerly a first review, before a person looks at them.

For each open pull request you have not reviewed yet:
1. Read the pull request and the files it changes.
2. Look for: bugs in the changed lines, money amounts that are not rounded to cents, secrets or keys in the code, new dependencies that are not on our list, and new code without tests.
3. Post one review with event COMMENT: a short summary at the top and a comment on each line concerned (path, line, side RIGHT). Say why it matters and what to do instead.
4. Never approve or request changes, and leave style and formatting alone.
5. Put code names in double quotes, never in backticks.

Allowed dependencies: date-fns, zod, pdfkit, pg, stripe, express.

Finish with the pull requests you reviewed and what you found.`
const REVIEW_TOOLS = ['github_pulls_list', 'github_pulls_list_reviews', 'github_pulls_get', 'github_pulls_list_files', 'github_pulls_create_review']

async function prReview(page, h) {
  await connectOpenAI(page, h, 'review-01-model')
  await connectGitHub(page, h, { connect: 'review-02-connect', key: 'review-03-key', api: 'review-04-api' })
  await newAgent(page, h, { name: 'Pull request review', personality: 'Direct and kind, like a senior colleague. Explains why, suggests the fix, no nitpicks.', instructions: REVIEW_INSTRUCTIONS })
  await h.shot('review-05-agent')
  await pickTools(page, REVIEW_TOOLS)
  await page.getByRole('heading', { name: 'Tools and APIs' }).scrollIntoViewIfNeeded()
  await h.shot('review-06-tools')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, 'Review the open pull requests in tidewater-labs/ledgerly.', /Posted as a comment review/, 'review-07-try')
  await runSteps(page, h, agent, 'review-08-run')
  await everyFew(page, h, agent, { every: 30, unit: 'minutes', message: 'Review the open pull requests in tidewater-labs/ledgerly that you have not reviewed yet.', shotName: 'review-09-schedule' })
  // What GitHub received, laid out the way GitHub shows a review.
  const r = (await upstream('/_admin/state')).reviews[0]
  const patch = await upstream('/_admin/files')
  const files = {}
  for (const c of r.comments) (files[c.path] ||= []).push(c)
  await render(page, h, 'review-00-on-github', PAGE('Review on #212', `<div class="wrap"><div class="head"><b>ledgerly-review[bot]</b> reviewed <b>#212 Add late fees to overdue invoices</b> · commented</div><div class="body">${md(r.body)}</div>
${Object.entries(files).map(([p, cs]) => `<div class="file"><div class="path">${esc(p)}</div>${cs.map((c) => `<div class="code"><span class="ln">${c.line}</span>+${esc(patch[p]?.[c.line] ?? '')}</div><div class="cmt"><div class="who">ledgerly-review[bot] <span>commented</span></div>${md(c.body)}</div>`).join('')}</div>`).join('')}</div>`,
    'The review exactly as almyty sent it to the GitHub API, laid out the way GitHub shows a review (local demo; GitHub itself was not used).'))
}

// ---------- on-call summaries from PagerDuty ----------

const PD_LINK = 'https://raw.githubusercontent.com/PagerDuty/api-schema/main/reference/REST/openapiv3.json'
const ONCALL_INSTRUCTIONS = `You help whoever is on call for Ledgerly. Incidents are in PagerDuty.

Every time you wake:
1. List the incidents that are triggered or acknowledged on the Ledgerly API service (PLDG3RA).
2. Skip any incident that already has a note from you.
3. For each new one, read its alerts: they carry the monitor's details. Then list the resolved incidents on the same service from the last 90 days, and read the notes of those with the same title: they say what fixed it last time.
4. Add a note to the incident, written as oncall-bot@tidewater.example (the From field): what fired, the most likely cause, what fixed it last time and the first thing to check. Under 120 words.
5. Report the same summary, with the links to the incident, the runbook and the dashboard.

Only read incidents and add notes. Never acknowledge, resolve, reassign or change an incident.`
const ONCALL_TOOLS = ['pagerduty_list_incidents', 'pagerduty_list_incident_alerts', 'pagerduty_list_incident_notes', 'pagerduty_create_incident_note']
const SLACK_SIGNING_SECRET = 'local-test-signing-secret-0123456789'

async function oncall(page, h) {
  await connectOpenAI(page, h, 'oncall-01-model')
  await page.goto('/apis/new/openapi')
  await page.getByLabel('Link to the description').fill(PD_LINK)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill('PagerDuty')
  await h.shot('oncall-02-connect')
  await page.getByLabel('Address', { exact: true }).fill(UP) // the local stand-in
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 120000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 600000 })
  await h.wait(800)
  await h.shot('oncall-03-found')
  await page.getByRole('button', { name: 'Create one here' }).click()
  await h.wait(600)
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('PagerDuty API key')
  await page.locator('main input[type=password]').last().fill('Token token=y_NbAkKc66ryYTWUXYEu')
  await h.shot('oncall-04-key')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })

  await newAgent(page, h, { name: 'On-call summaries', personality: 'Calm and to the point. Facts from the alert first, then the likely cause. Says when it is not sure.', instructions: ONCALL_INSTRUCTIONS })
  await h.shot('oncall-05-agent')
  await pickTools(page, ONCALL_TOOLS)
  await page.getByRole('heading', { name: 'Tools and APIs' }).scrollIntoViewIfNeeded()
  await h.shot('oncall-06-tools')
  const agent = await saveAndActivate(page, h)

  // Slack
  await page.goto(`/agents/${agent}/channels/new`)
  await h.wait(1200)
  await page.getByRole('button', { name: /^Slack/ }).click()
  await h.wait(2000)
  await page.getByRole('button', { name: /^Advanced/ }).click()
  await page.getByRole('button', { name: 'Create one here' }).last().click()
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('radio', { name: 'Bot token' }).click()
  await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Slack bot (Tidewater)')
  await page.getByRole('textbox', { name: 'Bot user OAuth token' }).fill('xoxb-local-test-0000000000-222222222')
  await page.getByRole('textbox', { name: 'Signing secret' }).fill(SLACK_SIGNING_SECRET)
  await page.getByRole('textbox', { name: 'Bot user OAuth token' }).scrollIntoViewIfNeeded()
  await h.shot('oncall-07-slack-key')
  await page.getByRole('button', { name: 'Save', exact: true }).first().click()
  await h.wait(4000)
  const save = page.getByRole('button', { name: 'Save', exact: true }).last()
  if (await save.isEnabled().catch(() => false)) { await save.click(); await h.wait(2500) }
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await h.wait(3500)
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo(0, 0) })
  await h.shot('oncall-08-slack-live')

  // Always on
  await page.goto(`/agents/${agent}/always-on`)
  await h.wait(1500)
  await page.getByRole('textbox', { name: 'Standing instructions' }).fill('Watch PagerDuty for new incidents on the Ledgerly API. For each one you have not seen, add your summary as a note and report it.')
  await page.getByRole('spinbutton', { name: 'Every' }).fill('15')
  await page.getByRole('combobox', { name: 'Unit' }).click()
  await page.getByRole('option', { name: 'minutes' }).click()
  await page.getByRole('combobox', { name: 'On its own, it' }).click()
  await page.getByRole('option', { name: /Does things/ }).click()
  await h.wait(800)
  for (const cb of await page.getByRole('checkbox', { name: /^pagerduty_/ }).all()) if (await cb.isChecked()) await cb.uncheck()
  await page.getByRole('combobox', { name: 'Post reports to' }).click()
  await page.getByRole('option', { name: /Slack/ }).first().click()
  await h.wait(600)
  await page.getByPlaceholder('C0123ABCDEF').fill('C07INCIDNTS')
  await page.getByRole('switch', { name: 'Always on' }).click()
  await page.getByRole('heading', { name: 'What wakes it' }).scrollIntoViewIfNeeded()
  await h.shot('oncall-09-always-on')
  await h.top(page.getByText('Ask me first before', { exact: true }), 260)
  await h.shot('oncall-10-act')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await h.wait(2500)
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('button', { name: 'Wake now' }).click()
  const slack = async () => (await (await fetch(`${SLACK_UP}/_admin/state`)).json()).outbox.filter((o) => o.url.includes('chat.postMessage') && o.body?.channel === 'C07INCIDNTS')
  let posted
  for (let i = 0; i < 60 && !(posted = (await slack()).find((o) => /#1187/.test(o.body.text))); i++) await h.wait(3000)
  if (!posted) throw new Error('no report in Slack')
  await page.goto(`/agents/${agent}`)
  await h.wait(2000)
  await page.getByRole('heading', { name: 'Always on' }).scrollIntoViewIfNeeded()
  await h.shot('oncall-11-card')
  const slackHtml = (t) => esc(t).replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>').replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1<b>$2</b>').replace(/`([^`]+)`/g, '<code>$1</code>')
  await render(page, h, 'oncall-00-slack', PAGE('Slack', `<div class="wrap"><div class="chan"># incidents</div><div class="msg"><div class="who">On-call summaries <span>APP</span></div><div class="text">${slackHtml(posted.body.text)}</div></div></div>`,
    'The message exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).'))
}

// ---------- the old SOAP stock service ----------

const STOCK_INSTRUCTIONS = `You answer the sales team's questions about stock at Harbor Supply, from the stock system.

Warehouses: RTM is Rotterdam, ANR is Antwerp, HAM is Hamburg.
Article numbers look like HS-10442.

When someone asks you to reserve stock, reserve it only if that warehouse has enough on hand, and always give the order reference. Answer with the reservation number. If the stock system refuses, say why in plain words.`

async function soapStock(page, h) {
  // The WSDL as IT would hand it over: a file, since the service is on an internal address.
  const wsdl = join(OUT, 'StockService.wsdl')
  writeFileSync(wsdl, await (await fetch(`${UP}/StockService.asmx?wsdl`)).text())
  await connectOpenAI(page, h)
  await page.goto('/apis/new/soap')
  await page.getByRole('tab', { name: 'File' }).click()
  await page.locator('input[type=file]').setInputFiles(wsdl)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill('Harbor stock system')
  await h.shot('soap-01-connect')
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/apis\/[0-9a-f-]{36}/, { timeout: 120000 })
  await h.wait(4000)
  await h.shot('soap-02-api')
  await addKey(page, h, {
    how: 'As a username and password', name: 'Stock system service account', shotName: 'soap-03-key',
    fill: async () => {
      await page.getByRole('textbox', { name: /user ?name/i }).last().fill('svc-almyty')
      await page.locator('main input[type=password]').last().fill('Harbor-2009!')
    },
  })
  await page.goto('/tools')
  await h.wait(1200)
  await page.getByPlaceholder('Search tools...').fill('get_stock_level')
  await h.wait(1500)
  await page.getByText('harbor_stock_system_get_stock_level', { exact: true }).first().click()
  await h.wait(1500)
  await page.getByRole('tab', { name: 'Test tool' }).click()
  await h.wait(800)
  await page.getByPlaceholder(/Sku/).fill('HS-10442')
  await page.getByRole('button', { name: 'Execute Tool' }).click()
  await page.getByText('Response Data:').waitFor({ timeout: 20000 })
  await page.getByText('Response Data:').scrollIntoViewIfNeeded()
  await h.shot('soap-04-test-tool')

  await newAgent(page, h, { name: 'Stock assistant', personality: 'Short and exact. Numbers first.', instructions: STOCK_INSTRUCTIONS })
  await h.shot('soap-05-agent')
  await pickTools(page, ['harbor_stock_system_get_stock_level', 'harbor_stock_system_reserve_stock', 'harbor_stock_system_list_warehouses'])
  await page.getByRole('heading', { name: 'Tools and APIs' }).scrollIntoViewIfNeeded()
  await h.shot('soap-06-tools')
  const agent = await saveAndActivate(page, h)
  await tryIt(page, h, 'Do we have 600 rolls of pallet wrap HS-10442 in Rotterdam? If yes, reserve them for order SO-55120.', /reservation|refused|Not enough/i, 'soap-07-try', 'soap-00-result')
  await runSteps(page, h, agent, 'soap-08-run')

  // An MCP gateway, so coding assistants can use the old system too.
  await page.goto('/gateways/new')
  await h.wait(1500)
  await page.getByRole('button', { name: /^MCP/ }).first().click()
  await page.getByRole('button', { name: /Harbor stock system/ }).first().click()
  await page.getByLabel('Name', { exact: true }).fill('Harbor stock')
  await h.wait(800)
  await h.shot('soap-09-gateway-new')
  await page.getByRole('button', { name: 'Create gateway' }).click()
  await page.waitForURL(/\/gateways\/[0-9a-f-]{36}/, { timeout: 30000 })
  await h.wait(2500)
  await h.shot('soap-10-gateway')
}

// ---------- the runner, as Ines would start it on her laptop ----------

const RUNNER_BIN = process.env.ALMYTY_RUNNER_BIN || 'almyty-runner'
let runner
// "almyty login" opens a browser; here her session token stands in for it.
async function startRunner() {
  const token = (await login()).find((c) => c.startsWith('access_token='))?.slice('access_token='.length)
  const org = sql(`SELECT o.id FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${INES.email}' AND o.name = '${INES.organizationName}' LIMIT 1`)
  // A coding assistant started from inside another one's session refuses to run; this one starts clean.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)))
  const state = join(OUT, 'runner-state')
  mkdirSync(state, { recursive: true })
  runner = spawn(RUNNER_BIN, ['start', '--name', 'ines-macbook', '--org', org, '--url', API], {
    cwd: '/tmp/tidewater', env: { ...env, ALMYTY_TOKEN: token, ALMYTY_URL: API, ALMYTY_RUNNER_STATE_DIR: state }, stdio: ['ignore', 'inherit', 'inherit'],
  })
}
function stopRunner() { runner?.kill(); runner = undefined }
process.on('exit', stopRunner)

// The library the coding assistants work on: a few lines of Ledgerly's helpers.
function sampleLibrary() {
  const dir = '/tmp/tidewater/ledgerly-utils'
  mkdirSync(join(dir, 'src'), { recursive: true }); mkdirSync(join(dir, 'test'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@tidewater/ledgerly-utils', version: '0.4.0', description: 'Small helpers shared by the Ledgerly apps', type: 'module', main: 'src/index.js', scripts: { test: 'node --test' } }, null, 2) + '\n')
  writeFileSync(join(dir, 'src/index.js'), "export { formatMoney } from './money.js'\n")
  writeFileSync(join(dir, 'src/money.js'), "// Format an amount in cents, e.g. formatMoney(418000, 'EUR') -> \"4,180.00 EUR\"\nexport function formatMoney(cents, currency) {\n  const value = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })\n  return `${value} ${currency}`\n}\n")
  writeFileSync(join(dir, 'test/money.test.js'), "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { formatMoney } from '../src/index.js'\n\ntest('formats cents with two decimals and the currency', () => {\n  assert.equal(formatMoney(418000, 'EUR'), '4,180.00 EUR')\n})\n")
}

// ---------- several coding assistants on one task ----------

const FLEET_INSTRUCTIONS = `You lead a small team of coding assistants on the machine ines-macbook. You plan and check; the assistants write the code.

For each task:
1. List the coding assistants on the machine.
2. Get the code: cp -R /tmp/tidewater/ledgerly-utils app && cd app && git init -q && git add -A && git commit -qm start
3. Split the task in two: the code, and the tests for it.
4. Give the code to Claude Code: cd app && claude -p "<the code part>" --permission-mode acceptEdits
5. Give the tests to Codex: cd app && codex exec --sandbox workspace-write "<the test part>" < /dev/null
6. Run the tests: cd app && npm test
7. Show what changed: cd app && git add -A && git diff --cached --stat

Then report who did what, whether the tests pass, and which files changed. Never push or publish anything.`
const FLEET_TASK = 'Add formatIban(iban) to ledgerly-utils: it removes spaces, makes the letters upper case, checks the IBAN checksum (mod 97) and returns the IBAN in groups of four, or throws an Error for an invalid IBAN. Export it from src/index.js.'

async function fleet(page, h) {
  sampleLibrary()
  await connectOpenAI(page, h, 'fleet-01-model')
  await page.goto('/runners')
  await h.wait(1500)
  await page.getByRole('link', { name: 'Start a runner' }).or(page.getByRole('button', { name: 'Start a runner' })).first().click()
  await h.wait(1500)
  await h.shot('fleet-02-start-runner')
  await startRunner()
  for (let i = 0; i < 30 && sql(`SELECT count(*) FROM runners WHERE name='ines-macbook' AND state='online'`) === '0'; i++) await h.wait(2000)
  await page.goto('/runners')
  await h.wait(2000)
  await h.shot('fleet-03-runners')
  await page.getByText('ines-macbook').first().click()
  await h.wait(2500)
  await h.top(page.getByText(/^Coding agents/).first(), 140)
  await h.shot('fleet-04-runner')

  await newAgent(page, h, { name: 'Coding lead', personality: 'Plans before acting, keeps each assistant to one clear job, reports plainly what changed.', instructions: FLEET_INSTRUCTIONS })
  await h.shot('fleet-05-agent')
  const search = page.getByRole('textbox', { name: 'Search tools' })
  await search.fill('ines-macbook')
  await h.wait(500)
  for (const b of await page.getByRole('button', { name: /\d+ tools?/ }).all()) if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click()
  for (const cb of await page.getByRole('checkbox', { name: /runner\.ines-macbook\.(agent\.list|shell\.exec)/ }).all()) await cb.check()
  await page.getByRole('heading', { name: 'Tools and APIs' }).scrollIntoViewIfNeeded()
  await h.shot('fleet-06-tools')
  await search.fill('')
  // The runner is private to Ines, so the agent that uses it must be too.
  await page.getByRole('button', { name: 'Everyone' }).first().click()
  await h.wait(800)
  await h.shot('fleet-07-only-you')
  await page.getByText('Only you', { exact: true }).first().click()
  await h.wait(800)
  const agent = await saveAndActivate(page, h)
  // Real coding assistants at work: minutes, not seconds.
  await tryIt(page, h, FLEET_TASK, /Changed files/, 'fleet-08-try', 'fleet-00-result', 1500000)
  await runSteps(page, h, agent, 'fleet-09-run')
}

// ---------- run ----------

function register(keys) {
  for (const key of keys.length ? keys : Object.keys(SHOTS)) {
    const c = results[key]
    if (!c) { console.log('not captured', key); continue }
    const [path, title, sources] = SHOTS[key]
    const route = RENDERED[key] ?? c.route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
    const notes = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed/usecases/engineering-guides.mjs): real public API descriptions (GitHub, PagerDuty), a local stand-in for GitHub, PagerDuty, Slack and a SOAP stock system, a scripted stand-in model, and for the coding fleet the real Claude Code and Codex CLIs on the runner machine; fictional people and companies. Not staging or production data.' +
      (RENDERED[key] ? ' The page renders the message exactly as almyty handed it to the provider; that provider was not used.' : '')
    execFileSync(process.execPath, [join(ROOT, 'docs-site/scripts/record-screenshot.mjs'), '--image', c.file, '--path', `screenshots/examples/${path}`, '--title', title, '--captured-at', c.at, '--route', route, '--environment', 'local-demo',
      '--notes', notes, ...[...sources, ...UI].flatMap((s) => ['--sources', s])], { stdio: 'inherit', cwd: ROOT })
  }
}

const WALKS = { triage: issueTriage, review: prReview, oncall, soap: soapStock, fleet }
const argv = process.argv.slice(2)
if (argv[0] === '--register') register(argv.slice(1))
else {
  const names = argv.filter((a) => a !== '--fresh')
  for (const name of names) if (!WALKS[name]) throw new Error(`no walk called ${name}: ${Object.keys(WALKS).join(', ')}`)
  for (const name of names) {
    // --fresh: her organization goes first, so each walk starts where a new customer starts.
    if (argv.includes('--fresh')) sql(`DELETE FROM organizations WHERE id IN (SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${INES.email}')`)
    await account()
    const browser = await chromium.launch()
    const { ctx, page } = await session(browser)
    const h = helpers(page)
    try {
      await WALKS[name](page, h)
    } catch (e) {
      console.log('FAILED', name, e.message.split('\n')[0])
      await page.screenshot({ path: join(OUT, `FAILED-${name}.png`) }).catch(() => {})
      process.exitCode = 1
    } finally {
      stopRunner()
      await ctx.close(); await browser.close()
    }
  }
}
