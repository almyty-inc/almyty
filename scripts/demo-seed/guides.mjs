#!/usr/bin/env node
// Walks the use-case guides in docs-site/content/examples through the UI, one
// step at a time as each guide's text says, on the local demo stack
// (stack.sh up, then seed.mjs), and takes one screenshot per step into
// $SHOT_DIR/guides (default /tmp/almyty-demo/shots/guides) for review.
// A step that cannot be done as written fails here, and the guide is
// rewritten, not the walk.
//
// It works in an organization of its own, "Northwind", signed in as Sam
// Rivera (a local test credential, like seed.mjs's), so every guide starts
// where a new customer starts. Nothing leaves the machine: the model vendor
// and the company systems are fake-upstream.mjs. Two things differ from a
// real account, both because the fake systems are on localhost: the
// provider key is sent with the fake vendor's address, and API descriptions
// are uploaded as files (almyty refuses links to local addresses).
//
//   node scripts/demo-seed/guides.mjs                       every guide
//   node scripts/demo-seed/guides.mjs support               only these
//   node scripts/demo-seed/guides.mjs --register [shot...]  register reviewed shots
import { createRequire } from 'node:module'
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(ROOT, 'frontend/package.json'))
const { chromium } = require('@playwright/test')

const WEB = process.env.DEMO_WEB_URL || 'http://localhost:3210'
const API = process.env.DEMO_API_URL || 'http://localhost:4210'
const FAKE = process.env.DEMO_FAKE_URL || 'http://localhost:4290'
const PSQL = process.env.DEMO_PSQL || 'docker exec -i almyty-demo-pg psql -U postgres -d almyty_qa'
const OUT = join(process.env.SHOT_DIR || '/tmp/almyty-demo/shots', 'guides')
const FILES = join(OUT, 'files')
mkdirSync(FILES, { recursive: true })

export const SAM = { email: 'sam.rivera@northwind.ai', password: 'Northwind-local-2026!', firstName: 'Sam', lastName: 'Rivera', organizationName: 'Northwind' }
const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()

// ---------- the account ----------

async function account() {
  if (sql(`SELECT count(*) FROM users WHERE email = '${SAM.email}'`) === '0') {
    const r = await fetch(`${API}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(SAM) })
    if (!r.ok) throw new Error(`register ${r.status} ${await r.text()}`)
  }
  // Nobody can click the verification mail on a local stack.
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${SAM.email}'`)
  const orgId = sql(`SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" JOIN organizations o ON o.id = uo."organizationId" WHERE u.email = '${SAM.email}' AND o.name = '${SAM.organizationName}' LIMIT 1`)
  // The fake systems are on localhost: the organization says that host is its own.
  sql(`UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || '{"egressAllowlist":["localhost"]}'::jsonb WHERE id = '${orgId}'`)
  return orgId
}

// The API descriptions, as files the way a customer downloads them.
async function specFiles() {
  for (const key of ['orders', 'crm', 'status', 'kb', 'intranet']) {
    const file = join(FILES, `northwind-${key}-openapi.json`)
    if (!existsSync(file)) writeFileSync(file, await (await fetch(`${FAKE}/${key}/openapi.json`)).text())
  }
}

// ---------- the browser ----------

const UI = ['frontend/src/components/ui', 'frontend/src/components/layout', 'frontend/src/index.css']
const src = (...paths) => [...paths, ...UI]

async function session(browser) {
  const state = join(OUT, 'sam-state.json')
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'dark', timezoneId: 'UTC', locale: 'en-US', deviceScaleFactor: 2, viewport: { width: 1440, height: 900 }, ...(existsSync(state) ? { storageState: state } : {}) })
  await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark') } catch {} })
  const page = await ctx.newPage()
  await page.goto('/dashboard')
  await page.waitForTimeout(1200)
  if (/auth\/login/.test(page.url())) {
    await page.locator('#email').fill(SAM.email)
    await page.locator('#password').fill(SAM.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL(/\/dashboard/)
    await ctx.storageState({ path: state })
  }
  // The provider key goes to the fake vendor instead of the real one.
  await page.route('**/llm-providers/connect', async (route) => {
    const body = JSON.parse(route.request().postData() || '{}')
    const prefix = { openai: 'openai', mistral: 'mistral', openrouter: 'openrouter' }[body.type] || 'openai'
    body.configuration = { ...(body.configuration || {}), apiUrl: `${FAKE}/${prefix}/v1` }
    await route.continue({ postData: JSON.stringify(body) })
  })
  return { ctx, page }
}

