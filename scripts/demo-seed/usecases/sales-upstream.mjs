// A local stand-in for Intercom, HubSpot, Google Drive and Slack, plus a
// scripted OpenAI-compatible model (sales-model.mjs), for the support and
// sales example guides in docs-site/content/examples. Paths match the real
// public APIs; only the host differs. Nothing here talks to the internet.
//
// The company is Parcelwise (made up): shipping software for online shops.
//
//   node sales-upstream.mjs        listens on USECASE_PORT (default 4292)
//   GET  /_admin/state             everything written or posted so far
//   POST /_admin/reset             forget the lead scores, so the leads are new again
//
// stack.sh starts usecases/upstream.mjs only when nothing answers on
// USECASE_PORT, so starting this one first on that port makes the API's
// Slack and Resend traffic (redirect-fetch.mjs) land here instead.
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.USECASE_PORT || 4292)
const LOG = process.env.USECASE_LOG || '/tmp/almyty-demo/sales-requests.log'
const DAY = 86400000
const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString()

// ---------------- Intercom: help center + tickets ----------------
const HC = 'https://help.parcelwise.example/en/articles'
const articles = [
  {
    id: '9100231', title: 'Create return labels in bulk',
    description: 'Make return labels for up to 250 orders at once and email them to your customers.',
    body: '<p>You can create return labels for many orders at once from <b>Orders</b>.</p><ol><li>Open <b>Orders</b> and tick the orders (up to 250 at a time).</li><li>Click <b>Actions</b>, then <b>Create return labels</b>.</li><li>Pick the carrier. Bulk return labels work with DHL Parcel, DPD, UPS and PostNL.</li><li>Choose <b>Email the label to the customer</b> or <b>Download as one PDF</b>.</li></ol><p>Bulk return labels are part of the Growth and Business plans. On the Starter plan you create return labels one order at a time.</p>',
  },
  {
    id: '9100187', title: 'Which carriers does Parcelwise support?',
    description: 'Every carrier you can ship with, and which ones support returns.',
    body: '<p>Parcelwise ships with DHL Parcel, DHL Express, DPD, UPS, PostNL, GLS and Royal Mail. Return labels are available for DHL Parcel, DPD, UPS and PostNL.</p>',
  },
  {
    id: '9100142', title: 'Connect your Shopify store',
    description: 'Import your Shopify orders into Parcelwise automatically.',
    body: '<p>Open <b>Settings</b>, <b>Shops</b>, click <b>Add shop</b> and pick <b>Shopify</b>. Sign in to Shopify and approve the Parcelwise app. New orders appear in Parcelwise within five minutes.</p>',
  },
  {
    id: '9100305', title: 'Set up shipping rules',
    description: 'Pick the carrier and the service for each order automatically.',
    body: '<p>Shipping rules choose a carrier and service for each new order, for example "orders over 2 kg to Germany go with DHL Parcel". Open <b>Settings</b>, <b>Shipping rules</b> and click <b>New rule</b>.</p>',
  },
].map((a) => ({ type: 'article', workspace_id: 'pw1x2y3z', parent_id: 51, parent_type: 'collection', author_id: 991, state: 'published', created_at: 1757000000, updated_at: 1760000000, url: `${HC}/${a.id}-${a.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`, ...a }))
const ticketTypes = [
  { type: 'ticket_type', id: '7', name: 'Customer question', category: 'Customer', archived: false },
  { type: 'ticket_type', id: '12', name: 'Docs gap', description: 'A question the help center does not answer yet', category: 'Back-office', archived: false },
]
const tickets = []

