#!/usr/bin/env node
// Walks the five governance example guides in docs-site/content/examples
// through the UI, step by step as their text says, and takes the
// screenshots they show: multi-team-rbac, approval-policies, audit-to-siem,
// sso-scim-onboarding and eu-ai-act-compliance.
//
// It needs the demo stack started with USECASES=1, with gov-upstream.mjs
// already listening on USECASE_PORT (start it before stack.sh, which then
// leaves its own stand-in off) and gov-preload.mjs loaded into the API:
//
//   USECASE_PORT=4291 node scripts/demo-seed/usecases/gov-upstream.mjs &
//   NODE_OPTIONS="--import $PWD/scripts/demo-seed/usecases/gov-preload.mjs" \
//     USECASES=1 USECASE_PORT=4291 MODEL_PRICE_FEED_DISABLED=false scripts/demo-seed/stack.sh up
//   DEMO_USECASE_URL=http://localhost:4291 node scripts/demo-seed/usecases/gov-guides.mjs --fresh
//
// stack.sh mints an install-wide Business license (approval policies,
// custom roles, SSO and SCIM, audit export, compliance pack), which is what
// these guides need.
//
// It works as Sanne Visser, head of IT at Velora Energy (made up), with four
// colleagues. What differs from a real account, because the outside services
// are a local stand-in: the API addresses are set to the stand-in under
// Advanced, the model key is sent with the stand-in's address, Microsoft's
// sign-in page is answered by the stand-in without a screen, the stand-in
// plays Entra ID's provisioning service (the same SCIM requests Entra
// sends), and what Splunk received is shown as a page. The API descriptions
// are the real public ones, read from their links as a user would.
//
//   node scripts/demo-seed/usecases/gov-guides.mjs [--fresh] [rbac approvals siem sso aiact]
//   node scripts/demo-seed/usecases/gov-guides.mjs --register [shot...]
import { createRequire } from 'node:module'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ALMYTY_ROOT || join(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(ROOT, 'frontend/package.json'))
const { chromium } = require('@playwright/test')

const WEB = process.env.DEMO_WEB_URL || 'http://localhost:3210'
const API = process.env.DEMO_API_URL || 'http://localhost:4210'
const UP = process.env.DEMO_USECASE_URL || 'http://localhost:4291'
const PSQL = process.env.DEMO_PSQL || 'docker exec -i almyty-demo-pg psql -U postgres -d almyty_qa'
const OUT = join(process.env.SHOT_DIR || '/tmp/almyty-demo/shots', 'examples')
mkdirSync(OUT, { recursive: true })