function helpers(page) {
  const settle = async (ms = 700) => { await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(ms) }
  return {
    settle,
    go: async (path) => { await page.goto(path); await settle(1000) },
    // What reads as a button may be a link underneath; the reader cannot tell and does not care.
    click: async (name, { role, exact = false } = {}) => {
      const target = role ? page.getByRole(role, { name, exact }) : page.getByRole('button', { name, exact }).or(page.getByRole('link', { name, exact }))
      await target.first().click()
      await settle()
    },
    link: async (name) => { await page.getByRole('link', { name }).first().click(); await settle() },
    fill: async (label, value) => { await page.getByLabel(label, { exact: true }).first().fill(value) },
    // Bring a section to the top of the screen, as a reader scrolls to it.
    show: async (text) => {
      const el = page.getByText(text, { exact: true }).first()
      await el.evaluate((e) => e.scrollIntoView({ block: 'start' }))
      await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollBy(0, -90); window.scrollBy(0, -90) })
      await page.waitForTimeout(400)
    },
    top: async () => { await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTo(0, 0); window.scrollTo(0, 0) }); await page.waitForTimeout(300) },
    // The id of what the current page shows, from its address.
    id: () => page.url().match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0],
  }
}

// ---------- the guides ----------
// Each step: [shot name, title, sources, action]. The action does what the
// guide's step says; the screenshot is taken when it returns.

const SUPPORT_INSTRUCTIONS = 'You answer Northwind customers about their orders. Always look the order up before you answer. You can issue refunds. When a refund waits for a manager, tell the customer a person will confirm it within one business day.'