// ---------------- HubSpot ----------------
let seq = 7000
const owners = [
  { id: '81234501', email: 'daniel.kim@parcelwise.example', firstName: 'Daniel', lastName: 'Kim', type: 'PERSON', archived: false, teams: [{ id: '31', name: 'Sales EMEA', primary: true }] },
  { id: '81234502', email: 'hannah.okoro@parcelwise.example', firstName: 'Hannah', lastName: 'Okoro', type: 'PERSON', archived: false, teams: [{ id: '32', name: 'Sales Americas', primary: true }] },
  { id: '81234500', email: 'sofia.marques@parcelwise.example', firstName: 'Sofia', lastName: 'Marques', type: 'PERSON', archived: false, teams: [{ id: '30', name: 'Sales leadership', primary: true }] },
]
const companies = [
  { id: '3101', properties: { name: 'Kaffeewerk', domain: 'kaffeewerk.example', industry: 'RETAIL', numberofemployees: '85', country: 'Germany', city: 'Hamburg', description: 'Online shop for specialty coffee and brewing gear; ships about 1,200 orders a week.' } },
  { id: '3102', properties: { name: 'Trailhead Supply Co.', domain: 'trailhead-supply.example', industry: 'SPORTING_GOODS', numberofemployees: '42', country: 'United States', city: 'Denver', description: 'Outdoor gear webshop on Shopify; ships across the US and Canada.' } },
  { id: '3103', properties: { name: 'Brightside Dental', domain: 'brightside-dental.example', industry: 'HOSPITAL_HEALTH_CARE', numberofemployees: '12', country: 'United Kingdom', city: 'Leeds', description: 'Dental practice with two clinics.' } },
]
const contacts = [
  { id: '5201', properties: { firstname: 'Lena', lastname: 'Fischer', email: 'lena.fischer@kaffeewerk.example', jobtitle: 'Head of E-commerce', company: 'Kaffeewerk', associatedcompanyid: '3101', lifecyclestage: 'lead', hs_lead_status: 'NEW', message: 'We ship 1,200 orders a week and do return labels by hand. Do you integrate with Shopify and DHL?', createdate: iso(-35 * 60000) } },
  { id: '5202', properties: { firstname: 'Marcus', lastname: 'Reed', email: 'marcus@trailhead-supply.example', jobtitle: 'Founder', company: 'Trailhead Supply Co.', associatedcompanyid: '3102', lifecyclestage: 'lead', hs_lead_status: 'NEW', message: 'Looking to replace our current label tool before Black Friday.', createdate: iso(-22 * 60000) } },
  { id: '5203', properties: { firstname: 'Amira', lastname: 'Haddad', email: 'amira@brightside-dental.example', jobtitle: 'Practice Manager', company: 'Brightside Dental', associatedcompanyid: '3103', lifecyclestage: 'lead', hs_lead_status: 'NEW', message: 'Do you do appointment reminders?', createdate: iso(-9 * 60000) } },
  { id: '5101', properties: { firstname: 'Priya', lastname: 'Raman', email: 'priya@kestrelcoffee.example', jobtitle: 'Operations Director', company: 'Kestrel Coffee Co.', lifecyclestage: 'customer', fit_score: '81', createdate: iso(-90 * DAY) } },
]
const deals = [
  { id: '9301', properties: { dealname: 'Kaffeewerk - Business plan', dealstage: 'appointmentscheduled', pipeline: 'default', amount: '9600', closedate: iso(60 * DAY).slice(0, 10), hubspot_owner_id: '81234501', hs_next_step: 'Discovery call' } },
  { id: '9302', properties: { dealname: 'Trailhead Supply Co. - Growth plan', dealstage: 'qualifiedtobuy', pipeline: 'default', amount: '4200', closedate: iso(30 * DAY).slice(0, 10), hubspot_owner_id: '81234502' } },
]
const notes = []
const tasks = []
const crm = { contacts, companies, deals, notes, tasks, '0-1': contacts, '0-2': companies, '0-3': deals }
const wrap = (o) => ({ id: o.id, properties: { hs_object_id: o.id, ...o.properties }, createdAt: o.properties.createdate || iso(-30 * DAY), updatedAt: o.updatedAt || iso(-DAY), archived: false, ...(o.associations ? { associations: o.associations } : {}) })
function matches(obj, body) {
  const props = obj.properties
  const q = String(body?.query || '').toLowerCase()
  if (q && !Object.values(props).some((v) => String(v).toLowerCase().includes(q))) return false
  const groups = body?.filterGroups || []
  if (!groups.length) return true
  return groups.some((g) => (g.filters || []).every((f) => {
    const v = props[f.propertyName]
    switch (f.operator) {
      case 'EQ': return String(v ?? '').toLowerCase() === String(f.value ?? '').toLowerCase()
      case 'NEQ': return String(v ?? '').toLowerCase() !== String(f.value ?? '').toLowerCase()
      case 'GT': case 'GTE': case 'LT': case 'LTE': {
        const a = /date/.test(f.propertyName) ? Date.parse(v) : Number(v)
        const b = /date/.test(f.propertyName) ? (isNaN(Number(f.value)) ? Date.parse(f.value) : Number(f.value)) : Number(f.value)
        return { GT: a > b, GTE: a >= b, LT: a < b, LTE: a <= b }[f.operator]
      }
      case 'CONTAINS_TOKEN': return String(v ?? '').toLowerCase().includes(String(f.value ?? '').replace(/\*/g, '').toLowerCase())
      case 'HAS_PROPERTY': return v != null && v !== ''
      case 'NOT_HAS_PROPERTY': return v == null || v === ''
      default: return true
    }
  }))
}