const DOMAIN = 'veloraenergy.example'
const PASSWORD = 'Velora-2026!'
const person = (first, last, extra = {}) => ({ email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, '')}@${DOMAIN}`, password: PASSWORD, firstName: first, lastName: last, ...extra })
const SANNE = person('Sanne', 'Visser', { organizationName: 'Velora Energy' })
const LOTTE = person('Lotte', 'Jansen')
const JOOST = person('Joost', 'Bakker')
const MEHMET = person('Mehmet', 'Yilmaz')
const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()
const upstream = async (path, init) => (await fetch(`${UP}${path}`, init)).json()
const orgOf = () => sql(`SELECT o.id FROM organizations o WHERE o.name = 'Velora Energy' LIMIT 1`)

const AGENT = ['frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents']
const BUILDER = ['frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents']
const NEW_API = ['frontend/src/pages/api-new.tsx']
const SETUP = ['frontend/src/pages/api-setup.tsx', 'frontend/src/components/apis/api-key-form.tsx']
const SETTINGS = ['frontend/src/pages/settings.tsx']
const MEMBERS = [...SETTINGS, 'frontend/src/components/MembersAndTeamsTab.tsx']
const RBAC = [...SETTINGS, 'frontend/src/components/settings/rbac-settings.tsx']
const APPROVALS = ['frontend/src/pages/approvals.tsx']
const POLICY = ['frontend/src/pages/approval-policy.tsx', 'frontend/src/components/settings/approval-policy-form.tsx']
const POLICIES = [...SETTINGS, 'frontend/src/components/settings/approval-policies-settings.tsx', 'frontend/src/components/settings/amount-rules-card.tsx']
const STREAMS = [...SETTINGS, 'frontend/src/components/settings/audit-streams-settings.tsx']
const ANALYTICS = ['frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics']
const SSO = [...SETTINGS, 'frontend/src/components/settings/sso-settings.tsx', 'frontend/src/components/settings/sso-domains.tsx']
const COMPLIANCE = [...SETTINGS, 'frontend/src/components/settings/compliance-settings.tsx']
const CHANNEL = ['frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels']
const AUDIT_EVENT = ['backend/ee/modules/audit-export/audit-stream.service.ts', 'backend/src/modules/audit-log']
const TECHDOC = ['backend/src/modules/agents/agent-tech-doc.helper.ts']

// shot: [published path under screenshots/examples, title, sources]
export const SHOTS = {}
const RENDERED = {}

// ---------- the accounts ----------
async function register(p) {
  if (sql(`SELECT count(*) FROM users WHERE email = '${p.email}'`) === '0') {
    const body = { ...p, organizationName: p.organizationName || `${p.firstName} ${p.lastName} (personal)` }
    let r
    // Sign-ups are rate limited per address; wait it out rather than fail.
    for (let i = 0; i < 20; i++) {
      r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      if (r.status !== 429) break
      await new Promise((ok) => setTimeout(ok, 15000))
    }
    if (!r.ok) throw new Error(`register ${p.email} ${r.status} ${await r.text()}`)
  }
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${p.email}'`)
}
// Colleagues are added straight to the database with Sanne's password: sign-ups are rate limited,
// and how they got an account is not what these guides show.
function colleague(p) {
  if (sql(`SELECT count(*) FROM users WHERE email = '${p.email}'`) !== '0') return
  sql(`INSERT INTO users (email, "normalizedEmail", "passwordHash", "firstName", "lastName", "isVerified", "verifiedAt")
    SELECT '${p.email}', '${p.email}', "passwordHash", '${p.firstName}', '${p.lastName}', true, now() FROM users WHERE email = '${SANNE.email}'`)
}
async function account() {
  await register(SANNE)
  if (!orgOf()) {
    const cookie = await apiLogin(SANNE)
    const r = await fetch(`${API}/organizations`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Velora Energy' }) })
    if (!r.ok) throw new Error(`create organization ${r.status} ${await r.text()}`)
  }
  const orgId = orgOf()
  // The local stand-in for Stripe is on localhost, which an organization refuses unless allowed.
  sql(`UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
  for (const p of [LOTTE, JOOST, MEHMET]) colleague(p)
  return { orgId, slug: sql(`SELECT slug FROM organizations WHERE id = '${orgId}'`) }
}

// A colleague accepts Sanne's invitation the way the in-app notification does, then drops the
// organization registration gave them, so the organization switcher only shows Velora Energy.
async function acceptInvite(p) {
  const orgId = orgOf()
  const userId = sql(`SELECT id FROM users WHERE email = '${p.email}'`)
  const row = sql(`SELECT id || '|' || "inviteAccepted" FROM user_organizations WHERE "userId" = '${userId}' AND "organizationId" = '${orgId}'`)
  if (!row) throw new Error(`no invitation for ${p.email}`)
  const [membershipId, status] = row.split('|')
  if (status !== 't') {
    const cookie = await apiLogin(p)
    const r = await fetch(`${API}/invites/membership/${membershipId}/accept`, { method: 'POST', headers: { cookie } })
    if (!r.ok) throw new Error(`accept ${p.email} ${r.status} ${await r.text()}`)
  }
  sql(`DELETE FROM organizations WHERE name = '${p.firstName} ${p.lastName} (personal)'`)
}
// The walk signs five people in many times within minutes; the local stack's sign-in rate limit
// (kept in its Redis) would refuse them, so it is cleared first. Demo stack only.
const REDIS = process.env.DEMO_REDIS || 'docker exec -i almyty-demo-redis redis-cli'
function unthrottle() {
  for (const pattern of ['*throttle*', '*:default}*']) {
    const keys = execSync(`${REDIS} --scan --pattern '${pattern}'`, { encoding: 'utf8' }).split('\n').filter(Boolean)
    if (keys.length) execSync(`${REDIS} del ${keys.map((k) => `'${k}'`).join(' ')}`)
  }
}
async function apiLogin(p) {
  unthrottle()
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: p.email, password: p.password }) })
  if (!r.ok) throw new Error(`login ${p.email} ${r.status}`)
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
}

const HIDE = '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }'
async function session(browser, who = SANNE) {
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'light', timezoneId: 'Europe/Amsterdam', locale: 'en-US', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'light') } catch {} })
  // Microsoft's sign-in page is answered by the stand-in: it signs in whoever /_admin/idp-user names.
  await ctx.route(/login\.microsoftonline\.com/, async (route) => {
    const url = new URL(route.request().url())
    const r = await fetch(`${UP}/entra${url.pathname}${url.search}`, { redirect: 'manual' })
    await route.fulfill({ status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() })
  })
  const page = await ctx.newPage()
  // A busy machine answers slowly; wait longer than Playwright's default before calling a step failed.
  page.setDefaultTimeout(90000)
  page.on('dialog', (d) => d.accept().catch(() => {}))
  if (who) {
    unthrottle()
    await page.goto('/auth/login')
    await page.locator('#email').fill(who.email)
    await page.locator('#password').fill(who.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/dashboard/)
  }
  // Model keys go to the stand-in instead of the vendor.
  await page.route('**/llm-providers/connect', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    body.configuration = { ...(body.configuration || {}), apiUrl: `${UP}/openai/v1` }
    await route.continue({ postData: JSON.stringify(body) })
  })
  return { ctx, page }
}

const results = existsSync(join(OUT, 'gov-captures.json')) ? JSON.parse(readFileSync(join(OUT, 'gov-captures.json'), 'utf8')) : {}
function helpers(page) {
  const wait = (ms = 900) => page.waitForTimeout(ms)
  const shot = async (name, opts = {}) => {
    await page.addStyleTag({ content: HIDE }).catch(() => {})
    await page.mouse.move(0, 0)
    await wait()
    const file = join(OUT, `${name}.png`)
    await page.screenshot({ path: file, ...opts })
    const url = new URL(page.url())
    results[name] = { file, route: RENDERED[name] ?? url.pathname + url.search, at: new Date().toISOString() }
    writeFileSync(join(OUT, 'gov-captures.json'), JSON.stringify(results, null, 2))
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
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ---------- shared steps ----------
async function connectModel(page, h) {
  if (sql(`SELECT count(*) FROM llm_providers WHERE "organizationId" = '${orgOf()}' AND name = 'OpenAI'`) !== '0') return
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
}

async function importApi(page, h, { link, name, address, kind = 'openapi', team, linkShot }) {
  await page.goto(`/apis/new/${kind}`)
  await page.getByLabel('Link to the description').fill(link)
  await page.getByRole('button', { name: 'Advanced' }).click()
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Address', { exact: true }).fill(address) // the local stand-in
  if (team) await chooseTeam(page, team)
  if (linkShot) { await h.toTop(); await h.shot(linkShot) }
  await page.getByRole('button', { name: 'Connect API' }).click()
  await page.waitForURL(/\/setup/, { timeout: 180000 })
  await page.getByText(/Found \d+ operation/).waitFor({ timeout: 300000 })
  await h.wait(800)
}

// "Who can use it": One team, then the team.
async function chooseTeam(page, team) {
  const change = page.getByText('Who can use it:').locator('xpath=..').getByText('Change', { exact: true })
  if (await change.count()) await change.first().click()
  await page.getByRole('radio', { name: /One team/ }).click()
  await page.waitForTimeout(400)
  const pick = page.getByText('Team', { exact: true }).last().locator('xpath=..').getByRole('combobox')
  await pick.click()
  await page.getByRole('option', { name: team, exact: true }).click()
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

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// ---------- run ----------
const WALKS = {}
async function walk(names, { fresh }) {
  if (fresh) {
    sql(`DELETE FROM organizations WHERE name = 'Velora Energy' OR name LIKE '% (personal)'`)
    sql(`DELETE FROM users WHERE email LIKE '%@${DOMAIN}' AND email <> '${SANNE.email}'`)
    await fetch(`${UP}/_admin/reset`, { method: 'POST' })
  }
  const ctxInfo = await account()
  const browser = await chromium.launch()
  const { ctx, page } = await session(browser)
  const h = helpers(page)
  try {
    for (const name of names) await WALKS[name](page, h, { ...ctxInfo, browser })
  } catch (e) {
    console.log('FAILED', e.message.split('\n').slice(0, 3).join(' | '))
    await page.screenshot({ path: join(OUT, 'FAILED.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    await ctx.close()
    await browser.close()
  }
}

function registerShots(shots) {
  for (const shot of shots.length ? shots : Object.keys(SHOTS)) {
    const c = results[shot]
    if (!c) { console.log('not captured', shot); continue }
    const [path, title, sources] = SHOTS[shot]
    const route = c.route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
    const notes = 'Example guide step, walked through the UI on the local demo stack (scripts/demo-seed/usecases/gov-guides.mjs): real public API descriptions, a local stand-in for Stripe, Microsoft Entra ID and Splunk, and a scripted stand-in model; fictional people and companies. Not staging or production data.' +
      (RENDERED[shot] ? ' The page shows what the local stand-in received, laid out as a page; the real service was not used.' : '')
    execFileSync(process.execPath, [join(ROOT, 'docs-site/scripts/record-screenshot.mjs'), '--image', c.file, '--path', `screenshots/examples/${path}`, '--title', title, '--captured-at', c.at, '--route', route, '--environment', 'local-demo',
      '--notes', notes, ...sources.flatMap((s) => ['--sources', s])], { stdio: 'inherit' })
  }
}

// ---------- 1. Keep each team's assistants to that team (multi-team-rbac) ----------
const BILLING_INSTRUCTIONS = `You help Velora Energy's finance team with customers' bills. Find the customer in Stripe by the email address on their account, and look at their charges before you answer.

You can refund a charge in Stripe. Before any refund over €500, ask for approval first with request_approval: in the reason, say who the customer is, which charge, how much and why. In the payload, put the amount in euros as amount_eur, and the customer, charge and invoice. Only make the refund once it is approved. Never refund more than was charged.

Amounts in euros with two decimals.`
const SUPPORT_INSTRUCTIONS = `You help Velora Energy's support team answer customers about contracts, meter readings and moving house. Look the customer's tickets up in Zendesk before you answer, and write replies the agent can send as they are. You never change bills or refunds: send those to the finance team.`

SHOTS['rbac-00'] = ['multi-team-rbac/00-support-view.png', "Agents as a support team member sees them: only his team's assistant", AGENT]
SHOTS['rbac-01'] = ['multi-team-rbac/01-teams.png', 'Two teams, Finance and Customer support', MEMBERS]
SHOTS['rbac-02'] = ['multi-team-rbac/02-invite.png', 'Inviting a colleague as a member', MEMBERS]
SHOTS['rbac-03'] = ['multi-team-rbac/03-team-members.png', 'Finance with Joost as lead, Customer support with Mehmet', MEMBERS]
SHOTS['rbac-04'] = ['multi-team-rbac/04-stripe-finance.png', 'Connecting Stripe for the Finance team only', NEW_API]
SHOTS['rbac-05'] = ['multi-team-rbac/05-agent-team.png', 'The billing assistant, usable by the Finance team only', BUILDER]
SHOTS['rbac-06'] = ['multi-team-rbac/06-support-denied.png', "A support member opening the billing assistant's link", AGENT]
SHOTS['rbac-04b'] = ['multi-team-rbac/04b-stripe-key-finance.png', 'The Stripe key, usable by the Finance team only', SETUP]

async function createTeam(page, h, name, description) {
  if (await page.getByRole('heading', { name, exact: true }).count()) return
  await page.getByRole('button', { name: 'Create team' }).first().click()
  await page.getByLabel('Team name').fill(name)
  await page.getByLabel('Description (optional)').fill(description)
  await page.getByRole('form', { name: 'Create team' }).getByRole('button', { name: 'Create team' }).click()
  await page.getByRole('heading', { name, exact: true }).waitFor()
  await h.wait(800)
}
async function invite(page, h, p, role, shotName) {
  if (sql(`SELECT count(*) FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${p.email}' AND uo."organizationId" = '${orgOf()}'`) !== '0') return
  await page.getByRole('button', { name: 'Invite member' }).click()
  await page.getByPlaceholder('user@example.com').fill(p.email)
  await page.locator('#role').click()
  await page.getByRole('option', { name: role, exact: true }).click()
  if (shotName) await h.shot(shotName)
  await page.getByRole('button', { name: 'Send invitation' }).click()
  await h.wait(1500)
  await acceptInvite(p)
}
async function addToTeam(page, h, team, p, role) {
  const card = page.getByRole('heading', { name: team, exact: true }).locator(`xpath=ancestor::div[contains(@class, "border rounded-lg p-4")][1]`)
  if (!(await card.getByText(p.email).count())) {
    await page.getByRole('button', { name: `Add a member to ${team}` }).click()
    const form = page.getByRole('form', { name: `Add member to ${team}` })
    await form.getByRole('combobox').first().click()
    await page.getByRole('option', { name: new RegExp(p.email.replace(/\./g, '\\.')) }).click()
    await form.getByRole('button', { name: 'Add member' }).click()
    await h.wait(1500)
  }
  // The role in the team is set on the member's row.
  const row = card.locator('div.rounded-lg').filter({ hasText: p.email })
  const now = (await row.getByRole('combobox').last().textContent())?.trim()
  if (now !== role) {
    await row.getByRole('combobox').last().click()
    await page.getByRole('option', { name: role, exact: true }).click()
    await h.wait(1500)
  }
}

async function rbac(page, h) {
  await page.goto('/settings/members')
  await h.wait(1500)
  await createTeam(page, h, 'Finance', 'Billing, refunds and payments. Owns the Stripe connection and the billing assistant.')
  await createTeam(page, h, 'Customer support', 'Answers customers by email and chat. Owns the Zendesk connection and the support assistant.')
  await h.top(page.getByRole('region', { name: 'Teams' }), 100)
  await h.shot('rbac-01')
  await invite(page, h, LOTTE, 'Admin')
  await invite(page, h, JOOST, 'Member', 'rbac-02')
  await invite(page, h, MEHMET, 'Member')
  await page.reload()
  await h.wait(2000)
  await addToTeam(page, h, 'Finance', JOOST, 'Lead')
  await addToTeam(page, h, 'Customer support', MEHMET, 'Member')
  await page.reload()
  await h.wait(2000)
  await h.top(page.getByRole('heading', { name: 'Finance', exact: true }), 140)
  await h.shot('rbac-03')

  await connectModel(page, h)
  if (sql(`SELECT count(*) FROM apis WHERE name = 'Stripe' AND "organizationId" = '${orgOf()}'`) === '0') {
    await importApi(page, h, { link: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json', name: 'Stripe', address: `${UP}/stripe`, team: 'Finance', linkShot: 'rbac-04' })
    await page.getByRole('button', { name: 'Change', exact: true }).click()
    await page.locator('#api-key-sent').click()
    await page.getByRole('option', { name: 'As a bearer token' }).click()
    await h.wait(500)
    await page.getByRole('button', { name: 'Create one here' }).first().click()
    await h.wait(800)
    await page.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Stripe restricted key (billing assistant)')
    await page.getByRole('textbox', { name: /token|key/i }).last().fill('rk_live_local-demo-velora-billing')
    await chooseTeam(page, 'Finance')
    await h.shot('rbac-04b')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await page.getByText('Saved. Tools send it with every call.').waitFor({ timeout: 15000 })
  }
  if (sql(`SELECT count(*) FROM apis WHERE name = 'Zendesk' AND "organizationId" = '${orgOf()}'`) === '0') {
    await importApi(page, h, { link: 'https://developer.zendesk.com/zendesk/oas.yaml', name: 'Zendesk', address: `${UP}/zendesk`, team: 'Customer support' })
  }
  if (sql(`SELECT count(*) FROM agents WHERE name = 'Billing assistant' AND "organizationId" = '${orgOf()}'`) === '0') {
    await page.goto('/agents/new')
    await page.getByRole('button', { name: 'Autonomous' }).click()
    await page.getByRole('textbox', { name: 'Agent name' }).fill('Billing assistant')
    await page.getByRole('combobox', { name: 'Model' }).first().click()
    await page.getByRole('option', { name: /gpt-4o(?!-mini)/ }).first().click()
    await page.getByRole('textbox', { name: 'Personality and style' }).fill('Clear and exact. Amounts always with the euro sign and two decimals.')
    await page.getByRole('textbox', { name: 'Instructions' }).fill(BILLING_INSTRUCTIONS)
    await pickTools(page, ['stripe_get_customers', 'stripe_get_charges', 'stripe_post_refunds'])
    await page.getByRole('button', { name: 'Visibility: Everyone' }).click()
    await chooseTeam(page, 'Finance')
    await h.shot('rbac-05')
    await saveAndActivate(page, h)
  }
  if (sql(`SELECT count(*) FROM agents WHERE name = 'Support assistant' AND "organizationId" = '${orgOf()}'`) === '0') {
    await page.goto('/agents/new')
    await page.getByRole('button', { name: 'Autonomous' }).click()
    await page.getByRole('textbox', { name: 'Agent name' }).fill('Support assistant')
    await page.getByRole('combobox', { name: 'Model' }).first().click()
    await page.getByRole('option', { name: /gpt-4o(?!-mini)/ }).first().click()
    await page.getByRole('textbox', { name: 'Instructions' }).fill(SUPPORT_INSTRUCTIONS)
    await pickTools(page, ['zendesk_list_tickets', 'zendesk_show_ticket'])
    await page.getByRole('button', { name: 'Visibility: Everyone' }).click()
    await chooseTeam(page, 'Customer support')
    await saveAndActivate(page, h)
  }

  // What Mehmet, in Customer support, sees.
  const browser = page.context().browser()
  const m = await session(browser, MEHMET)
  const mh = helpers(m.page)
  await m.page.goto('/agents')
  await mh.wait(2500)
  await mh.shot('rbac-00')
  const billing = sql(`SELECT id FROM agents WHERE name = 'Billing assistant' AND "organizationId" = '${orgOf()}'`)
  await m.page.goto(`/agents/${billing}`)
  await mh.wait(2500)
  await mh.shot('rbac-06')
  await m.ctx.close()
}
WALKS.rbac = rbac

// ---------- 2. Who signs off (approval-policies) ----------
SHOTS['ap-00'] = ['approval-policies/00-two-step.png', 'A €6,240.00 refund after the finance lead and an admin both approved', AGENT]
SHOTS['ap-01'] = ['approval-policies/01-big-refunds.png', 'Policy: refunds over €5,000 need the finance lead, then an admin', POLICY]
SHOTS['ap-02'] = ['approval-policies/02-policies.png', 'Two approval policies for the Finance team', POLICIES]
SHOTS['ap-03'] = ['approval-policies/03-try.png', 'The billing assistant stops before a €6,240.00 refund', AGENT]
SHOTS['ap-04'] = ['approval-policies/04-waiting.png', 'The refund waiting on the Approvals page, as the finance lead sees it', APPROVALS]
SHOTS['ap-05'] = ['approval-policies/05-after-first.png', 'After the finance lead approved: still waiting, for an admin', APPROVALS]
SHOTS['ap-06'] = ['approval-policies/06-small.png', 'A €740.60 refund: one approval, from the finance lead', APPROVALS]

async function policyForm(page, h, { name, description, team, conditions, steps, priority, shotName }) {
  if (sql(`SELECT count(*) FROM approval_policies WHERE name = '${name}' AND "organizationId" = '${orgOf()}'`) !== '0') return
  await page.goto('/settings/approvals/policies/new')
  await h.wait(1500)
  await page.getByLabel('Name', { exact: true }).fill(name)
  await page.getByLabel('Description').fill(description)
  if (team) await chooseTeam(page, team)
  for (const [i, [attr, op, value]] of conditions.entries()) {
    await page.getByRole('button', { name: 'Add condition' }).click()
    await page.getByLabel(`Condition ${i + 1} attribute`).fill(attr)
    await page.getByLabel(`Condition ${i + 1} operator`).click()
    await page.getByRole('option', { name: op, exact: true }).click()
    await page.getByLabel(`Condition ${i + 1} value`).fill(value)
  }
  for (const [i, [stepName, role, min]] of steps.entries()) {
    if (i > 0) await page.getByRole('button', { name: 'Add step' }).click()
    await page.getByLabel(`Step ${i + 1} name`).fill(stepName)
    await page.getByLabel(`Step ${i + 1} approver role`).fill(role)
    await page.getByLabel(`Step ${i + 1} minimum approvals`).fill(String(min))
  }
  if (priority) {
    await page.getByRole('button', { name: /^Advanced/ }).click()
    await page.getByLabel('Priority').fill(String(priority))
  }
  if (shotName) { await h.top(page.getByText('When it applies').first(), 140); await h.shot(shotName) }
  await page.getByRole('button', { name: 'Create policy' }).click()
  await page.waitForURL(/\/settings\/approvals$/, { timeout: 20000 })
  await h.wait(1200)
}

async function decide(page, h, { match, note, shotBefore, shotAfter }) {
  await page.goto('/approvals')
  await h.wait(2500)
  const card = page.locator('.border-amber-200').filter({ hasText: match }).first()
  await card.waitFor({ timeout: 60000 })
  if (shotBefore) await h.shot(shotBefore)
  await card.getByRole('button', { name: 'Approve', exact: true }).first().click()
  await h.wait(600)
  if (note) await page.getByLabel('Note (optional)').fill(note)
  await page.getByRole('form', { name: 'Approve this action' }).getByRole('button', { name: 'Approve', exact: true }).click()
  await h.wait(2500)
  if (shotAfter) {
    await page.goto('/approvals')
    // The request stays pending after the first step; the page does not show the steps.
    await page.locator('.border-amber-200').filter({ hasText: match }).first().waitFor({ timeout: 120000 })
    await h.wait(1500)
    await h.shot(shotAfter)
  }
}

async function approvals(page, h) {
  await policyForm(page, h, {
    name: 'Refunds over €5,000',
    description: 'Large refunds: the finance lead checks the customer and the charge, then an admin signs off.',
    team: 'Finance',
    conditions: [['payload.amount_eur', 'greater than', '5000']],
    steps: [['Finance lead', 'team_lead', 1], ['Admin', 'admin', 1]],
    priority: 10,
    shotName: 'ap-01',
  })
  await policyForm(page, h, {
    name: 'Refunds over €500',
    description: "Every other refund that needs a person: the Finance team's lead decides.",
    team: 'Finance',
    conditions: [['payload.amount_eur', 'greater than', '500']],
    steps: [['Finance lead', 'team_lead', 1]],
  })
  await page.goto('/settings/approvals')
  await h.wait(2000)
  await h.top(page.getByText('Approval policies').last(), 120)
  await h.shot('ap-02')

  const agent = sql(`SELECT id FROM agents WHERE name = 'Billing assistant' AND "organizationId" = '${orgOf()}'`)
  await tryIt(page, h, agent, 'Bakkerij De Zon B.V. (administratie@bakkerijdezon.example) was charged twice for their September bill. Please refund the duplicate.', /approval|approved|Refunded/i, 'ap-03')

  const browser = page.context().browser()
  // Joost, the Finance team's lead: step 1.
  const j = await session(browser, JOOST)
  const jh = helpers(j.page)
  await decide(j.page, jh, { match: 'Bakkerij De Zon', note: 'Checked in Stripe: the September invoice was collected twice.', shotBefore: 'ap-04', shotAfter: 'ap-05' })
  await j.ctx.close()
  // Lotte, an admin: step 2.
  const l = await session(browser, LOTTE)
  const lh = helpers(l.page)
  await decide(l.page, lh, { match: 'Bakkerij De Zon', note: 'Approved.' })
  await l.ctx.close()
  await until('the refund', async () => (await upstream('/_admin/state')).refunds.length >= 1)
  await page.goto(`/agents/${agent}`)
  await h.wait(1500)
  await page.getByRole('tab', { name: 'Runs' }).click()
  await h.wait(1500)
  await page.locator('main tbody tr').first().click()
  await h.wait(2500)
  await h.top(page.getByText(/request_approval/).first(), 160)
  await h.shot('ap-00')

  // A smaller one: only the finance lead.
  await tryIt(page, h, agent, "Anna Kowalski (anna.kowalski@mailbox.example) was billed €1,124.00 on an estimated meter reading. Her actual reading gives €383.40. Refund €740.60.", /approval|approved|Refunded/i)
  const j2 = await session(browser, JOOST)
  const j2h = helpers(j2.page)
  await j2.page.goto('/approvals')
  await j2h.wait(2500)
  await j2h.shot('ap-06')
  await decide(j2.page, j2h, { match: 'Anna Kowalski' })
  await j2.ctx.close()
  await until('the second refund', async () => (await upstream('/_admin/state')).refunds.length >= 2)
}
WALKS.approvals = approvals

// ---------- 3. Audit trail to Splunk (audit-to-siem) ----------
const SPLUNK_HEC = 'https://http-inputs-velora-energy.splunkcloud.com/services/collector/event'
const SPLUNK_TOKEN = '7c2e9a41-5b1d-4f6a-9e03-8d4b2c1f6a70'
SHOTS['si-00'] = ['audit-to-siem/00-splunk-events.png', 'Audit events as Splunk received them: a refund and the approvals before it', AUDIT_EVENT]; RENDERED['si-00'] = '/settings/audit-streams'
SHOTS['si-01'] = ['audit-to-siem/01-audit-trail.png', 'Analytics, Audit trail: who did what, and when', ANALYTICS]
SHOTS['si-02'] = ['audit-to-siem/02-splunk-target.png', 'Audit streaming: a Splunk HTTP Event Collector target', STREAMS]
SHOTS['si-03'] = ['audit-to-siem/03-streaming.png', 'Audit streaming, sending to Splunk', STREAMS]

async function siem(page, h) {
  if (sql(`SELECT count(*) FROM audit_stream_configs WHERE "organizationId" = '${orgOf()}'`) === '0') {
    await page.goto('/settings/audit-streams')
    await h.wait(2000)
    await page.locator('#stream-target').click()
    await page.getByRole('option', { name: /Splunk HEC/ }).click()
    await page.locator('#stream-endpoint').fill(SPLUNK_HEC)
    await page.locator('#stream-token').fill(SPLUNK_TOKEN)
    await h.shot('si-02')
    await page.getByTestId('add-stream').click()
    await page.getByTestId('audit-streams').waitFor()
    await h.wait(1200)
    await h.shot('si-03')
  }
  await fetch(`${UP}/_admin/reset-splunk`, { method: 'POST' }).catch(() => {})
  const before = (await upstream('/_admin/state')).splunk.length

  // Something worth recording: a refund under €500, then a large one with its two approvals.
  const agent = sql(`SELECT id FROM agents WHERE name = 'Billing assistant' AND "organizationId" = '${orgOf()}'`)
  await tryIt(page, h, agent, 'Maarten de Vries (maarten.devries@mailbox.example) moved out on 30 September but was charged the full October advance. Refund €136.50.', /Refunded|approval/i)
  await until('events at Splunk', async () => (await upstream('/_admin/state')).splunk.length > before)

  await page.goto('/analytics')
  await h.wait(1500)
  await page.getByRole('tab', { name: /Audit/ }).click()
  await h.wait(2500)
  await h.shot('si-01')

  const events = (await upstream('/_admin/state')).splunk
  writeFileSync(join(OUT, 'splunk-events.json'), JSON.stringify(events, null, 2))
  const shown = events.filter((e) => ['run_start', 'tool_execute'].includes(e.body?.event?.action))
  const rows = shown.slice(-10).reverse().map((e) => {
    const ev = e.body?.event || {}
    const params = ev.details?.parameters ? JSON.stringify(ev.details.parameters) : ''
    return `<tr><td>${escapeHtml(new Date(ev.createdAt || e.at).toISOString().replace('T', ' ').slice(0, 19))}</td><td><code>${escapeHtml(ev.action)}</code></td><td>${escapeHtml(ev.userEmail || '')}</td><td>${escapeHtml(ev.resourceName || '')}</td><td>${escapeHtml(ev.status || '')}</td><td class="j">${escapeHtml(params.slice(0, 220))}</td></tr>`
  }).join('')
  await h.render('si-00', `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:1360px;margin:28px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.q{padding:14px 20px;border-bottom:1px solid #e4e4e7;font-family:Menlo,monospace;font-size:13px;background:#fafafa}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #f1f1f3;vertical-align:top}
th{font-weight:600;color:#52525b;background:#fafafa}code{font-family:Menlo,monospace;font-size:12px;color:#7c3aed}.j{font-family:Menlo,monospace;font-size:11.5px;color:#52525b;word-break:break-all}
.note{max-width:1360px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>
<div class="wrap"><div class="q">index=almyty_audit sourcetype="almyty:audit" action IN (run_start, tool_execute)</div>
<table><tr><th>_time (UTC)</th><th>action</th><th>userEmail</th><th>resourceName</th><th>status</th><th>details.parameters</th></tr>${rows}</table></div>
<div class="note">The events exactly as almyty sent them to the Splunk HTTP Event Collector, newest first, laid out as a table (local demo; Splunk itself was not used).</div></body></html>`)
}
WALKS.siem = siem

// ---------- 4. Company sign-in with Microsoft Entra ID (sso-scim-onboarding) ----------
const ENTRA_TENANT = '4f9c2b17-8e3a-4d61-b5a2-0c7e91d3f846'
const ENTRA_CLIENT = 'b6e1f3a2-47c9-4d0e-9a18-3f5c7d2e8b41'
const EVA = { email: `eva.degroot@${DOMAIN}`, given_name: 'Eva', family_name: 'de Groot', oid: '9d3e1f52-7a0b-4c88-9e21-5b6a0f4d2c13' }
const TOM = { email: `tom.hendriks@${DOMAIN}`, given_name: 'Tom', family_name: 'Hendriks', oid: '2a7c4e90-1b3d-4f6e-8c52-7d9e0a1b3c64' }
SHOTS['sso-00'] = ['sso-scim-onboarding/00-signed-in.png', 'Eva, a new starter, signed in with her Microsoft account', ['frontend/src/pages/dashboard.tsx', 'backend/ee/modules/sso/sso.controller.ts']]
SHOTS['sso-01'] = ['sso-scim-onboarding/01-domain-record.png', 'Email domains: the TXT record to add', SSO]
SHOTS['sso-02'] = ['sso-scim-onboarding/02-domain-verified.png', 'The domain, verified', SSO]
SHOTS['sso-03'] = ['sso-scim-onboarding/03-entra-oidc.png', 'Single sign-on with Microsoft Entra ID over OpenID Connect', SSO]
SHOTS['sso-04'] = ['sso-scim-onboarding/04-scim-token.png', 'SCIM: the base URL and a new token for Entra', SSO]
SHOTS['sso-05'] = ['sso-scim-onboarding/05-members.png', 'Members after Entra provisioned two people and removed one', MEMBERS]

// The requests Microsoft Entra's provisioning service sends, in the order it sends them.
async function entraProvisioning(token, ops) {
  const scim = (path, method = 'GET', body) => fetch(`${API}/scim/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))
  const log = []
  const user = (p, nick) => ({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'],
    externalId: nick, userName: p.email, active: true, displayName: `${p.given_name} ${p.family_name}`,
    emails: [{ primary: true, type: 'work', value: p.email }], name: { formatted: `${p.given_name} ${p.family_name}`, familyName: p.family_name, givenName: p.given_name },
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'Field service' },
  })
  const find = async (p) => (await scim(`/Users?filter=${encodeURIComponent(`userName eq "${p.email}"`)}`)).body?.Resources?.[0]
  if (ops.includes('test')) log.push(['Test Connection', await scim(`/Users?filter=${encodeURIComponent('userName eq "f3b8c1d2-0000-4000-8000-000000000000"')}`)])
  if (ops.includes('users')) {
    for (const [p, nick] of [[EVA, 'eva.degroot'], [TOM, 'tom.hendriks']]) {
      if (!(await find(p))) log.push([`Create ${p.email}`, await scim('/Users', 'POST', user(p, nick))])
    }
    const groups = (await scim(`/Groups?filter=${encodeURIComponent('displayName eq "Field service"')}`)).body?.Resources || []
    let group = groups.find((g) => g.displayName === 'Field service')
    if (!group) group = (await scim('/Groups', 'POST', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], externalId: 'a91f0c3e-field-service', displayName: 'Field service', members: [] })).body
    const ids = [(await find(EVA)).id, (await find(TOM)).id]
    log.push(['Add members to Field service', await scim(`/Groups/${group.id}`, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Add', path: 'members', value: ids.map((value) => ({ value })) }] })])
  }
  if (ops.includes('leaver')) {
    const tom = await find(TOM)
    log.push(['Disable tom.hendriks', await scim(`/Users/${tom.id}`, 'PATCH', { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] })])
  }
  for (const [what, r] of log) console.log('scim', what, r.status)
  return log
}

async function sso(page, h, { orgId }) {
  // 1. The email domain.
  await page.goto('/settings/sso')
  await h.wait(2000)
  const domainItem = page.getByRole('listitem', { name: DOMAIN })
  if (!(await domainItem.count())) {
    await page.locator('#sso-domain-new').fill(DOMAIN)
    await page.getByRole('button', { name: 'Add domain' }).click()
    await domainItem.waitFor()
    await h.wait(1000)
  }
  if (await domainItem.getByRole('button', { name: 'Check DNS' }).count()) {
    await h.top(page.getByText('Email domains').first(), 120)
    await h.shot('sso-01')
    // At the DNS provider: the TXT record the page shows (here, the stand-in's DNS).
    const cookie = await apiLogin(SANNE)
    const domains = await (await fetch(`${API}/sso/settings/domains`, { headers: { cookie } })).json()
    const d = (domains.data || domains).find((x) => x.domain === DOMAIN)
    await fetch(`${UP}/_dns/txt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: d.record.name, value: d.record.value }) })
    await domainItem.getByRole('button', { name: 'Check DNS' }).click()
    await domainItem.getByText(/Verified\./).waitFor({ timeout: 20000 })
    await h.wait(800)
    await h.top(page.getByText('Email domains').first(), 120)
    await h.shot('sso-02')
  }

  // 2. Entra ID over OpenID Connect.
  await page.goto('/settings/sso')
  await h.wait(2000)
  await page.locator('#sso-protocol').click()
  await page.getByRole('option', { name: 'OpenID Connect' }).click()
  await page.locator('#oidc-issuer').fill(`https://login.microsoftonline.com/${ENTRA_TENANT}/v2.0`)
  await page.locator('#oidc-client-id').fill(ENTRA_CLIENT)
  await page.locator('#oidc-secret').fill('Qx98Q~local.demo-secret-value-0123456789abc')
  await page.locator('#oidc-redirect').fill(`${API}/sso/${orgId}/oidc/callback`)
  const sw = async (label, on) => {
    const s = page.getByText(label, { exact: true }).locator('xpath=ancestor::div[contains(@class,"justify-between")][1]').getByRole('switch')
    if ((await s.getAttribute('aria-checked')) !== String(on)) await s.click()
  }
  await sw('Add people when they first sign in', false)
  await sw('Use single sign-on', true)
  // Taller, so the form and the addresses for Entra are in one picture.
  await page.setViewportSize({ width: 1440, height: 1500 })
  await h.top(page.locator('#sso-protocol'), 140)
  await h.shot('sso-03')
  await page.setViewportSize({ width: 1440, height: 900 })
  const saved = page.waitForResponse((r) => r.url().endsWith('/sso/settings') && r.request().method() === 'PUT' && r.ok(), { timeout: 15000 })
  await page.getByRole('button', { name: 'Save SSO settings' }).click()
  await saved
  await h.wait(1000)

  // 3. SCIM.
  let token = existsSync(join(OUT, 'scim-token.txt')) ? readFileSync(join(OUT, 'scim-token.txt'), 'utf8').trim() : ''
  const scimOk = token && (await fetch(`${API}/scim/v2/Users?count=1`, { headers: { authorization: `Bearer ${token}` } })).ok
  if (!scimOk) {
    await page.reload()
    await h.wait(2000)
    await page.getByRole('button', { name: /(Generate|Rotate) SCIM token/ }).click()
    const confirm = page.getByRole('button', { name: 'Rotate token' })
    if (await confirm.count()) await confirm.click()
    await page.locator('#sso-scim-new-token').waitFor()
    token = await page.locator('#sso-scim-new-token').inputValue()
    writeFileSync(join(OUT, 'scim-token.txt'), token)
    await h.top(page.getByText('Automatic member sync (SCIM)').first(), 120)
    await h.shot('sso-04')
  }
  await entraProvisioning(token, ['test', 'users'])

  // 4. Eva signs in with her Microsoft account.
  await fetch(`${UP}/_admin/idp-user`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(EVA) })
  const browser = page.context().browser()
  const e = await session(browser, null)
  const eh = helpers(e.page)
  await e.page.goto(`${API}/sso/${orgId}/oidc/login`)
  await e.page.waitForURL(new RegExp(`^${WEB}`), { timeout: 30000 })
  await e.page.goto('/dashboard')
  await eh.wait(3000)
  await eh.shot('sso-00')
  await e.ctx.close()

  // 5. Tom leaves: Entra disables him, and he can no longer sign in.
  await entraProvisioning(token, ['leaver'])
  await fetch(`${UP}/_admin/idp-user`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(TOM) })
  const t = await session(browser, null)
  const resp = await t.page.goto(`${API}/sso/${orgId}/oidc/login`)
  await t.page.waitForTimeout(2000)
  console.log('tom sign-in', t.page.url(), (await t.page.content()).slice(0, 300))
  await t.ctx.close()

  await page.goto('/settings/members')
  await h.wait(2500)
  await h.shot('sso-05')
}
WALKS.sso = sso