const SUPPORT = [
  ['support-1-connect-model', 'Connect an AI model', src('frontend/src/pages/models-connect.tsx', 'frontend/src/components/llm-providers', 'frontend/src/components/connect'), async (page, h) => {
    await h.go('/dashboard')
    await h.link('Models')
    await h.link('Connect a provider')
    await page.getByLabel('Provider', { exact: true }).click()
    await page.getByRole('option', { name: /^OpenAI/ }).first().click()
    await page.locator('#connect-name').fill('Northwind OpenAI')
    await page.getByLabel('API key', { exact: true }).fill('sk-demo-openai-0000000000')
    await h.click('Save', { exact: true })
    await page.waitForURL(/\/models\/providers\/[0-9a-f-]{36}/, { timeout: 20000 })
    await h.settle()
  }],
  ['support-2-connect-orders', 'Connect your order system', src('frontend/src/pages/api-new.tsx', 'frontend/src/pages/api-new-description.tsx', 'frontend/src/components/apis'), async (page, h) => {
    await h.go('/apis')
    await h.link('Connect an API')
    await page.getByTestId('api-kind-openapi').click()
    await h.click('File', { role: 'tab' })
    await page.locator('input[type=file]').first().setInputFiles(join(FILES, 'northwind-orders-openapi.json'))
    await h.settle()
  }],
  ['support-3-orders-tools', 'The order system, with what it can do', src('frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis'), async (page, h) => {
    await h.click('Connect API')
    await page.waitForURL(/\/apis\/[0-9a-f-]{36}/, { timeout: 30000 })
    await page.getByText('Get an order by number').first().waitFor({ timeout: 30000 })
    await h.show('API operations')
  }],
  ['support-4-new-agent', 'A new autonomous agent', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.go('/agents')
    await h.click('Create agent')
    await h.click('Autonomous')
    await page.getByPlaceholder('Agent name').fill('Customer support assistant')
    await page.locator('#role-main-model').click()
    await page.getByRole('option', { name: /^gpt-4o(?!-)/ }).first().click()
    await page.getByLabel('Personality and style').fill('Friendly, brief and specific. Apologise once at most.')
    await page.getByLabel('Instructions').fill(SUPPORT_INSTRUCTIONS)
    await h.show('Work mode')
  }],
  ['support-5-model-and-tools', 'Tick the order tools', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await page.getByRole('checkbox', { name: /All tools of Northwind Orders/ }).click()
    await h.show('Capabilities')
  }],
  ['support-6-activate', 'Save and turn the agent on', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.click('Save', { exact: true })
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
    await h.click('Back to agents')
    await h.link('Customer support assistant')
    await h.click('Activate')
    await page.getByText('Active', { exact: true }).first().waitFor({ timeout: 15000 })
    await h.top()
  }],
  ['support-7-try-order', 'Ask about an order', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await page.getByPlaceholder('Type a message to test this agent...').fill('Where is order NW-10428? It was due last week.')
    await h.click('Run test')
    await page.getByRole('status').filter({ hasText: /NW-10428/ }).waitFor({ timeout: 60000 })
    await h.show('Try it')
  }],
  ['support-8-amount-rule', 'Ask before refunds over 500', src('frontend/src/pages/approval-rule.tsx', 'frontend/src/components/settings/approval-amount-rule.tsx', 'frontend/src/lib/approval-rules.ts'), async (page, h) => {
    await h.link('Settings')
    await h.click('Advanced', { role: 'tab' })
    await h.click('New rule')
    await page.locator('#rule-name').fill('Refunds over 500')
    await page.locator('#rule-tool').click()
    await page.getByRole('option', { name: /refund/i }).first().click()
    await page.locator('#rule-argument').click()
    await page.getByRole('option', { name: /amount/i }).first().click()
    await page.locator('#rule-amount').fill('500')
    await page.getByTestId('amount-rule-summary').waitFor({ timeout: 10000 })
    await h.settle()
    await h.top()
  }],
  ['support-9-refund-waits', 'A big refund waits for approval', src('frontend/src/pages/approvals.tsx'), async (page, h) => {
    await h.click('Create rule')
    await page.getByTestId('amount-rules').waitFor({ timeout: 15000 })
    await h.link('Agents')
    await h.link('Customer support assistant')
    await page.getByPlaceholder('Type a message to test this agent...').fill('Brightway Logistics wants a refund of $820 on order NW-44120, it arrived defective.')
    await h.click('Run test')
    await page.waitForTimeout(8000)
    await h.link('Approvals')
    await page.getByRole('button', { name: 'Approve' }).first().waitFor({ timeout: 30000 })
    await h.settle()
  }],
  ['support-10-approve', 'Approve the refund', src('frontend/src/pages/approvals.tsx'), async (page, h) => {
    await h.click('Approve')
    await page.getByLabel('Note (optional)').fill('Defective on arrival, confirmed with the carrier.')
  }],
  ['support-11-add-channel', 'Pick where customers reach it', src('frontend/src/pages/agent-channel-new.tsx', 'frontend/src/components/channels'), async (page, h) => {
    const form = page.getByRole('form', { name: 'Approve this action' })
    if (await form.count()) {
      await form.getByRole('button', { name: 'Approve' }).click()
      await page.getByText('No pending approvals').waitFor({ timeout: 15000 })
    }
    await h.link('Agents')
    await h.link('Customer support assistant')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
  }],
  ['support-12-web-chat', 'Publish the web chat', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels'), async (page, h) => {
    await page.getByRole('button', { name: /^Web chat/ }).click()
    await page.getByRole('button', { name: 'Publish', exact: true }).first().click()
    await page.getByRole('button', { name: 'Unpublish' }).waitFor({ timeout: 20000 })
    await h.top()
  }],
  ['support-13-widget', 'Put the chat bubble on your website', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/gateways/widget-builder.tsx'), async (page, h) => {
    await h.link('Agents')
    await h.link('Customer support assistant')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^Website widget/ }).click()
    await page.getByRole('button', { name: 'Publish', exact: true }).first().click()
    await page.getByText('Add it to your site').waitFor({ timeout: 20000 })
    await h.show('Add it to your site')
  }],
  ['support-14-whatsapp', 'Add WhatsApp with your Twilio keys', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/connect'), async (page, h) => {
    await h.link('Agents')
    await h.link('Customer support assistant')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^WhatsApp\s*Via Twilio/ }).click()
    await h.settle(1500)
    await h.click('Create one here')
    await h.show('Keys')
  }],
  ['support-15-email', 'Add email with your Resend key', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/connect'), async (page, h) => {
    await h.link('Agents')
    await h.link('Customer support assistant')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^Email/ }).click()
    await h.settle(1500)
    await h.click('Create one here')
    await h.show('Keys')
  }],
  ['support-16-branding', 'Name, greeting and limits', src('frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels'), async (page, h) => {
    await h.link('Agents')
    await h.link('Customer support assistant')
    await h.click('Channels', { role: 'tab' })
    await h.link('Branding and visitor rules')
    await page.locator('input#agent-name').fill('Northwind Help')
    await page.locator('textarea#agent-greeting').fill('Hi! I can check your order, shipping and refunds.')
    await page.locator('input#agent-prompt').first().fill('Where is my order?')
    await h.click('Advanced')
    await page.locator('input#agent-daily-cap').fill('20')
    await h.show('What it may cost')
  }],
  ['support-17-customer-view', 'What a customer sees', src('frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts'), async (page, h) => {
    const save = page.getByRole('button', { name: 'Save' }).last()
    if (await save.isEnabled()) { await save.click(); await page.waitForTimeout(1500) }
    await h.link('Agents')
    await h.link('Customer support assistant')
    await h.click('Channels', { role: 'tab' })
    await page.getByText('Web chat', { exact: true }).first().click()
    await h.settle()
    // "Open it" goes to the chat's own address; the local stack serves it by name.
    const slug = await page.locator('input#channel-address').inputValue()
    await h.go(`/?__slug=${slug}`)
    await page.getByRole('textbox', { name: 'Message' }).fill('Where is order NW-10428? It was due last week.')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByText(/held at customs|DHL Express/).last().waitFor({ timeout: 60000 })
    await page.waitForTimeout(800)
  }],
]