// ---------------- Google Drive ----------------
const DRIVE = 'https://docs.google.com/document/d'
const files = [
  { id: '1PwPricing2026aB3dE', name: 'Pricing and discounts 2026', mimeType: 'application/vnd.google-apps.document', modifiedTime: iso(-6 * DAY), owners: [{ displayName: 'Sofia Marques' }], parents: ['0SalesShared'],
    text: 'Pricing and discounts 2026\n\nPlans: Starter 49 EUR a month (1 user), Growth 199 EUR a month (up to 5 users), Business 799 EUR a month (up to 25 users).\n\nAnnual plans: 15% off the monthly price, paid up front.\n\nDiscounts: account executives may give up to 10% extra on annual Growth or Business plans with 10 or more seats. Anything above 10% needs approval from Sofia Marques (Head of Sales). Never discount the Starter plan.\n\nNon-profits: 30% off any plan, with proof of status.' },
  { id: '1PwSecurityOv9xY', name: 'Security overview for customers', mimeType: 'application/vnd.google-apps.document', modifiedTime: iso(-40 * DAY), owners: [{ displayName: 'Oskar Lind' }], parents: ['0SalesShared'],
    text: 'Security overview\n\nData is stored in Frankfurt (EU). Encrypted at rest (AES-256) and in transit (TLS 1.2+). SOC 2 Type II report available under NDA. Single sign-on with Google and Microsoft on the Business plan.' },
  { id: '1PwKaffeewerkProp', name: 'Kaffeewerk - proposal draft', mimeType: 'application/vnd.google-apps.document', modifiedTime: iso(-2 * DAY), owners: [{ displayName: 'Daniel Kim' }], parents: ['0SalesShared'],
    text: 'Proposal for Kaffeewerk\n\nBusiness plan, annual, 8 seats. Includes bulk DHL return labels and the Shopify connection. Proposed discount: 10%.' },
  { id: '1PwOnboardChecklist', name: 'Customer onboarding checklist', mimeType: 'application/vnd.google-apps.document', modifiedTime: iso(-12 * DAY), owners: [{ displayName: 'Oskar Lind' }], parents: ['0SalesShared'],
    text: 'Onboarding checklist\n\n1. Connect the shop. 2. Add carrier accounts. 3. Set up two shipping rules. 4. Print a test label. 5. Train the warehouse team (30 minutes).' },
].map((f) => ({ kind: 'drive#file', webViewLink: `${DRIVE}/${f.id}/edit`, ...f }))
function driveQuery(q) {
  let list = files.slice()
  const full = [...String(q || '').matchAll(/fullText contains '([^']+)'/g)].map((m) => m[1].toLowerCase())
  const names = [...String(q || '').matchAll(/name contains '([^']+)'/g)].map((m) => m[1].toLowerCase())
  for (const w of full) list = list.filter((f) => (f.name + ' ' + f.text).toLowerCase().includes(w))
  for (const w of names) list = list.filter((f) => f.name.toLowerCase().includes(w))
  const parent = String(q || '').match(/'([^']+)' in parents/)
  if (parent) list = list.filter((f) => f.parents.includes(parent[1]))
  return list.sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime))
}
const driveMeta = ({ text, ...f }) => f

// ---------------- Slack (redirected by redirect-fetch.mjs) ----------------
const outbox = []
const SLACK_USERS = { U0TOM: { real_name: 'Tom Becker', email: 'tom.becker@parcelwise.example' }, U0SOFIA: { real_name: 'Sofia Marques', email: 'sofia.marques@parcelwise.example' } }