// ---------- 5. Ready for the EU AI Act (eu-ai-act-compliance) ----------
const HELP_INSTRUCTIONS = `You answer Velora Energy's customers on our website about tariffs, meter readings, moving house and paying bills. Velora has two tariffs: Fixed (one price per kWh for 12 months) and Dynamic (the hourly market price plus €0.021 per kWh). A customer can switch tariff once a month; the switch starts on the first day of the next month.

You cannot see anyone's account. For a question about a particular bill, a refund or a change to a contract, ask for the customer's email address and tell them our billing team will reply by email within one working day. Never promise a refund.`
const DISCLOSURE = "You're chatting with Velora's AI assistant. Ask for a person at any time."
SHOTS['ai-00'] = ['eu-ai-act-compliance/00-web-chat.png', 'The public web chat, with the AI notice under the message box', ['frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts']]
SHOTS['ai-01'] = ['eu-ai-act-compliance/01-branding.png', 'Branding: the AI notice in your own words', ['frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels']]
SHOTS['ai-02'] = ['eu-ai-act-compliance/02-channel-notice.png', 'The web chat channel, with the AI notice switched on', CHANNEL]
SHOTS['ai-03'] = ['eu-ai-act-compliance/03-tech-doc.png', "The billing assistant's technical documentation", TECHDOC]; RENDERED['ai-03'] = '/agents/:id'
SHOTS['ai-04'] = ['eu-ai-act-compliance/04-compliance-policy.png', 'Compliance: personal data hidden in records across the organization', COMPLIANCE]
SHOTS['ai-05'] = ['eu-ai-act-compliance/05-posture.png', 'The compliance report', COMPLIANCE]