const SALES_INSTRUCTIONS = 'You help Northwind account managers. Before a call, look the account up in the CRM and give a short brief: who they are, renewal date and value, open deals, the last conversation and open tickets. After a call, when someone gives you their notes, save them to the account as a meeting note with the next steps, and confirm what you saved.'

const SALES = [
  ['sales-1-connect-crm', 'Connect your CRM', src('frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis'), async (page, h) => {
    await h.go('/apis')
    await h.link('Connect an API')
    await page.getByTestId('api-kind-openapi').click()
    await h.click('File', { role: 'tab' })
    await page.locator('input[type=file]').first().setInputFiles(join(FILES, 'northwind-crm-openapi.json'))
    await h.click('Connect API')
    await page.waitForURL(/\/apis\/[0-9a-f-]{36}/, { timeout: 30000 })
    await page.getByText('Add a meeting note to an account').first().waitFor({ timeout: 30000 })
    await h.show('API operations')
  }],
  ['sales-2-agent', 'The sales assistant and its CRM tools', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.link('Agents')
    await h.click('Create agent')
    await h.click('Autonomous')
    await page.getByPlaceholder('Agent name').fill('Sales assistant')
    await page.locator('#role-main-model').click()
    await page.getByRole('option', { name: /^gpt-4o(?!-)/ }).first().click()
    await page.getByLabel('Personality and style').fill('Short and practical. Numbers first, no small talk.')
    await page.getByLabel('Instructions').fill(SALES_INSTRUCTIONS)
    await page.getByRole('checkbox', { name: /All tools of Northwind CRM/ }).click()
    await h.show('Capabilities')
  }],
  ['sales-3-brief', 'A brief before the call', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.click('Save', { exact: true })
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
    await h.click('Back to agents')
    await h.link('Sales assistant')
    await h.click('Activate')
    await page.getByPlaceholder('Type a message to test this agent...').fill('I have a call with Kestrel Coffee in ten minutes. What should I know?')
    await h.click('Run test')
    await page.getByRole('status').filter({ hasText: /Kestrel/ }).waitFor({ timeout: 60000 })
    await page.waitForTimeout(4000)
    await h.show('Try it')
  }],
  ['sales-4-notes', 'Meeting notes saved to the CRM', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await page.getByPlaceholder('Type a message to test this agent...').fill('Save my notes from the Kestrel call: Dana wants volume pricing for 12 more grinders before the renewal. Next step: I send a quote by Friday.')
    await h.click('Run test')
    await page.getByRole('status').filter({ hasText: /Saved/ }).waitFor({ timeout: 60000 })
    await h.show('Try it')
  }],
  ['sales-5-slack-keys', 'Add Slack with your Slack app', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/connect'), async (page, h) => {
    await h.link('Agents')
    await h.link('Sales assistant')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^Slack/ }).click()
    await h.settle(1500)
    await h.click('Create one here')
    await h.show('Add to Slack')
  }],
  ['sales-6-slack-live', 'Published: the install link and redirect URL', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels'), async (page, h) => {
    // Placeholder Slack app keys, shaped like real ones; nothing is sent to Slack until someone installs it.
    await page.getByLabel('Client ID').first().fill('4312876501.7719203348121')
    await page.getByRole('textbox', { name: 'Client secret' }).first().fill('demo0client0secret0000000')
    await page.getByTestId('credential-form').getByLabel('Name', { exact: true }).fill('Northwind Slack app')
    await page.getByRole('textbox', { name: 'Signing secret' }).first().fill('demo0signing0secret000000')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await h.settle(1500)
    // The picked Slack app is a change to the channel: save it, then publish.
    await page.getByRole('button', { name: 'Save', exact: true }).last().click()
    await h.settle(1500)
    await page.getByRole('button', { name: 'Publish', exact: true }).first().click()
    await page.getByRole('button', { name: 'Unpublish' }).waitFor({ timeout: 20000 })
    await h.show('Add to Slack')
  }],
]