// ---------------- helpers ----------------
const send = (res, status, body, headers = {}) => {
  const str = typeof body === 'string'
  res.writeHead(status, { 'content-type': str ? 'text/plain; charset=utf-8' : 'application/json', ...headers })
  res.end(str ? body : JSON.stringify(body))
}
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { r(s ? JSON.parse(s) : {}) } catch { r(Object.fromEntries(new URLSearchParams(s))) } }) })

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  const p = decodeURIComponent(u.pathname)
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined
  try { appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${u.pathname}${u.search} ${body ? JSON.stringify(body).slice(0, 400) : ''}\n`) } catch {}
  let m
  try {
    if (p === '/health') return send(res, 200, { ok: true })
    // ---- the scripted model
    if (p === '/openai/v1/models') return send(res, 200, { object: 'list', data: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'].map((id) => ({ id, object: 'model', created: 1715367049, owned_by: 'openai' })) })
    if (p === '/openai/v1/chat/completions' && req.method === 'POST') {
      const { decide } = await import(`./sales-model.mjs?t=${Date.now()}`)
      const d = await decide(body)
      const model = body.model || 'gpt-4o'
      const promptTokens = Math.round(JSON.stringify(body.messages || []).length / 4) + 200
      const completionTokens = Math.round(((d.content || '') + JSON.stringify(d.toolCalls || '')).length / 4) + 5
      const usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens }
      const toolCalls = d.toolCalls?.length ? d.toolCalls.map((c, i) => ({ id: c.id || `call_x_${Date.now() % 1e6}${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) : undefined
      const message = { role: 'assistant', content: d.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
      const finish = toolCalls ? 'tool_calls' : 'stop'
      if (!body.stream) return send(res, 200, { id: 'chatcmpl-local', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, message, finish_reason: finish }], usage })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const chunk = (delta, finish_reason, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
      if (toolCalls) chunk({ role: 'assistant', tool_calls: toolCalls.map((c, index) => ({ index, ...c })) }, null)
      else for (const piece of d.content.match(/[\s\S]{1,60}/g) || [d.content]) chunk({ content: piece }, null)
      chunk({}, finish)
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`)
      return res.end('data: [DONE]\n\n')
    }
    // ---- outbound Slack and Resend traffic, redirected here (never sent for real)
    if (p.startsWith('/_ext/')) {
      outbox.push({ at: new Date().toISOString(), url: p.slice(5) + u.search, body })
      if (p.startsWith('/_ext/api.resend.com')) return send(res, 200, { id: 'local-email-' + outbox.length })
      if (p.includes('/users.info')) { const id = u.searchParams.get('user') || body?.user || 'U0TOM'; const x = SLACK_USERS[id] || SLACK_USERS.U0TOM; return send(res, 200, { ok: true, user: { id, name: x.real_name.split(' ')[0].toLowerCase(), real_name: x.real_name, profile: { email: x.email, real_name: x.real_name, display_name: x.real_name.split(' ')[0] } } }) }
      if (p.includes('/conversations.list')) return send(res, 200, { ok: true, channels: [{ id: 'C0ASKPRODUCT', name: 'ask-product' }, { id: 'C0SALESLEADS', name: 'sales-leads' }, { id: 'C0GENERAL', name: 'general' }] })
      if (p.includes('/auth.test')) return send(res, 200, { ok: true, team: 'Parcelwise', team_id: 'T0PARCEL', user_id: 'U0BOT', bot_id: 'B0BOT' })
      return send(res, 200, { ok: true, ts: String(Date.now() / 1000), channel: body?.channel || 'C0GENERAL' })
    }
    if (p === '/_admin/state') return send(res, 200, { outbox, tickets, contacts, deals, notes, tasks })
    if (p === '/_admin/reset' && req.method === 'POST') {
      for (const c of contacts.filter((x) => x.properties.lifecyclestage === 'lead')) { for (const k of ['fit_score', 'fit_reason', 'hubspot_owner_id']) delete c.properties[k]; c.properties.hs_lead_status = 'NEW' }
      return send(res, 200, { reset: true })
    }

    // ---- Intercom (base https://api.intercom.io)
    if (p === '/intercom/articles/search') {
      const words = String(u.searchParams.get('phrase') || '').toLowerCase().split(/\s+/).filter((w) => w.length > 2 && !/^(the|and|can|for|you|our|does|with|how|what|there|any)$/.test(w))
      const scored = articles.map((a) => ({ a, n: words.filter((w) => (a.title + ' ' + a.description + ' ' + a.body).toLowerCase().includes(w.replace(/s$/, ''))).length }))
        .filter((x) => x.n >= Math.max(2, Math.ceil(words.length * 0.5))).sort((x, y) => y.n - x.n).map((x) => x.a)
      return send(res, 200, { type: 'list', total_count: scored.length, data: { articles: scored, highlights: [] }, pages: { type: 'pages', page: 1, per_page: 10, total_pages: 1 } })
    }
    if ((m = p.match(/^\/intercom\/articles\/(\d+)$/))) { const a = articles.find((x) => x.id === m[1]); return a ? send(res, 200, a) : send(res, 404, { type: 'error.list', errors: [{ code: 'not_found', message: 'Resource Not Found' }] }) }
    if (p === '/intercom/ticket_types') return send(res, 200, { type: 'list', data: ticketTypes })
    if (p === '/intercom/tickets' && req.method === 'POST') {
      const t = { type: 'ticket', id: String(++seq), ticket_id: String(380 + tickets.length + 1), category: 'Back-office', ticket_attributes: body.ticket_attributes || {}, ticket_state: 'submitted', ticket_type: ticketTypes.find((x) => x.id === String(body.ticket_type_id)) || ticketTypes[1], contacts: { type: 'contact.list', contacts: body.contacts || [] }, created_at: Math.floor(Date.now() / 1000), open: true }
      tickets.push(t)
      return send(res, 200, t)
    }

    // ---- HubSpot (base https://api.hubapi.com)
    if (p === '/hubspot/crm/v3/owners' || p === '/hubspot/crm/v3/owners/') return send(res, 200, { results: owners })
    if ((m = p.match(/^\/hubspot\/crm\/v3\/objects\/([a-z0-9-]+)\/search$/)) && req.method === 'POST') {
      const src = crm[m[1]] || []
      const results = src.filter((o) => matches(o, body)).slice(0, body.limit || 10).map(wrap)
      return send(res, 200, { total: results.length, results })
    }
    if ((m = p.match(/^\/hubspot\/crm\/v3\/objects\/([a-z0-9-]+)$/))) {
      const src = crm[m[1]]
      if (!src) return send(res, 404, { status: 'error', message: 'Unknown object type' })
      if (req.method === 'POST') { const o = { id: String(++seq), properties: { ...(body.properties || {}), createdate: new Date().toISOString() }, associations: body.associations }; src.push(o); return send(res, 201, wrap(o)) }
      return send(res, 200, { results: src.slice(0, Number(u.searchParams.get('limit') || 10)).map(wrap) })
    }
    if ((m = p.match(/^\/hubspot\/crm\/v3\/objects\/([a-z0-9-]+)\/([^/]+)$/))) {
      const o = (crm[m[1]] || []).find((x) => x.id === m[2])
      if (!o) return send(res, 404, { status: 'error', message: 'resource not found', category: 'OBJECT_NOT_FOUND' })
      if (req.method === 'PATCH') { Object.assign(o.properties, body.properties || {}); o.updatedAt = new Date().toISOString() }
      return send(res, 200, wrap(o))
    }

    // ---- Google Drive (base https://www.googleapis.com/drive/v3)
    if (p === '/drive/v3/files' && req.method === 'GET') return send(res, 200, { kind: 'drive#fileList', incompleteSearch: false, files: driveQuery(u.searchParams.get('q')).map(driveMeta) })
    if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)\/export$/))) { const f = files.find((x) => x.id === m[1]); return f ? send(res, 200, f.text) : send(res, 404, { error: { code: 404, message: `File not found: ${m[1]}.` } }) }
    if ((m = p.match(/^\/drive\/v3\/files\/([^/]+)$/))) {
      const f = files.find((x) => x.id === m[1])
      if (!f) return send(res, 404, { error: { code: 404, message: `File not found: ${m[1]}.` } })
      return u.searchParams.get('alt') === 'media' ? send(res, 200, f.text) : send(res, 200, driveMeta(f))
    }
    return send(res, 404, { error: 'not found in the local stand-in', path: p })
  } catch (e) {
    return send(res, 500, { error: String(e) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`sales stand-in on http://localhost:${PORT}`))
http.createServer((req, res) => server.emit('request', req, res)).listen(PORT, '::1')
