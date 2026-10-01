#!/usr/bin/env node
// Seeds the Northwind AI demo organization on the local docs stack
// (scripts/demo-seed/stack.sh up) for the documentation screenshots.
// Local only: the password below is a local dev test credential, the model
// vendors and company APIs are fake-upstream.mjs, and no key is real.
// Idempotent enough to rerun: each step skips what already exists by name.
//
//   eval "$(scripts/demo-seed/stack.sh env)"; node scripts/demo-seed/seed.mjs
import { execSync } from 'node:child_process'

const API = process.env.DEMO_API_URL || 'http://localhost:4210'
const FAKE = process.env.DEMO_FAKE_URL || 'http://localhost:4290'
const PSQL = process.env.DEMO_PSQL || 'docker exec -i almyty-demo-pg psql -U postgres -d almyty_qa'
export const USER = { email: 'ava.chen@northwind.ai', password: 'Northwind-local-2026!', firstName: 'Ava', lastName: 'Chen', organizationName: 'Northwind AI' }

export const sql = (q) => execSync(`${PSQL} -v ON_ERROR_STOP=1 -tA`, { input: q, encoding: 'utf8' }).trim()

let token = ''
export async function call(method, path, body, { ok = [200, 201, 204], form } = {}) {
  const headers = { ...(token ? { authorization: `Bearer ${token}` } : {}) }
  let payload
  if (form) payload = form
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body) }
  const res = await fetch(`${API}${path}`, { method, headers, body: payload })
  const text = await res.text()
  let json; try { json = text ? JSON.parse(text) : null } catch { json = text }
  if (!ok.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`)
  return json && typeof json === 'object' && 'data' in json && 'success' in json ? json.data : json
}
const list = (x, key) => (Array.isArray(x) ? x : x?.[key] ?? x?.items ?? x?.data ?? [])
const log = (...a) => console.log('-', ...a)

async function signIn() {
  const exists = sql(`SELECT count(*) FROM users WHERE email = '${USER.email}'`) !== '0'
  if (!exists) await call('POST', '/auth/register', USER)
  sql(`UPDATE users SET "isVerified" = true, "verifiedAt" = coalesce("verifiedAt", now()) WHERE email = '${USER.email}'`)
  token = (await call('POST', '/auth/token', { email: USER.email, password: USER.password })).accessToken
  const orgId = sql(`SELECT uo."organizationId" FROM user_organizations uo JOIN users u ON u.id = uo."userId" WHERE u.email = '${USER.email}' LIMIT 1`)
  // The fake upstream is on localhost: the organization says that host is its own.
  await call('PATCH', `/organizations/${orgId}`, { settings: { egressAllowlist: ['localhost'] } })
  return orgId
}

async function providers() {
  const have = list(await call('GET', '/llm-providers'), 'providers')
  const want = [
    { name: 'OpenAI', type: 'openai', prefix: 'openai' },
    { name: 'OpenRouter', type: 'openrouter', prefix: 'openrouter' },
    { name: 'Mistral', type: 'mistral', prefix: 'mistral' },
  ]
  const out = {}
  for (const p of want) {
    let row = have.find((h) => h.name === p.name)
    if (!row) {
      const r = await call('POST', '/llm-providers/connect', { name: p.name, type: p.type, configuration: { apiKey: `sk-demo-${p.prefix}-0000000000`, apiUrl: `${FAKE}/${p.prefix}/v1` } })
      row = r.provider
      log('provider', p.name, r.models?.length, 'models')
    }
    out[p.prefix] = row
  }
  return out
}

async function apis() {
  const have = list(await call('GET', '/apis'), 'apis')
  const out = {}
  for (const [key, title] of [['orders', 'Northwind Orders'], ['helpdesk', 'Northwind Helpdesk']]) {
    let row = have.find((a) => a.name === title)
    if (!row) {
      const content = await (await fetch(`${FAKE}/${key}/openapi.json`)).text()
      const r = await call('POST', '/apis/import', { content, type: 'openapi', name: title, generateTools: true })
      row = r.api
      for (let i = 0; i < 60; i++) {
        const s = await call('GET', `/apis/${row.id}/import-status/${r.jobId}`)
        if (s?.status === 'completed') break
        if (s?.status === 'failed') throw new Error(`import ${title}: ${s.error}`)
        await new Promise((r) => setTimeout(r, 1000))
      }
      log('api', title)
    }
    out[key] = row
  }
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function tools(orgId) {
  const r = await call('GET', `/organizations/${orgId}/tools?limit=100`)
  return list(r, 'tools')
}

async function gateways(orgId, toolRows) {
  const have = list(await call('GET', '/gateways'), 'gateways')
  const ids = (re) => toolRows.filter((t) => re.test(t.name)).map((t) => t.id)
  const want = [
    { name: 'Northwind Support Tools', type: 'mcp', endpoint: '/support-tools', configuration: { transport: 'http' }, toolIds: ids(/^northwind_/), description: 'Orders and helpdesk tools for the support team\'s AI clients.' },
    { name: 'Orders for partners', type: 'utcp', endpoint: '/orders-utcp', configuration: { protocol: 'http' }, toolIds: ids(/^northwind_orders_(get_order|track_shipment|list_orders)/), description: 'Read-only order lookup for logistics partners.' },
    { name: 'Northwind skills', type: 'skills', endpoint: '/northwind-skills', configuration: { format: 'skill-md' }, toolIds: ids(/^northwind_helpdesk_/), description: 'Helpdesk skills for coding agents, installed with @almyty/skills.' },
    { name: 'Petstore', type: 'mcp', endpoint: '/petstore', configuration: { transport: 'http' }, toolIds: ids(/^petstore_/) },
  ]
  const out = {}
  for (const g of want) {
    if (!g.toolIds.length) { log('gateway skipped (no tools)', g.name); continue }
    let row = have.find((h) => h.name === g.name)
    if (!row) { row = await call('POST', '/gateways', { ...g, kind: 'tool', visibility: 'org' }); log('gateway', g.name) }
    out[g.endpoint.slice(1)] = row
  }
  return out
}

async function petstore() {
  const have = list(await call('GET', '/apis'), 'apis')
  let row = have.find((a) => a.name === 'Petstore')
  if (row) return row
  try {
    const r = await call('POST', '/apis/import', { url: 'https://petstore3.swagger.io/api/v3/openapi.json', type: 'openapi', name: 'Petstore', generateTools: true })
    for (let i = 0; i < 60; i++) {
      const s = await call('GET', `/apis/${r.api.id}/import-status/${r.jobId}`)
      if (s?.status === 'completed' || s?.status === 'failed') break
      await sleep(1000)
    }
    log('api Petstore')
    return r.api
  } catch (e) { log('petstore skipped:', e.message.slice(0, 160)) }
}

async function credentials() {
  const have = list(await call('GET', '/credentials'), 'credentials')
  const want = [
    { key: 'channel-slack-app', name: 'Northwind Slack app', input: { client_id: '4312876501.7719203348121', client_secret: 'demo0client0secret0000000', signing_secret: 'demo0signing0secret000000' } },
    { key: 'channel-webhook', name: 'Ops webhook secret', input: null },
  ]
  const out = {}
  for (const c of want) {
    let row = have.find((h) => h.name === c.name)
    if (!row && c.input) {
      try {
        const r = await call('POST', `/credentials/connect/${c.key}`, { method: 'api_key', name: c.name, input: c.input })
        row = r.connection ?? r
        log('credential', c.name)
      } catch (e) { log('credential skipped', c.name, e.message.slice(0, 200)) }
    }
    if (row) out[c.key] = row
  }
  // Plain keys kept for tools and APIs.
  for (const c of [
    { name: 'Helpdesk API token', type: 'api_key', config: { apiKey: 'hd_demo_000000000000000000' } },
    // Not a Stripe key: a placeholder, assembled so no key-shaped literal sits in the source.
    { name: 'Stripe restricted key', type: 'api_key', config: { apiKey: ['rk', 'test', 'placeholder'].join('_') + '0'.repeat(16) } },
  ]) {
    if (have.find((h) => h.name === c.name)) continue
    try { await call('POST', '/credentials', c); log('credential', c.name) } catch (e) { log('credential skipped', c.name, e.message.slice(0, 200)) }
  }
  return out
}

async function agents(prov, api) {
  const have = list(await call('GET', '/agents?limit=100'), 'agents')
  const role = (key, name, purpose, p, model, extra = {}) => ({ key, name, purpose, kind: 'model', providerId: p.id, model, ...extra })
  const out = {}
  const research = {
    name: 'Market Research Analyst', mode: 'autonomous',
    description: 'Answers market and competitor questions; three models from three vendors argue it out.',
    instructions: 'Research the question, cite what you used, and give a short recommendation.',
    personality: 'Concise, neutral, numbers first.',
    models: { strategy: 'panel', roles: [
      role('main', 'Main', 'main', prov.openai, 'gpt-4.1'),
      role('panelist_1', 'Panelist 1', 'panelist', prov.openrouter, 'anthropic/claude-sonnet-4.5'),
      role('panelist_2', 'Panelist 2', 'panelist', prov.openrouter, 'google/gemini-2.5-pro'),
      role('judge', 'Judge', 'judge', prov.mistral, 'mistral-large-latest'),
    ] },
    memoryConfig: { enabled: true, whose: 'agent', save: 'facts', retentionDays: 180 },
  }
  const support = (researchId) => ({
    name: 'Customer Support Orchestrator', mode: 'autonomous',
    description: 'Answers Northwind customers on web chat and Slack: order status, shipping delays, refunds.',
    instructions: 'You are Northwind\'s support agent. Look orders up before answering, never promise a date the carrier has not given, and ask a person to approve any refund over $500.',
    personality: 'Warm, brief, specific. One apology at most.',
    models: { strategy: 'cascade', roles: [
      role('main', 'Main', 'main', prov.openai, 'gpt-4o'),
      role('drafter', 'Drafter', 'drafter', prov.mistral, 'mistral-small-latest'),
      role('checker', 'Checker', 'checker', prov.openrouter, 'anthropic/claude-sonnet-4.5', { instructions: 'Refute any claim about an order that the tool results do not support.' }),
    ] },
    memoryConfig: { enabled: true, whose: 'person', save: 'facts', retentionDays: 365, neverSave: 'Card numbers, passwords, home addresses' },
    agentConfig: {
      apiIds: [api.orders.id, api.helpdesk.id], canCallAgents: true, callableAgentIds: researchId ? [researchId] : [],
      verify: { enabled: true, policy: 'all_pass', maxReviseLoops: 2, triggers: ['on_final_output'], checkers: [
        { name: 'Accuracy', providerId: prov.openrouter.id, model: 'anthropic/claude-sonnet-4.5', instructions: 'Check every order fact against the tool results.' },
        { name: 'Policy', providerId: prov.openai.id, model: 'gpt-4o-mini', instructions: 'Refunds over $500 must go to approval.' },
      ] },
      constraints: { enabled: true, autoLearn: true },
    },
  })
  const ensure = async (key, body) => {
    let row = have.find((a) => a.name === body.name)
    if (!row) { row = await call('POST', '/agents', { ...body, visibility: 'org' }); log('agent', body.name) }
    if (row.status !== 'active') { try { await call('POST', `/agents/${row.id}/activate`) } catch (e) { log('activate failed', body.name, e.message.slice(0, 300)) } }
    out[key] = row
  }
  await ensure('research', research)
  await ensure('support', support(out.research.id))
  return out
}

async function workflow(prov, toolRows) {
  const have = list(await call('GET', '/agents?limit=100'), 'agents')
  const csat = toolRows.find((t) => /csat/.test(t.name))
  const name = 'Nightly CSAT Digest'
  let row = have.find((a) => a.name === name)
  if (!row) {
    row = await call('POST', '/agents', {
      name, mode: 'workflow', visibility: 'org',
      description: 'Every night: pull the CSAT numbers, write a digest, flag a drop.',
      pipeline: {
        nodes: [
          { id: 'input_1', type: 'input', label: 'Start', position: { x: 60, y: 220 }, config: {}, data: { schema: { type: 'object', properties: { days: { type: 'number' } } } } },
          { id: 'tool_csat', type: 'tool_call', label: 'CSAT summary', position: { x: 340, y: 220 }, config: {}, data: { toolId: csat?.id, parameters: { days: '{{input.days}}' } } },
          { id: 'llm_digest', type: 'llm_call', label: 'Write digest', position: { x: 620, y: 220 }, config: {}, data: { providerId: prov.openai.id, model: 'gpt-4o-mini', systemPrompt: 'You write a short daily support digest.', userPromptTemplate: 'CSAT data: {{nodes.tool_csat.output}}\nWrite the digest.' } },
          { id: 'verify_1', type: 'verify', label: 'Check the numbers', position: { x: 900, y: 220 }, config: {}, data: { checkers: [{ name: 'Numbers', providerId: prov.openrouter.id, model: 'anthropic/claude-sonnet-4.5' }], policy: 'all_pass' } },
          { id: 'output_1', type: 'output', label: 'Digest', position: { x: 1180, y: 220 }, config: {}, data: { mapping: '{{nodes.llm_digest.output}}' } },
        ],
        edges: [
          { id: 'e1', source: 'input_1', target: 'tool_csat' },
          { id: 'e2', source: 'tool_csat', target: 'llm_digest' },
          { id: 'e3', source: 'llm_digest', target: 'verify_1' },
          { id: 'e4', source: 'verify_1', target: 'output_1' },
        ],
      },
      webhookUrl: 'https://hooks.northwind.example/support/digest',
    })
    log('agent', name)
  }
  if (row.status !== 'active') { try { await call('POST', `/agents/${row.id}/activate`) } catch (e) { log('activate failed', name, e.message.slice(0, 300)) } }
  // A time of day in a time zone, the result to the agent's webhook: what the Schedule card shows.
  try { await call('POST', `/agents/${row.id}/schedule`, { kind: 'days', days: [1, 2, 3, 4, 5], time: '08:00', timezone: 'Europe/Berlin', input: { days: 1 }, deliverTo: { kind: 'webhook' } }) } catch (e) { log('schedule failed', e.message.slice(0, 200)) }
  return row
}

async function constraints(agentId) {
  const have = list(await call('GET', `/agents/${agentId}/constraints`), 'constraints')
  for (const rule of [
    'Never quote a delivery date the carrier has not confirmed.',
    'Refunds over $500 need a person to approve them first.',
    'Look the order up before answering anything about it.',
  ]) if (!have.some((c) => c.rule === rule)) await call('POST', `/agents/${agentId}/constraints`, { rule })
}

async function memories(orgId, agentId) {
  if (Number(sql(`SELECT count(*) FROM memories WHERE scope_id LIKE '${orgId}%'`)) >= 4) return
  const items = [
    { content: 'Brightway Logistics is an enterprise account: route their tickets to Tier 2.', tier: 'long', tags: ['accounts'] },
    { content: 'EU shipments through Leipzig are often held at customs for 1 to 3 days.', tier: 'long', tags: ['shipping'] },
    { content: 'Harbor & Pine Outfitters prefers email over chat for order updates.', tier: 'long', tags: ['customers'] },
    { content: 'Delayed-shipment policy: offer free expedited shipping on the next order.', tier: 'shared', tags: ['policy'] },
    { content: 'Refunds over $500 go to a support lead for approval before they are issued.', tier: 'shared', tags: ['policy', 'refunds'] },
    { content: 'Brightway Logistics has a dedicated account manager, Priya Nair; copy her on escalations.', tier: 'shared', tags: ['accounts'] },
    { content: 'The Leipzig hub is closed on German public holidays; add a day to EU estimates around them.', tier: 'shared', tags: ['shipping'] },
  ]
  for (const m of items) {
    try { await call('POST', '/memory/canonical', { mode: 'memory', scope: m.tier === 'shared' ? { scope_type: 'workspace', scope_id: orgId } : { scope_type: 'agent', scope_id: `${orgId}:agent:${agentId}` }, content: m.content, content_format: 'text', tier: m.tier, tags: m.tags }) }
    catch (e) { log('memory skipped', e.message.slice(0, 200)); break }
  }
  log('memories')
}


async function channels(agentId, cred) {
  await call('PATCH', `/agents/${agentId}/public-settings`, {
    branding: { appName: 'Northwind Help', primaryColor: '#7C3AED', theme: 'auto', greeting: 'Hi! I can check orders, shipping and refunds.', suggestedPrompts: ['Where is my order?', 'I need a refund', 'Change my delivery address'] },
    visitorRules: { authMode: 'public_link', limits: { costCapCents: 50, perUserRateLimit: 20, perIpRateLimit: 60, dailySpendCapCents: 500, monthlySpendCapCents: 5000 }, privacy: { retentionDays: 30, visitorCanDelete: true, visitorCanExport: true } },
  })
  const have = list(await call('GET', `/agents/${agentId}/channels`), 'channels')
  const want = [
    { type: 'web', name: 'Help center chat', slug: 'northwind-help', publish: true },
    { type: 'widget', name: 'Website widget', publish: true, configuration: { allowedOrigins: ['https://northwind.example'] } },
    { type: 'slack', name: 'Slack', credentialId: cred['channel-slack-app']?.id, publish: true },
    { type: 'a2a', name: 'Other agents (A2A)', publish: true },
    { type: 'microsoft_teams', name: 'Microsoft Teams', publish: false },
    { type: 'tui', name: 'Terminal app', publish: false },
  ]
  const out = {}
  for (const c of want) {
    let row = have.find((h) => h.type === c.type)
    if (!row) {
      try {
        row = await call('POST', `/agents/${agentId}/channels`, { type: c.type, name: c.name, slug: c.slug, configuration: c.configuration, credentialId: c.credentialId })
        log('channel', c.name)
      } catch (e) { log('channel skipped', c.name, e.message.slice(0, 300)); continue }
    }
    if (c.publish && row.status !== 'published' && !row.publishedAt) {
      try { row = await call('POST', `/agents/${agentId}/channels/${row.id}/publish`, {}); log('published', c.name) } catch (e) { log('publish failed', c.name, e.message.slice(0, 300)) }
    }
    out[c.type] = row
  }
  return out
}
async function runs(agentId, questions) {
  const started = []
  for (const q of questions) {
    try { started.push(await call('POST', `/agents/${agentId}/runs`, { input: { message: q } })) } catch (e) { log('run failed', e.message.slice(0, 200)) }
    await sleep(1500)
  }
  return started
}

// Traffic through a new MCP gateway, so its metrics and Analytics have something to show.
async function mcpTraffic(orgSlug, endpoint, key) {
  const url = `${API}/${orgSlug}${endpoint}`
  let session, id = 0
  const rpc = async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'x-api-key': key, accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
    session = res.headers.get('mcp-session-id') ?? session
    return res.status
  }
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.0' } })
    await rpc('tools/list', {})
    for (const order of ['NW-10428', 'NW-38801', 'NW-44120']) await rpc('tools/call', { name: 'northwind_orders_get_order', arguments: { orderId: order } })
    await rpc('tools/call', { name: 'northwind_orders_track_shipment', arguments: { orderId: 'NW-10428' } })
    await rpc('tools/call', { name: 'northwind_helpdesk_get_csat_summary', arguments: { days: 7 } })
    log('mcp traffic', endpoint)
  } catch (e) { log('mcp traffic failed', e.message) }
}

async function approvalPolicy() {
  const have = list(await call('GET', '/approval-policies').catch(() => []), 'policies')
  if (have.some((p) => p.name === 'Refunds over $500')) return
  try {
    await call('POST', '/approval-policies', {
      name: 'Refunds over $500', description: 'A support lead signs off on large refunds before the agent issues them.',
      match: [{ attr: 'payload.amount', op: 'gt', value: 500 }],
      steps: [{ name: 'Support lead', approverRole: 'admin', minApprovals: 1 }], priority: 10, enabled: true,
    })
    log('approval policy')
  } catch (e) { log('approval policy skipped', e.message.slice(0, 200)) }
}

// The free amount rule: a refund call over 500 waits for a person, whatever the agent was told.
async function amountRule(toolRows) {
  const refund = toolRows.find((t) => t.name === 'northwind_orders_create_refund')
  if (!refund) return
  const have = list(await call('GET', '/approval-rules').catch(() => []), 'rules')
  if (have.some((r) => r.name === 'Refunds over 500')) return
  try {
    await call('POST', '/approval-rules', { name: 'Refunds over 500', enabled: true, trigger: { kind: 'tool_amount', toolId: refund.id, argument: 'amount', op: 'gt', amount: 500 } })
    log('amount rule')
  } catch (e) { log('amount rule skipped', e.message.slice(0, 200)) }
}

async function runner() {
  const have = list(await call('GET', '/runners'), 'runners')
  if (!have.some((r) => r.name === 'ci-mac-studio')) {
    await call('POST', '/runners', { name: 'ci-mac-studio', labels: { os: 'mac', arch: 'arm64', gpu: 'yes' }, visibility: 'org' })
    log('runner')
  }
}

async function waitForRuns(agentId) {
  for (let i = 0; i < 40; i++) {
    const rows = list(await call('GET', `/agents/${agentId}/runs`), 'runs')
    if (rows.length && rows.every((r) => !['pending', 'running', 'queued'].includes(r.status))) return rows
    await sleep(1500)
  }
  return list(await call('GET', `/agents/${agentId}/runs`), 'runs')
}

async function promote(agentId) {
  const have = list(await call('GET', '/promoted-skills').catch(() => []), 'skills')
  if (have.length) return
  const done = (await waitForRuns(agentId)).find((r) => r.status === 'completed' && /NW-10428/.test(JSON.stringify(r.input)))
  if (!done) return
  try { await call('POST', '/promoted-skills', { runId: done.id, name: 'check-delayed-order', description: 'Look a delayed order up, track the shipment and draft the apology with the delayed-shipment offer.' }); log('promoted skill') }
  catch (e) { log('promote skipped', e.message.slice(0, 200)) }
}

async function digestHistory(digestId) {
  const agent = await call('GET', `/agents/${digestId}`)
  if (sql(`SELECT count(*) FROM agent_executions WHERE "agentId" = '${digestId}'`) === '0') {
    try { await call('POST', `/agents/${digestId}/invoke`, { input: { days: 1 } }); log('digest run') } catch (e) { log('digest run failed', e.message.slice(0, 200)) }
  }
  // Two pipeline saves, so Pipeline versions has snapshots to roll back to.
  const versions = await call('GET', `/agents/${digestId}/versions`).catch(() => [])
  if (list(versions, 'versions').length < 2) {
    const p = agent.pipeline
    for (const prompt of ['You write a short daily support digest for the support leads.', 'You write a short daily support digest for the support leads. Lead with anything that got worse.']) {
      p.nodes = p.nodes.map((n) => (n.id === 'llm_digest' ? { ...n, data: { ...n.data, systemPrompt: prompt } } : n))
      await call('PATCH', `/agents/${digestId}`, { pipeline: p }).catch((e) => log('pipeline save failed', e.message.slice(0, 200)))
    }
    log('pipeline versions')
  }
}
export async function main() {
  const orgId = await signIn()
  log('org', orgId)
  const org = await call('GET', `/organizations/${orgId}`)
  const prov = await providers()
  const api = await apis()
  await petstore()
  const toolRows = await tools(orgId)
  const gw = await gateways(orgId, toolRows)
  const cred = await credentials()
  const ag = await agents(prov, api)
  const digest = await workflow(prov, toolRows)
  await constraints(ag.support.id)
  await memories(orgId, ag.support.id)
  await channels(ag.support.id, cred)
  await approvalPolicy()
  await amountRule(toolRows)
  await runner()
  if (process.env.SEED_RUNS !== '0') {
    if (gw['support-tools']?.initialApiKey) await mcpTraffic(org.slug, '/support-tools', gw['support-tools'].initialApiKey)
    if (!list(await call('GET', `/agents/${ag.support.id}/runs`), 'runs').length) {
      await runs(ag.support.id, [
        'Where is order NW-10428? The customer says it is late.',
        'Triage ticket T-5521 and draft a reply.',
        'Brightway Logistics wants a refund of $820 on NW-44120, it arrived defective.',
      ])
      await runs(ag.research.id, ['How do our CSAT scores compare with last quarter?'])
    }
    await promote(ag.support.id)
    await digestHistory(digest.id)
  }
  return { orgId, slug: org.slug, agents: { ...Object.fromEntries(Object.entries(ag).map(([k, v]) => [k, v.id])), digest: digest.id } }
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((r) => console.log(JSON.stringify(r, null, 1))).catch((e) => { console.error(e); process.exit(1) })