const MARKETING_INSTRUCTIONS = 'You answer questions from visitors to the Northwind website about our coffee equipment. Answer only from the help center: search it first, and name the article you used. If the help center does not answer the question, say so and suggest the contact page. Never promise prices, discounts or delivery dates.'

const MARKETING = [
  ['marketing-1-connect-docs', 'Connect your help center', src('frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis'), async (page, h) => {
    await h.go('/apis')
    await h.link('Connect an API')
    await page.getByTestId('api-kind-openapi').click()
    await h.click('File', { role: 'tab' })
    await page.locator('input[type=file]').first().setInputFiles(join(FILES, 'northwind-kb-openapi.json'))
    await h.click('Connect API')
    await page.waitForURL(/\/apis\/[0-9a-f-]{36}/, { timeout: 30000 })
    await page.getByText('Search the product documentation and help articles').first().waitFor({ timeout: 30000 })
    await h.show('API operations')
  }],
  ['marketing-2-agent', 'A product assistant that answers from the help center', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.link('Agents')
    await h.click('Create agent')
    await h.click('Autonomous')
    await page.getByPlaceholder('Agent name').fill('Product questions')
    await page.locator('#role-main-model').click()
    await page.getByRole('option', { name: /^gpt-4o-mini/ }).first().click()
    await page.getByLabel('Personality and style').fill('Warm and clear. Short answers, plain words.')
    await page.getByLabel('Instructions').fill(MARKETING_INSTRUCTIONS)
    await page.getByRole('checkbox', { name: /All tools of Northwind Help Center/ }).click()
    await h.show('Capabilities')
  }],
  ['marketing-3-try', 'An answer with its source', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.click('Save', { exact: true })
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
    await h.click('Back to agents')
    await h.link('Product questions')
    await h.click('Activate')
    await page.getByPlaceholder('Type a message to test this agent...').fill('Does the Brew 2 grinder work in the UK?')
    await h.click('Run test')
    await page.getByRole('status').filter({ hasText: /240 V/ }).waitFor({ timeout: 60000 })
    await page.waitForTimeout(4000)
    await h.show('Try it')
  }],
  ['marketing-4-limits', 'A daily spending cap for visitors', src('frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels'), async (page, h) => {
    await h.click('Channels', { role: 'tab' })
    await h.link('Branding and visitor rules')
    await page.locator('input#agent-name').fill('Ask Northwind')
    await page.locator('textarea#agent-greeting').fill('Questions about our grinders and espresso machines? Ask away.')
    await page.locator('input#agent-prompt').first().fill('Which grinder is right for me?')
    await h.click('Advanced')
    await page.locator('input#agent-cost-cap').fill('0.10')
    await page.locator('input#agent-daily-cap').fill('10')
    await page.locator('input#agent-monthly-cap').fill('200')
    await page.locator('input#agent-per-user').fill('20')
    await h.show('What it may cost')
  }],
  ['marketing-5-widget', 'The chat bubble, only on your own site', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/gateways/widget-builder.tsx'), async (page, h) => {
    await page.getByRole('button', { name: 'Save' }).last().click()
    await h.settle(1500)
    await h.link('Agents')
    await h.link('Product questions')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^Website widget/ }).click()
    await page.getByRole('button', { name: 'Publish', exact: true }).first().click()
    await page.getByText('Add it to your site').waitFor({ timeout: 20000 })
    await page.getByPlaceholder(/https:\/\/www\.example\.com|example\.com/).last().fill('https://www.northwind.example')
    await page.getByRole('button', { name: 'Add', exact: true }).last().click()
    await h.settle()
    await h.show('Allowed sites')
  }],
  ['marketing-6-visitor', 'A visitor asks a product question', src('frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts'), async (page, h) => {
    const save = page.getByRole('button', { name: 'Save', exact: true }).last()
    if (await save.isVisible() && await save.isEnabled()) { await save.click(); await h.settle(1500) }
    await h.link('Agents')
    await h.link('Product questions')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^Web chat/ }).click()
    await page.getByRole('button', { name: 'Publish', exact: true }).first().click()
    await page.getByRole('button', { name: 'Unpublish' }).waitFor({ timeout: 20000 })
    const slug = await page.locator('input#channel-address').inputValue()
    await h.go(`/?__slug=${slug}`)
    await page.getByRole('textbox', { name: 'Message' }).fill('Does the Brew 2 grinder work in the UK?')
    await page.getByRole('button', { name: 'Send' }).click()
    await page.getByText(/240 V/).last().waitFor({ timeout: 60000 })
    await page.waitForTimeout(800)
  }],
]