async function aiact(page, h) {
  let help = sql(`SELECT id FROM agents WHERE name = 'Velora help' AND "organizationId" = '${orgOf()}'`)
  if (!help) {
    await page.goto('/agents/new')
    await page.getByRole('button', { name: 'Autonomous' }).click()
    await page.getByRole('textbox', { name: 'Agent name' }).fill('Velora help')
    await page.getByRole('combobox', { name: 'Model' }).first().click()
    await page.getByRole('option', { name: /gpt-4o(?!-mini)/ }).first().click()
    await page.getByRole('textbox', { name: 'Personality and style' }).fill('Warm, plain and short. Use the customer\'s words, not energy jargon.')
    await page.getByRole('textbox', { name: 'Instructions' }).fill(HELP_INSTRUCTIONS)
    help = await saveAndActivate(page, h)
  }

  // Branding: the notice in Velora's words.
  await page.goto(`/agents/${help}/channels/settings`)
  await h.wait(2000)
  await page.locator('input#agent-name').fill('Velora Energy help')
  await page.locator('textarea#agent-greeting').fill('Hi! Ask me about tariffs, meter readings, moving house or paying your bill.')
  await page.locator('#agent-disclosure').fill(DISCLOSURE)
  await h.top(page.locator('#agent-disclosure'), 260)
  await h.shot('ai-01')
  const save = page.getByRole('button', { name: 'Save' }).last()
  if (await save.isEnabled()) { await save.click(); await h.wait(1500) }

  // The web chat.
  const web = sql(`SELECT id FROM agent_channels WHERE "agentId" = '${help}' AND type = 'web' LIMIT 1`)
  if (!web) {
    await page.goto(`/agents/${help}/channels/new`)
    await h.wait(1200)
    await page.getByRole('button', { name: /^Web chat/ }).click()
    await page.getByRole('button', { name: 'Publish', exact: true }).first().click()
    await page.getByRole('button', { name: 'Unpublish' }).waitFor({ timeout: 20000 })
  } else {
    await page.goto(`/agents/${help}/channels/${web}`)
  }
  await h.wait(1500)
  await h.top(page.getByText('AI disclosure', { exact: true }).first(), 200)
  await h.shot('ai-02')
  const slug = await page.locator('input#channel-address').inputValue()

  // What a visitor sees.
  const browser = page.context().browser()
  const v = await session(browser, null)
  const vh = helpers(v.page)
  await v.page.goto(`/?__slug=${slug}`)
  await vh.wait(2500)
  await v.page.getByRole('textbox', { name: 'Message' }).fill('Can I switch to the dynamic tariff from next month?')
  await v.page.getByRole('button', { name: 'Send' }).click()
  await v.page.getByText(/first day of the next month|Dynamic/).last().waitFor({ timeout: 90000 })
  await vh.wait(1500)
  await vh.shot('ai-00')
  await v.ctx.close()

  // The technical documentation of the billing assistant, as downloaded.
  const billing = sql(`SELECT id FROM agents WHERE name = 'Billing assistant' AND "organizationId" = '${orgOf()}'`)
  await page.goto(`/agents/${billing}`)
  await h.wait(2000)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Tech doc' }).click()])
  const mdFile = join(OUT, 'billing-assistant-technical-documentation.md')
  await download.saveAs(mdFile)
  const md = readFileSync(mdFile, 'utf8')
  // Sections 1 to 4 fit one picture; the rest of the file is the same kind of list.
  const shown = md.split(/^## 5\./m)[0]
  const table = (block) => {
    const rows = block.trim().split('\n').filter((l) => !/^\|[-| ]+\|$/.test(l)).map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    return `<table>${rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('')}</table>`
  }
  const mdHtml = escapeHtml(shown)
    .replace(/(?:^\|.*\|$\n?)+/gm, (b) => table(b))
    .replace(/&lt;\/?p&gt;/g, '')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^_(.*)_$/gm, '<i>$1</i>')
    .replace(/^- (.*)$/gm, '<li>$1</li>').replace(/\n{2,}/g, '\n')
  await h.render('ai-03', `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.doc{max-width:1000px;margin:28px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;padding:28px 40px;white-space:pre-wrap;font-size:14px;line-height:1.5}
h1{font-size:24px;margin:0}h2{font-size:18px;margin:14px 0 4px}h3{font-size:15px;margin:6px 0 0}li{margin-left:18px}code{font-family:Menlo,monospace;font-size:12.5px}
table{border-collapse:collapse;white-space:normal;font-size:12.5px;margin:4px 0}th,td{border:1px solid #e4e4e7;padding:4px 8px;text-align:left;vertical-align:top}th{background:#fafafa}
.note{max-width:1000px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body><div class="doc">${mdHtml}</div>
<div class="note">billing-assistant-technical-documentation.md, as the Tech doc button downloaded it, shown formatted. Sections 1 to 4; the file goes on with 5. Data governance, 6. Logging and traceability and 7. Change history.</div></body></html>`)

  // The compliance pack: personal data hidden in records, organization-wide.
  await page.goto('/settings/compliance')
  await h.wait(2000)
  const pii = page.getByRole('switch', { name: 'Hide personal data' })
  if ((await pii.getAttribute('aria-checked')) !== 'true') await pii.click()
  const scan = page.getByRole('switch', { name: 'Scan for attacks' })
  if ((await scan.getAttribute('aria-checked')) !== 'true') await scan.click()
  await h.wait(500)
  await h.top(page.getByText('Compliance policy').first(), 120)
  await h.shot('ai-04')
  const submit = page.locator('form button[type=submit]').first()
  if (await submit.isEnabled()) { await submit.click(); await h.wait(2500) }
  await page.reload()
  await h.wait(3000)
  await h.top(page.getByText('Score', { exact: true }).first(), 200)
  await h.shot('ai-05')
}
WALKS.aiact = aiact

const args = process.argv.slice(2)
if (args[0] === '--register') registerShots(args.slice(1))
else {
  const fresh = args.includes('--fresh')
  const names = args.filter((a) => a !== '--fresh')
  await walk(names.length ? names : ['rbac', 'approvals', 'siem', 'sso', 'aiact'], { fresh })
}
