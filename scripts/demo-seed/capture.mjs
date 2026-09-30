#!/usr/bin/env node
// Captures the documentation screenshots from the seeded local demo stack
// (stack.sh up, then seed.mjs). Each shot lands in $SHOT_DIR (default
// /tmp/almyty-demo/shots) for review; nothing is registered here. After
// looking at the pixels, register the ones that are right with
// `node scripts/demo-seed/capture.mjs --register name...`, which runs
// docs-site/scripts/record-screenshot.mjs with the shot's route and sources.
//
//   node scripts/demo-seed/capture.mjs                  every shot
//   node scripts/demo-seed/capture.mjs agent-channels   only these
//   node scripts/demo-seed/capture.mjs --register agent-channels
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USER } from './seed.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(join(ROOT, 'frontend/package.json'))
const { chromium } = require('@playwright/test')

const WEB = process.env.DEMO_WEB_URL || 'http://localhost:3210'
const OUT = process.env.SHOT_DIR || '/tmp/almyty-demo/shots'
mkdirSync(OUT, { recursive: true })

const UI = ['frontend/src/components/ui', 'frontend/src/components/layout', 'frontend/src/index.css']
const src = (...paths) => [...paths, ...UI]

// ids by name, read through the signed-in page
async function ids(page) {
  const get = async (path) => {
    const r = await page.request.get(`${WEB}${path}`)
    const body = await r.json().catch(() => null)
    return body?.data ?? body
  }
  const arr = (x, k) => (Array.isArray(x) ? x : x?.[k] ?? x?.items ?? [])
  const agents = arr(await get('/agents?limit=100'), 'agents')
  const gateways = arr(await get('/gateways'), 'gateways')
  const apis = arr(await get('/apis'), 'apis')
  const providers = arr(await get('/llm-providers'), 'providers')
  const credentials = arr(await get('/credentials'), 'credentials')
  const runners = arr(await get('/runners'), 'runners')
  const approvals = arr(await get('/approvals'), 'approvals')
  const by = (rows, name) => rows.find((r) => r.name === name)?.id
  const support = by(agents, 'Customer Support Orchestrator')
  const channels = support ? arr(await get(`/agents/${support}/channels`), 'channels') : []
  const orgId = page.__orgId
  const tools = orgId ? arr(await get(`/organizations/${orgId}/tools?limit=100`), 'tools') : []
  return {
    support, research: by(agents, 'Market Research Analyst'), digest: by(agents, 'Nightly CSAT Digest'),
    gwSupport: by(gateways, 'Northwind Support Tools'), gwPetstore: by(gateways, 'Petstore'), gwUtcp: by(gateways, 'Orders for partners'), gwSkills: by(gateways, 'Northwind skills'),
    apiOrders: by(apis, 'Northwind Orders'), apiPetstore: by(apis, 'Petstore'),
    providerOpenai: by(providers, 'OpenAI'),
    channel: Object.fromEntries(channels.map((c) => [c.type, c])),
    tool: tools.find((t) => t.name === 'northwind_orders_track_shipment')?.id,
    runner: runners[0]?.id, approval: approvals.find((a) => a.status === 'pending')?.id ?? approvals[0]?.id,
    credential: credentials.find((c) => c.name === 'Northwind Slack app')?.id,
  }
}

const click = (text, opts = {}) => async (page) => { await page.getByRole(opts.role || 'button', { name: text, exact: opts.exact }).first().click(); await page.waitForTimeout(600) }
const scrollTo = (text) => async (page) => { await page.getByText(text, { exact: true }).first().scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -80)); await page.waitForTimeout(400) }
const section = (text) => async (page) => { const el = page.getByText(text, { exact: true }).first(); await el.evaluate((e) => e.scrollIntoView({ block: 'start' })); await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollBy(0, -32); window.scrollBy(0, -32) }); await page.waitForTimeout(400) }
// A visitor asks one question and waits for the answer.
const converse = async (page) => { await page.getByRole('textbox', { name: 'Message' }).fill('Where is order NW-10428? It was due last week.'); await page.getByRole('button', { name: 'Send' }).click(); await page.getByText(/held at customs|DHL Express/).last().waitFor({ timeout: 30000 }); await page.waitForTimeout(800) }
const heading = (name) => async (page) => { const h = page.getByRole('heading', { name }).first(); await h.scrollIntoViewIfNeeded(); await h.evaluate((el) => el.scrollIntoView({ block: 'start' })); await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollBy(0, -24); window.scrollBy(0, -24) }); await page.waitForTimeout(400) }