const OPS_INSTRUCTIONS = 'Check the health of every Northwind system and write one short report: first what needs attention (anything degraded, failing or above 80% full) with the detail, then one line saying everything else is fine. If everything is fine, say so in one line.'

const OPERATIONS = [
  ['ops-1-connect-status', 'Connect the system you check', src('frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis'), async (page, h) => {
    await h.go('/apis')
    await h.link('Connect an API')
    await page.getByTestId('api-kind-openapi').click()
    await h.click('File', { role: 'tab' })
    await page.locator('input[type=file]').first().setInputFiles(join(FILES, 'northwind-status-openapi.json'))
    await h.click('Connect API')
    await page.waitForURL(/\/apis\/[0-9a-f-]{36}/, { timeout: 30000 })
    await page.getByText('Check the health of every system').first().waitFor({ timeout: 30000 })
    await h.show('API operations')
  }],
  ['ops-2-agent', 'The nightly check and its status tools', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.link('Agents')
    await h.click('Create agent')
    await h.click('Autonomous')
    await page.getByPlaceholder('Agent name').fill('Nightly systems check')
    await page.locator('#role-main-model').click()
    await page.getByRole('option', { name: /^gpt-4o-mini/ }).first().click()
    await page.getByLabel('Personality and style').fill('Plain and short. Lead with what needs attention.')
    await page.getByLabel('Instructions').fill(OPS_INSTRUCTIONS)
    await page.getByRole('checkbox', { name: /All tools of Northwind Status/ }).click()
    await h.show('Capabilities')
  }],
  ['ops-3-try', 'A test run writes the report', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.click('Save', { exact: true })
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
    await h.click('Back to agents')
    await h.link('Nightly systems check')
    await h.click('Activate')
    await page.getByPlaceholder('Type a message to test this agent...').fill('Run the nightly check.')
    await h.click('Run test')
    await page.getByRole('status').filter({ hasText: /4 of 5 systems/ }).waitFor({ timeout: 60000 })
    await page.waitForTimeout(4000)
    await h.show('Try it')
  }],
  ['ops-4-slack', 'Slack, published for the report', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/connect'), async (page, h) => {
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^Slack/ }).click()
    await h.settle(1500)
    await h.click('Create one here')
    // Placeholder Slack app keys, shaped like real ones; nothing is sent to Slack until someone installs it.
    await page.getByLabel('Client ID').first().fill('4312876501.7719203348122')
    await page.getByRole('textbox', { name: 'Client secret' }).first().fill('demo0client0secret0000001')
    await page.getByRole('textbox', { name: 'Signing secret' }).first().fill('demo0signing0secret000001')
    await page.getByRole('button', { name: 'Save', exact: true }).first().click()
    await h.settle(1500)
    await page.getByRole('button', { name: 'Save', exact: true }).last().click()
    await h.settle(1500)
    await page.getByRole('button', { name: 'Publish', exact: true }).first().click()
    await page.getByRole('button', { name: 'Unpublish' }).waitFor({ timeout: 20000 })
    await h.show('Add to Slack')
  }],
  ['ops-5-schedule', 'Every day at 6:00, to the Slack channel', src('frontend/src/pages/agent-schedule.tsx', 'frontend/src/lib/schedule.ts', 'frontend/src/components/settings/time-zone-select.tsx'), async (page, h) => {
    await h.link('Agents')
    await h.link('Nightly systems check')
    await h.click(/^(Set up a schedule|Edit schedule)$/)
    await page.locator('#schedule-days').click()
    await page.getByRole('option', { name: 'Every day' }).click()
    await page.locator('#schedule-time').fill('06:00')
    await page.locator('#schedule-target').click()
    await page.getByRole('option', { name: /^Slack/ }).first().click()
    // The channel ID of #ops; the bot has to be invited there.
    await page.locator('#schedule-destination-typed').fill('C07NWOPS01')
    await page.locator('#schedule-message').fill('Run the nightly check.')
    await h.settle()
    await h.show('When it runs')
  }],
  ['ops-6-schedule-card', 'The schedule on the agent', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents/detail/schedule-card.tsx'), async (page, h) => {
    await h.click('Save schedule')
    await page.getByTestId('schedule-card-summary').waitFor({ timeout: 20000 })
    await h.settle()
    await page.getByTestId('schedule-card-summary').evaluate((e) => e.closest('.rounded-lg, [class*=card]')?.scrollIntoView({ block: 'center' }) ?? e.scrollIntoView({ block: 'center' }))
    await page.waitForTimeout(400)
  }],
  ['ops-7-report-run', 'A report run, step by step', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.top()
    await h.click('Runs', { role: 'tab' })
    await h.settle(1500)
    await page.locator('tbody tr').first().click()
    await h.settle(800)
    await h.show('Autonomous runs')
  }],
]

const HELPDESK_INSTRUCTIONS = 'You answer questions from Northwind staff about HR, IT and the office. Look things up before you answer: the staff handbook and policies, their leave balance (ask for their work email if you need it), and the office guide in memory. Say where the answer came from. If someone needs something done by IT, tell them how to open an IT request. Never share one person\'s details with another.'
const OFFICE_GUIDE = 'Office guide, Leipzig office.\n\nWi-Fi: guests use NW-Guest; the password changes every Monday and is on the card at reception. Staff laptops join NW-Staff automatically.\n\nOpening hours: 7:00 to 20:00. After hours, use your badge at the side door.\n\nParking: the courtyard spaces are for visitors. Staff park in the garage on Lindenstrasse; ask reception for a card.\n\nKitchen: coffee and tea are free. Please empty the dishwasher if it is clean.'

const HELPDESK = [
  ['helpdesk-1-connect-intranet', 'Connect your intranet', src('frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis'), async (page, h) => {
    await h.go('/apis')
    await h.link('Connect an API')
    await page.getByTestId('api-kind-openapi').click()
    await h.click('File', { role: 'tab' })
    await page.locator('input[type=file]').first().setInputFiles(join(FILES, 'northwind-intranet-openapi.json'))
    await h.click('Connect API')
    await page.waitForURL(/\/apis\/[0-9a-f-]{36}/, { timeout: 30000 })
    await page.getByText('Search the staff handbook and HR and IT policies').first().waitFor({ timeout: 30000 })
    await h.show('API operations')
  }],
  ['helpdesk-2-office-guide', 'The office guide, added as a document', src('frontend/src/pages/memory-new.tsx', 'frontend/src/components/memory'), async (page, h) => {
    await h.link('Memory')
    await h.click('Add memory')
    await page.locator('#memory-content').fill(OFFICE_GUIDE)
    await page.locator('#memory-tags').fill('office, wifi')
    await h.click('Advanced')
    // A document in the organization's memory: what an agent with shared memory searches before it answers.
    await page.locator('#memory-mode').click()
    await page.getByRole('option', { name: 'Document' }).click()
    await h.settle()
  }],
  ['helpdesk-3-agent', 'The help desk assistant reads shared memory', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.click('Save memory')
    await h.settle(1500)
    await h.link('Agents')
    await h.click('Create agent')
    await h.click('Autonomous')
    await page.getByPlaceholder('Agent name').fill('Ask HR and IT')
    await page.locator('#role-main-model').click()
    await page.getByRole('option', { name: /^gpt-4o(?!-)/ }).first().click()
    await page.getByLabel('Personality and style').fill('Friendly and to the point, like a helpful colleague.')
    await page.getByLabel('Instructions').fill(HELPDESK_INSTRUCTIONS)
    const memory = page.locator('#memory-enabled')
    if ((await memory.getAttribute('aria-checked')) !== 'true') await memory.click()
    await page.locator('#memory-whose').click()
    await page.getByRole('option', { name: 'Shared by all agents' }).click()
    await page.locator('#memory-save').click()
    await page.getByRole('option', { name: 'Only when asked' }).click()
    await page.getByRole('checkbox', { name: /All tools of Northwind Intranet/ }).click()
    await h.show('Remember between conversations')
  }],
  ['helpdesk-4-leave', 'A question answered from the HR system', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await h.click('Save', { exact: true })
    await page.waitForURL(/\/agents\/[0-9a-f-]{36}\/edit/, { timeout: 20000 })
    await h.click('Back to agents')
    await h.link('Ask HR and IT')
    await h.click('Activate')
    await page.getByPlaceholder('Type a message to test this agent...').fill('How many vacation days do I have left? My email is sam.rivera@northwind.example.')
    await h.click('Run test')
    await page.getByRole('status').filter({ hasText: /vacation days left/ }).waitFor({ timeout: 60000 })
    await page.waitForTimeout(4000)
    await h.show('Try it')
  }],
  ['helpdesk-5-wifi', 'A question answered from the office guide', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), async (page, h) => {
    await page.getByPlaceholder('Type a message to test this agent...').fill('What is the guest Wi-Fi at the office?')
    await h.click('Run test')
    await page.getByRole('status').filter({ hasText: /NW-Guest/ }).waitFor({ timeout: 60000 })
    await h.show('Try it')
  }],
  ['helpdesk-6-teams', 'Add Microsoft Teams', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/connect'), async (page, h) => {
    await h.link('Agents')
    await h.link('Ask HR and IT')
    await h.click('Channels', { role: 'tab' })
    await h.click('Add channel')
    await page.getByRole('button', { name: /^Microsoft Teams/ }).click()
    await h.settle(1500)
    await h.click('Create one here')
    await h.show('Keys')
  }],
]