// name: [published path, route(ids), width px, height px, title, sources, prepare?]
export const SHOTS = {
  'agents-list': ['agents-list.png', () => '/agents', 2880, 2000, 'Agents list', src('frontend/src/pages/agents.tsx', 'frontend/src/components/agents')],
  'agent-detail-overview': ['agent-detail-overview.png', (i) => `/agents/${i.support}`, 2880, 1500, 'Autonomous agent overview', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents')],
  'support-agent-overview': ['support-agent-overview.png', (i) => `/agents/${i.support}`, 2880, 1500, 'Support agent overview', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents')],
  'agent-constraints': ['agent-constraints.png', (i) => `/agents/${i.support}?tab=constraints`, 2880, 1900, 'Agent constraints', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents')],
  'support-agent-constraints': ['support-agent-constraints.png', (i) => `/agents/${i.support}?tab=constraints`, 2880, 1900, 'Support agent constraints', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents')],
  'support-agent-runs': ['support-agent-runs.png', (i) => `/agents/${i.support}?tab=runs`, 2880, 2400, 'Support agent runs', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents')],
  'agent-skill-viewer': ['agent-skill-viewer.png', (i) => `/agents/${i.support}?tab=skills`, 2560, 1600, 'Agent skills', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents')],
  'agent-builder-autonomous': ['agent-builder-autonomous.png', (i) => `/agents/${i.support}/edit`, 2560, 1600, 'Autonomous agent: work mode', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), heading('Work mode')],
  'agent-work-mode-panel': ['agent-work-mode-panel.png', (i) => `/agents/${i.research}/edit`, 2560, 1600, 'Panel work mode', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), heading('Work mode')],
  'agent-builder': ['agent-builder.png', (i) => `/agents/${i.digest}/edit`, 1440, 900, 'Workflow builder', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents'), null, 1],
  'agent-builder-node-palette': ['agent-builder-node-palette.png', (i) => `/agents/${i.digest}/edit`, 2880, 1800, 'Steps palette', src('frontend/src/pages/agent-builder.tsx', 'frontend/src/components/agents')],
  'schedule-config': ['schedule-config.png', (i) => `/agents/${i.digest}`, 2880, 1800, 'Schedule card', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), heading('Schedule')],
  'webhook-config': ['webhook-config.png', (i) => `/agents/${i.digest}`, 2880, 1800, 'Webhook card', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), heading('Webhook')],
  'versioning': ['versioning.png', (i) => `/agents/${i.digest}`, 2880, 1800, 'Pipeline versions', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), heading('Pipeline versions')],
  'versioning-history': ['versioning-history.png', (i) => `/agents/${i.support}`, 2880, 927, 'Change history', src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents'), heading('Change history')],
  'agent-channels': ['agent-channels.png', (i) => `/agents/${i.support}?tab=channels`, 2880, 1800, "An agent's Channels tab", src('frontend/src/pages/agent-detail.tsx', 'frontend/src/components/agents', 'frontend/src/components/channels')],
  'channel-branding-rules': ['channel-branding-rules.png', (i) => `/agents/${i.support}/channels/settings`, 2880, 1800, 'Branding and visitor rules', src('frontend/src/pages/agent-public-settings.tsx', 'frontend/src/components/channels')],
  'channel-web-published': ['channel-web-published.png', (i) => `/agents/${i.support}/channels/${i.channel.web?.id}`, 2880, 2200, 'Published web chat channel', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels')],
  'channel-slack-keys': ['channel-slack-keys.png', (i) => `/agents/${i.support}/channels/${i.channel.slack?.id}`, 2880, 1800, 'Slack channel keys', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels')],
  'channel-slack-live': ['channel-slack-live.png', (i) => `/agents/${i.support}/channels/${i.channel.slack?.id}`, 2880, 1800, 'Published Slack channel', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels'), section('Install link')],
  'channel-terminal-build': ['channel-terminal-build.png', (i) => `/agents/${i.support}/channels/${i.channel.tui?.id}`, 2880, 1800, 'Terminal app channel', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels')],
  'interfaces-channel-config': ['interfaces-channel-config.png', (i) => `/agents/${i.support}/channels/new`, 2560, 1600, 'Add channel', src('frontend/src/pages/agent-channel-new.tsx', 'frontend/src/components/channels')],
  'interfaces-channel-setup': ['interfaces-channel-setup.png', (i) => `/agents/${i.support}/channels/${i.channel.microsoft_teams?.id}`, 2560, 1600, 'Microsoft Teams channel', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels')],
  'widget-builder': ['widget-builder.png', (i) => `/agents/${i.support}/channels/${i.channel.widget?.id}`, 2560, 1600, 'Website widget channel', src('frontend/src/pages/agent-channel.tsx', 'frontend/src/components/channels', 'frontend/src/components/gateways/widget-builder.tsx'), section('Preview')],
  'hosted-chat': ['hosted-chat.png', (i) => `/?__slug=${i.channel.web?.slug || 'northwind-help'}`, 2880, 2200, 'Hosted web chat', src('frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts'), converse, 2, true],
  'hosted-chat-privacy': ['hosted-chat-privacy.png', (i) => `/?__slug=${i.channel.web?.slug || 'northwind-help'}`, 2880, 2000, 'Hosted chat: visitor data', src('frontend/src/pages/hosted-chat.tsx', 'frontend/src/lib/hosted-chat.ts'), async (p) => { await converse(p); await p.getByRole('button', { name: 'Privacy and visitor data' }).click(); await p.waitForTimeout(500) }, 2, true],
  'apis-list': ['apis-list.png', () => '/apis', 2880, 1700, 'APIs list', src('frontend/src/pages/apis.tsx', 'frontend/src/components/apis')],
  'quickstart-api-imported': ['quickstart-api-imported.png', (i) => `/apis/${i.apiPetstore}`, 2880, 1800, 'Imported API', src('frontend/src/pages/api-detail.tsx', 'frontend/src/components/apis')],
  'tools-list': ['tools-list.png', () => '/tools', 2880, 1500, 'Tools list', src('frontend/src/pages/tools.tsx', 'frontend/src/components/tools')],
  'tool-detail': ['tool-detail.png', (i) => `/tools/${i.tool}?tab=test`, 2880, 1800, 'Tool test', src('frontend/src/pages/tool-detail.tsx', 'frontend/src/components/tools'), async (p) => { await p.getByPlaceholder('Enter orderId').fill('NW-10428'); await p.getByRole('button', { name: 'Execute Tool' }).click(); await p.getByText(/Leipzig|DHL/).first().waitFor({ timeout: 20000 }).catch(() => {}); await p.waitForTimeout(600) }],
  'gateway-detail': ['gateway-detail.png', (i) => `/gateways/${i.gwSupport}`, 2560, 1600, 'Gateway detail', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways')],
  'gateway-detail-tools': ['gateway-detail-tools.png', (i) => `/gateways/${i.gwSupport}?tab=tools`, 2560, 1600, 'Gateway tool scoping', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways'), section('Tool scoping')],
  'gateway-petstore-config': ['gateway-petstore-config.png', (i) => `/gateways/${i.gwPetstore}`, 2560, 1600, 'Petstore gateway', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways')],
  'quickstart-gateway-mcp': ['quickstart-gateway-mcp.png', (i) => `/gateways/${i.gwPetstore}`, 2880, 1800, 'Petstore MCP gateway', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways')],
  'gateway-petstore-integration': ['gateway-petstore-integration.png', (i) => `/gateways/${i.gwPetstore}?tab=integrations`, 2560, 1600, 'Gateway integrations', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways'), section('MCP endpoint')],
  'quickstart-mcp-endpoints': ['quickstart-mcp-endpoints.png', (i) => `/gateways/${i.gwPetstore}?tab=integrations`, 2880, 1800, 'MCP endpoints', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways'), section('MCP endpoint')],
  'quickstart-claude-config': ['quickstart-claude-config.png', (i) => `/gateways/${i.gwPetstore}?tab=integrations`, 2880, 1800, 'Client setup', src('frontend/src/pages/gateway-detail.tsx', 'frontend/src/components/gateways'), section('Quick setup')],
  'credentials-vault': ['credentials-vault.png', () => '/credentials', 2880, 1800, 'Credentials', src('frontend/src/pages/credentials.tsx', 'frontend/src/pages/credential-pages.tsx', 'frontend/src/components/credentials')],
  'credentials-connect-provider': ['credentials-connect-provider.png', () => '/credentials/providers/new', 1440, 900, 'Connect a provider', src('frontend/src/pages/models-connect.tsx', 'frontend/src/components/models'), null, 1],
  'models': ['models.png', () => '/models', 2880, 1800, 'Model catalog', src('frontend/src/pages/models.tsx', 'frontend/src/components/models')],
  'memory': ['memory.png', () => '/memories', 2880, 1800, 'Memory', src('frontend/src/pages/memories.tsx', 'frontend/src/components/memory')],
  'memory-write': ['memory-write.png', () => '/memories/new', 2880, 1800, 'Add memory', src('frontend/src/pages/memory-new.tsx', 'frontend/src/components/memory')],
  'approvals-pending': ['approvals-pending.png', () => '/approvals', 2560, 1600, 'Pending approvals', src('frontend/src/pages/approvals.tsx', 'frontend/src/components/entitlement-gate.tsx')],
  'approval-refund-820': ['approval-refund-820.png', () => '/approvals', 2560, 1600, 'Refund approval', src('frontend/src/pages/approvals.tsx', 'frontend/src/components/entitlement-gate.tsx'), async (p) => { await p.getByText(/Refund of \$820/).first().click().catch(() => {}); await p.waitForTimeout(600) }],
  'runners-list': ['runners-list.png', () => '/runners', 2880, 1800, 'Runners', src('frontend/src/pages/runners.tsx', 'frontend/src/pages/runners-shared.ts', 'frontend/src/components/runners')],
  'runner-detail': ['runner-detail.png', (i) => `/runners/${i.runner}`, 2880, 1800, 'Runner detail', src('frontend/src/pages/runner-detail.tsx', 'frontend/src/pages/runners-shared.ts', 'frontend/src/components/runners')],
  'analytics-overview': ['analytics-overview.png', () => '/analytics', 2880, 1800, 'Analytics overview', src('frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics')],
  'analytics-agents': ['analytics-agents.png', () => '/analytics/agents', 2880, 1800, 'Analytics: agents', src('frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics')],
  'analytics-tools': ['analytics-tools.png', () => '/analytics/tools', 2880, 1800, 'Analytics: tools', src('frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics')],
  'analytics-gateways': ['analytics-gateways.png', () => '/analytics/gateways', 2880, 1800, 'Analytics: gateways', src('frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics')],
  'analytics-audit': ['analytics-audit.png', () => '/analytics/audit', 2880, 1800, 'Audit trail', src('frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics')],
  'analytics-chargeback-locked': ['analytics-chargeback-locked.png', () => '/analytics/chargeback', 2880, 1440, 'Chargeback (Enterprise, locked)', src('frontend/src/pages/analytics.tsx', 'frontend/src/components/analytics')],
  'settings-teams': ['settings-teams.png', () => '/settings/members', 2880, 1800, 'Members and teams', src('frontend/src/pages/settings.tsx', 'frontend/src/components/MembersAndTeamsTab.tsx', 'frontend/src/components/settings')],
  'settings-rbac-enabled': ['settings-rbac-enabled.png', () => '/settings/rbac', 2880, 1800, 'Roles', src('frontend/src/pages/settings.tsx', 'frontend/src/components/settings')],
  'settings-rbac-new-role': ['settings-rbac-new-role.png', () => '/settings/rbac', 2880, 2400, 'New role', src('frontend/src/pages/settings.tsx', 'frontend/src/components/settings'), click(/new role|add role|custom role/i)],
  'settings-rbac-new-policy': ['settings-rbac-new-policy.png', () => '/settings/rbac', 2880, 2400, 'New access policy', src('frontend/src/pages/settings.tsx', 'frontend/src/components/settings'), click(/new policy|add policy|access policy/i)],
  'settings-sso-enabled': ['settings-sso-enabled.png', () => '/settings/sso', 2880, 2400, 'Single sign-on', src('frontend/src/pages/settings.tsx', 'frontend/src/components/settings')],
  'settings-approval-policies-enabled': ['settings-approval-policies-enabled.png', () => '/settings/approvals', 2880, 1800, 'Approval policies', src('frontend/src/pages/settings.tsx', 'frontend/src/pages/approval-policy.tsx', 'frontend/src/components/settings')],
  'settings-approval-policy-new': ['settings-approval-policy-new.png', () => '/settings/approvals/policies/new', 2880, 2400, 'New approval policy', src('frontend/src/pages/approval-policy.tsx', 'frontend/src/components/settings')],
  'settings-compliance-enabled': ['settings-compliance-enabled.png', () => '/settings/compliance', 2880, 2400, 'Compliance', src('frontend/src/pages/settings.tsx', 'frontend/src/components/settings')],
  'settings-audit-streams-enabled': ['settings-audit-streams-enabled.png', () => '/settings/audit-streams', 2880, 2400, 'Audit streaming', src('frontend/src/pages/settings.tsx', 'frontend/src/components/settings')],
  'settings-encryption-locked': ['settings-encryption-locked.png', () => '/settings/encryption', 2880, 1440, 'Encryption (Enterprise, locked)', src('frontend/src/pages/settings.tsx', 'frontend/src/components/settings')],
  'auth-register': ['auth-register.png', () => '/auth/register', 1440, 989, 'Create account', src('frontend/src/pages/auth'), null, 1, true],
}

async function login(browser) {
  const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'dark', viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto('/auth/login')
  await page.locator('#email').fill(USER.email)
  await page.locator('#password').fill(USER.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/dashboard/)
  const state = await ctx.storageState()
  const profile = await (await page.request.get(`${WEB}/auth/profile`)).json().catch(() => null)
  const p = profile?.data ?? profile
  const orgId = p?.currentOrganizationId ?? p?.organizationMemberships?.[0]?.organization?.id ?? p?.organizations?.[0]?.id
  page.__orgId = orgId
  const found = await ids(page)
  await ctx.close()
  return { state, found }
}

async function capture(names) {
  const browser = await chromium.launch()
  const { state, found } = await login(browser)
  console.log('ids', JSON.stringify({ ...found, channel: Object.keys(found.channel) }))
  const results = {}
  for (const name of names) {
    const [, route, w, h, , , prepare, dpr = 2, anonymous] = SHOTS[name]
    const ctx = await browser.newContext({ baseURL: WEB, colorScheme: 'dark', timezoneId: 'UTC', locale: 'en-US', deviceScaleFactor: dpr, viewport: { width: Math.round(w / dpr), height: Math.round(h / dpr) }, ...(anonymous ? {} : { storageState: state }) })
    await ctx.addInitScript(() => { try { localStorage.setItem('theme', 'dark') } catch {} })
    const page = await ctx.newPage()
    try {
      const path = route(found)
      if (path.includes('undefined')) throw new Error(`missing id for ${path}`)
      await page.goto(path)
      await page.waitForLoadState('networkidle').catch(() => {})
      await page.waitForTimeout(1200)
      // The React Query devtools button only exists in the dev build; the product has none. Toasts that have said their piece stay out too.
      await page.addStyleTag({ content: '.tsqd-parent-container, .tsqd-open-btn-container, [role=region][aria-label^="Notifications"] { display: none !important; }' })
      if (prepare) await prepare(page)
      await page.mouse.move(0, 0)
      const file = join(OUT, `${name}.png`)
      await page.screenshot({ path: file })
      results[name] = { file, route: path, at: new Date().toISOString() }
      console.log('shot', name, path)
    } catch (e) {
      console.log('FAILED', name, e.message.split('\n')[0])
    } finally { await ctx.close() }
  }
  await browser.close()
  const logFile = join(OUT, 'captures.json')
  const prev = existsSync(logFile) ? JSON.parse(readFileSync(logFile, 'utf8')) : {}
  writeFileSync(logFile, JSON.stringify({ ...prev, ...results }, null, 2))
}

function register(names) {
  const log = JSON.parse(readFileSync(join(OUT, 'captures.json'), 'utf8'))
  for (const name of names) {
    const [path, , , , title, sources] = SHOTS[name]
    const c = log[name]
    if (!c) { console.log('not captured', name); continue }
    const route = c.route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ':id')
    execFileSync(process.execPath, [join(ROOT, 'docs-site/scripts/record-screenshot.mjs'), '--image', c.file, '--path', `screenshots/${path}`, '--title', title, '--captured-at', c.at, '--route', route, '--environment', 'local-demo',
      '--notes', 'Local seeded Northwind AI demo stack (scripts/demo-seed), fake model vendors and company APIs; not staging or production data.',
      ...sources.flatMap((s) => ['--sources', s])], { stdio: 'inherit' })
  }
}

const args = process.argv.slice(2)
if (args[0] === '--register') register(args.slice(1).length ? args.slice(1) : Object.keys(SHOTS))
else await capture(args.length ? args : Object.keys(SHOTS))