const DEVELOPERS = [
  ['dev-1-gateway', 'Serve the order tools to coding assistants', src('frontend/src/pages/gateway-new.tsx', 'frontend/src/components/gateways'), async (page, h) => {
    await h.go('/gateways')
    await h.click('Create gateway')
    await page.getByRole('button', { name: /^MCP/ }).click()
    await page.getByRole('button', { name: /^Northwind Orders/ }).click()
    await page.locator('#gateway-name').fill('Northwind Orders')
    await h.settle()
    await h.show('Protocol')
  }],
  ['dev-2-gateway-setup', 'The address, the key and a ready-made setup', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways'), async (page, h) => {
    await h.click('Create gateway')
    await page.waitForURL(/\/gateways\/[0-9a-f-]{36}/, { timeout: 20000 })
    await h.settle(1500)
  }],
  ['dev-3-runner', 'Start a runner on your own machine', src('frontend/src/pages/runner-new.tsx', 'frontend/src/components/runners'), async (page, h) => {
    await h.link('Runners')
    await h.click('Start a runner')
    await page.getByText('npm i -g @almyty/cli', { exact: true }).waitFor()
    await h.settle()
  }],
  ['dev-4-runner-command', 'The commands to run on the machine', src('frontend/src/pages/runner-new.tsx', 'frontend/src/components/runners'), async (page, h) => {
    await page.getByText('almyty runner start', { exact: true }).waitFor()
    await h.settle(1500)
  }],
]

export const GUIDES = { support: SUPPORT, sales: SALES, marketing: MARKETING, operations: OPERATIONS, helpdesk: HELPDESK, developers: DEVELOPERS }

async function walk(names, from) {
  await account()
  await specFiles()
  const browser = await chromium.launch()
  const { ctx, page } = await session(browser)
  const h = helpers(page)
  const log = join(OUT, 'captures.json')
  const results = existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : {}
  let failed = false
  for (const name of names) {
    let skipping = Boolean(from)
    for (const [shot, , , action] of GUIDES[name]) {
      if (skipping && shot !== from) continue
      skipping = false
      try {
        await action(page, h)
        // The dev build's query devtools, and toasts that have said their piece, stay out of the picture.
        await page.addStyleTag({ content: '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }' })
        await page.mouse.move(0, 0)
        const file = join(OUT, `${shot}.png`)
        await page.screenshot({ path: file })
        results[shot] = { file, route: new URL(page.url()).pathname + new URL(page.url()).search, at: new Date().toISOString() }
        console.log('step', shot, page.url())
      } catch (e) {
        failed = true
        console.log('FAILED', shot, e.message.split('\n')[0])
        await page.screenshot({ path: join(OUT, `${shot}-FAILED.png`) }).catch(() => {})
        break
      }
    }
    // Later guides build on the earlier ones (the model connected in the first): stop at the first failure.
    if (failed) break
  }
  writeFileSync(log, JSON.stringify(results, null, 2))
  await ctx.close()
  await browser.close()
  if (failed) process.exitCode = 1
}

function register(shots) {
  const log = JSON.parse(readFileSync(join(OUT, 'captures.json'), 'utf8'))
  const steps = Object.fromEntries(Object.values(GUIDES).flat().map(([shot, title, sources]) => [shot, { title, sources }]))
  for (const shot of shots.length ? shots : Object.keys(steps)) {
    const c = log[shot]
    if (!c) { console.log('not captured', shot); continue }
    const route = c.route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
    execFileSync(process.execPath, [join(ROOT, 'docs-site/scripts/record-screenshot.mjs'), '--image', c.file, '--path', `screenshots/guides/${shot}.png`, '--title', steps[shot].title, '--captured-at', c.at, '--route', route, '--environment', 'local-demo',
      '--notes', 'Use-case guide step, walked through the UI on the local seeded demo stack (scripts/demo-seed/guides.mjs); fake model vendor and company systems, not staging or production data.',
      ...steps[shot].sources.flatMap((s) => ['--sources', s])], { stdio: 'inherit' })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--register') register(args.slice(1))
else {
  const from = args.includes('--from') ? args.splice(args.indexOf('--from'), 2)[1] : null
  await walk(args.length ? args : Object.keys(GUIDES), from)
}
