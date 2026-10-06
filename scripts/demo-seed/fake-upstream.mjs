#!/usr/bin/env node
// The outside world of the demo organization, on one local port: three
// OpenAI-compatible model vendors (each under its own prefix, so each
// connects as its own provider), the company APIs with their OpenAPI
// descriptions (orders and helpdesk for the seed; a CRM, health checks, a
// help center, an intranet and a Slack incoming webhook for the use-case
// guides), and nothing else. Nothing here reaches the internet and no key is
// checked. Answers are scripted and deterministic: offered tools and not
// yet given a result, a model calls the tool that fits the question; given
// the result, it answers in a sentence or two.
import { createServer } from 'node:http'

const PORT = Number(process.env.FAKE_PORT || 4290)
const ORIGIN = `http://localhost:${PORT}`

// Real model ids, so the price table and the model cards read like a real org.
const MODELS = {
  openai: [
    { id: 'gpt-4o', created: 1715367049 },
    { id: 'gpt-4o-mini', created: 1721172741 },
    { id: 'gpt-4.1', created: 1744316542 },
    { id: 'o4-mini', created: 1744225308 },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-4.5', created: 1759104000 },
    { id: 'google/gemini-2.5-pro', created: 1750118400 },
    { id: 'meta-llama/llama-3.3-70b-instruct', created: 1733443200 },
  ],
  mistral: [
    { id: 'mistral-large-latest', created: 1731974400 },
    { id: 'mistral-small-latest', created: 1742169600 },
  ],
}

// ---------- the company APIs ----------

const ORDERS = {
  'NW-10428': { id: 'NW-10428', customer: 'Harbor & Pine Outfitters', status: 'delayed', carrier: 'DHL Express', eta: '2026-10-02', total: 312.4, items: 3 },
  'NW-44120': { id: 'NW-44120', customer: 'Brightway Logistics', status: 'delivered', carrier: 'UPS', eta: '2026-09-21', total: 820, items: 1, note: 'Reported defective on arrival' },
  'NW-38801': { id: 'NW-38801', customer: 'Kestrel Coffee Co.', status: 'shipped', carrier: 'FedEx', eta: '2026-09-30', total: 1290.5, items: 12 },
}

function ordersOpenApi() {
  const order = {
    type: 'object',
    properties: {
      id: { type: 'string' }, customer: { type: 'string' }, status: { type: 'string', enum: ['pending', 'shipped', 'delayed', 'delivered', 'cancelled'] },
      carrier: { type: 'string' }, eta: { type: 'string', format: 'date' }, total: { type: 'number' }, items: { type: 'integer' },
    },
  }
  const idParam = { name: 'orderId', in: 'path', required: true, schema: { type: 'string', example: 'NW-10428' }, description: 'Order number, e.g. NW-10428' }
  return {
    openapi: '3.0.3',
    info: { title: 'Northwind Orders', version: '2.3.0', description: 'Order lookup, shipment tracking and refunds for Northwind customers.' },
    servers: [{ url: `${ORIGIN}/orders/v2` }],
    paths: {
      '/orders': {
        get: {
          operationId: 'listOrders', summary: 'List recent orders', tags: ['Orders'],
          parameters: [
            { name: 'customer', in: 'query', schema: { type: 'string' }, description: 'Filter by customer name' },
            { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Filter by status' },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 }, description: 'Page size' },
          ],
          responses: { 200: { description: 'Orders', content: { 'application/json': { schema: { type: 'array', items: order } } } } },
        },
      },
      '/orders/{orderId}': {
        get: {
          operationId: 'getOrder', summary: 'Get an order by number', tags: ['Orders'], parameters: [idParam],
          responses: { 200: { description: 'The order', content: { 'application/json': { schema: order } } }, 404: { description: 'No such order' } },
        },
      },
      '/orders/{orderId}/shipment': {
        get: {
          operationId: 'trackShipment', summary: 'Track the shipment for an order', tags: ['Shipping'], parameters: [idParam],
          responses: { 200: { description: 'Tracking events', content: { 'application/json': { schema: { type: 'object' } } } } },
        },
      },
      '/orders/{orderId}/refunds': {
        post: {
          operationId: 'createRefund', summary: 'Issue a refund for an order', tags: ['Refunds'], parameters: [idParam],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['amount', 'reason'], properties: { amount: { type: 'number' }, reason: { type: 'string' } } } } } },
          responses: { 201: { description: 'Refund created' } },
        },
      },
      '/customers/{customerId}': {
        get: {
          operationId: 'getCustomer', summary: 'Get a customer account', tags: ['Customers'],
          parameters: [{ name: 'customerId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'The customer' } },
        },
      },
    },
  }
}

function helpdeskOpenApi() {
  return {
    openapi: '3.0.3',
    info: { title: 'Northwind Helpdesk', version: '1.8.0', description: 'Support tickets, macros and customer satisfaction for the Northwind support team.' },
    servers: [{ url: `${ORIGIN}/helpdesk/api` }],
    paths: {
      '/tickets': {
        get: { operationId: 'searchTickets', summary: 'Search support tickets', tags: ['Tickets'], parameters: [
          { name: 'query', in: 'query', schema: { type: 'string' }, description: 'Free-text search' },
          { name: 'priority', in: 'query', schema: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] } },
        ], responses: { 200: { description: 'Tickets' } } },
        post: { operationId: 'createTicket', summary: 'Open a ticket', tags: ['Tickets'], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string' }, body: { type: 'string' }, priority: { type: 'string' } } } } } }, responses: { 201: { description: 'Created' } } },
      },
      '/tickets/{ticketId}': {
        get: { operationId: 'getTicket', summary: 'Get a ticket', tags: ['Tickets'], parameters: [{ name: 'ticketId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'The ticket' } } },
        patch: { operationId: 'updateTicket', summary: 'Update status, priority or assignee', tags: ['Tickets'], parameters: [{ name: 'ticketId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string' }, priority: { type: 'string' }, assignee: { type: 'string' } } } } } }, responses: { 200: { description: 'Updated' } } },
      },
      '/tickets/{ticketId}/replies': {
        post: { operationId: 'replyToTicket', summary: 'Post a reply to the customer', tags: ['Tickets'], parameters: [{ name: 'ticketId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['body'], properties: { body: { type: 'string' }, internal: { type: 'boolean' } } } } } }, responses: { 201: { description: 'Posted' } } },
      },
      '/macros': {
        get: { operationId: 'listMacros', summary: 'List saved reply macros', tags: ['Macros'], responses: { 200: { description: 'Macros' } } },
      },
      '/csat': {
        get: { operationId: 'getCsatSummary', summary: 'Customer satisfaction for a period', tags: ['Reporting'], parameters: [{ name: 'days', in: 'query', schema: { type: 'integer', default: 7 } }], responses: { 200: { description: 'CSAT' } } },
      },
    },
  }
}

// ---------- the systems the use-case guides connect ----------
// A CRM (sales), health checks of the company's own systems (operations),
// the public help center (marketing) and the staff intranet (internal help
// desk). Each is described in OpenAPI like the two above, and the guides
// connect them from the UI with Connect an API.

const op = (operationId, summary, tag, extra = {}) => ({ operationId, summary, tags: [tag], responses: { 200: { description: summary } }, ...extra })
const pathParam = (name, example, description) => ({ name, in: 'path', required: true, schema: { type: 'string', example }, description })
const queryParam = (name, description) => ({ name, in: 'query', required: true, schema: { type: 'string' }, description })
const jsonBody = (required, properties) => ({ required: true, content: { 'application/json': { schema: { type: 'object', required, properties } } } })

function guideOpenApi(key) {
  const specs = {
    crm: {
      info: { title: 'Northwind CRM', version: '4.1.0', description: 'Customer accounts, contacts, deals and meeting notes for the Northwind sales team.' },
      servers: [{ url: `${ORIGIN}/crm/api` }],
      paths: {
        '/accounts': { get: op('findAccounts', 'Find customer accounts by name', 'Accounts', { parameters: [queryParam('name', 'Part of the company name, e.g. Kestrel')] }) },
        '/accounts/{accountId}': { get: op('getAccount', 'Get an account with its contacts, open deals and recent activity', 'Accounts', { parameters: [pathParam('accountId', 'A-2204', 'Account number, e.g. A-2204')] }) },
        '/accounts/{accountId}/notes': { post: op('addMeetingNote', 'Add a meeting note to an account', 'Notes', { parameters: [pathParam('accountId', 'A-2204', 'Account number')], requestBody: jsonBody(['summary'], { summary: { type: 'string', description: 'What was discussed' }, nextSteps: { type: 'string', description: 'Agreed next steps and owners' } }) }) },
      },
    },
    status: {
      info: { title: 'Northwind Status', version: '1.2.0', description: 'Health checks for the systems Northwind runs: website, checkout, payments, backups and storage.' },
      servers: [{ url: `${ORIGIN}/status/api` }],
      paths: {
        '/checks': { get: op('runHealthChecks', 'Check the health of every system', 'Checks') },
        '/jobs/failed': { get: op('listFailedJobs', 'List background jobs that failed in the last 24 hours', 'Jobs') },
      },
    },
    kb: {
      info: { title: 'Northwind Help Center', version: '2.0.0', description: 'The public product documentation and help articles for Northwind coffee equipment.' },
      servers: [{ url: `${ORIGIN}/kb/api` }],
      paths: {
        '/articles': { get: op('searchArticles', 'Search the product documentation and help articles', 'Articles', { parameters: [queryParam('query', 'What the visitor is asking about')] }) },
        '/articles/{articleId}': { get: op('getArticle', 'Read one help article', 'Articles', { parameters: [pathParam('articleId', 'KB-118', 'Article id')] }) },
      },
    },
    intranet: {
      info: { title: 'Northwind Intranet', version: '3.0.0', description: 'Staff handbook, HR and IT policies, leave balances and IT requests for Northwind employees.' },
      servers: [{ url: `${ORIGIN}/intranet/api` }],
      paths: {
        '/policies': { get: op('searchPolicies', 'Search the staff handbook and HR and IT policies', 'Policies', { parameters: [queryParam('query', 'What the employee is asking about')] }) },
        '/people/{email}/leave': { get: op('getLeaveBalance', 'Get how many vacation days an employee has left', 'People', { parameters: [pathParam('email', 'sam.rivera@northwind.example', 'Work email')] }) },
        '/it-requests': { post: op('openItRequest', 'Open an IT request (new laptop, access, password reset)', 'IT', { requestBody: jsonBody(['summary'], { summary: { type: 'string' }, requester: { type: 'string' } }) }) },
      },
    },
  }
  const s = specs[key]
  return s && { openapi: '3.0.3', ...s }
}

const ACCOUNT = {
  id: 'A-2204', name: 'Kestrel Coffee Co.', customerSince: '2022-03-01', locations: 38, owner: 'Ava Chen',
  renewal: { date: '2026-11-30', value: 48000 },
  contacts: [{ name: 'Dana Ortiz', title: 'COO' }, { name: 'Luis Park', title: 'Head of Purchasing' }],
  openDeals: [{ name: 'Espresso line expansion', value: 22000, stage: 'Negotiation' }],
  recentActivity: [{ at: '2026-09-18', note: 'Dana asked about volume pricing for 12 more grinders.' }],
  openTickets: 2,
}

function guideAnswer(method, path) {
  let m
  if (path === '/crm/api/accounts') return [{ id: 'A-2204', name: 'Kestrel Coffee Co.', owner: 'Ava Chen' }]
  if ((m = path.match(/^\/crm\/api\/accounts\/([^/]+)\/notes$/))) return { noteId: 'N-5120', accountId: m[1], saved: true }
  if ((m = path.match(/^\/crm\/api\/accounts\/([^/]+)$/))) return { ...ACCOUNT, id: m[1] }
  if (path === '/status/api/checks') return { checkedAt: '2026-09-30T02:00:00Z', systems: [
    { name: 'Website', status: 'ok', uptime: '100%' },
    { name: 'Checkout', status: 'ok', p95ms: 420 },
    { name: 'Payment webhooks', status: 'degraded', detail: '3 failed deliveries since 02:10 UTC, retrying' },
    { name: 'Nightly backup', status: 'ok', detail: 'Finished 01:04 UTC' },
    { name: 'Reporting database disk', status: 'warning', detail: '81% full' },
  ] }
  if (path === '/status/api/jobs/failed') return [{ job: 'payment-webhook-delivery', failures: 3, lastError: 'Timeout from payment provider' }]
  if (path === '/kb/api/articles') return [{ id: 'KB-118', title: 'Brew 2 grinder: power and voltage', excerpt: 'The Brew 2 runs on 100 to 240 V, so it works in the US, the EU and the UK with the plug that ships for your country. Help center article.' }]
  if ((m = path.match(/^\/kb\/api\/articles\/([^/]+)$/))) return { id: m[1], title: 'Brew 2 grinder: power and voltage', body: 'The Brew 2 runs on 100 to 240 V. Help center article.' }
  if (path === '/intranet/api/policies') return [{ id: 'HB-4.2', title: 'Laptops and equipment', excerpt: 'Laptops are replaced every three years, or sooner if broken. Ask through an IT request. Staff handbook, section 4.2.' }]
  if ((m = path.match(/^\/intranet\/api\/people\/([^/]+)\/leave$/))) return { email: decodeURIComponent(m[1]), year: 2026, allowance: 28, taken: 16, left: 12, handbook: 'Staff handbook, section 6.1' }
  if (path === '/intranet/api/it-requests') return { id: 'IT-3317', status: 'open', queue: 'IT hardware' }
  // A Slack incoming webhook stands in here: the operations guide posts its report to it.
  if (path.startsWith('/slack/services/') && method === 'POST') return { ok: true }
  return null
}

function apiAnswer(method, path, url) {
  let m
  if ((m = path.match(/^\/orders\/v2\/orders\/([^/]+)\/shipment$/))) {
    return { orderId: m[1], carrier: ORDERS[m[1]]?.carrier || 'DHL Express', events: [
      { at: '2026-09-24T08:12:00Z', status: 'Picked up', location: 'Rotterdam, NL' },
      { at: '2026-09-25T17:40:00Z', status: 'Held at customs', location: 'Leipzig, DE' },
    ] }
  }
  if ((m = path.match(/^\/orders\/v2\/orders\/([^/]+)\/refunds$/))) return { refundId: 'RF-2291', orderId: m[1], status: 'issued' }
  if ((m = path.match(/^\/orders\/v2\/orders\/([^/]+)$/))) return ORDERS[m[1]] || { ...ORDERS['NW-10428'], id: m[1] }
  if (path === '/orders/v2/orders') return Object.values(ORDERS)
  if (path.startsWith('/orders/v2/customers/')) return { id: path.split('/').pop(), name: 'Brightway Logistics', tier: 'enterprise', since: '2021-04-12' }
  if (path === '/helpdesk/api/tickets' && method === 'GET') return [
    { id: 'T-5521', subject: 'Order NW-10428 still not here', priority: 'high', status: 'open' },
    { id: 'T-5519', subject: 'Refund for damaged grinder', priority: 'urgent', status: 'pending' },
  ]
  if (path === '/helpdesk/api/csat') return { days: Number(url.searchParams.get('days') || 7), responses: 214, score: 4.6 }
  if (path === '/helpdesk/api/macros') return [{ id: 'M-12', title: 'Shipping delay apology' }, { id: 'M-19', title: 'Refund over threshold' }]
  if (path.startsWith('/helpdesk/api/tickets')) return { id: path.split('/')[4] || 'T-5530', status: method === 'POST' ? 'created' : 'ok' }
  const more = guideAnswer(method, path, url)
  if (more) return more
  return null
}

// ---------- the scripted model ----------

function text(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => c?.text ?? (typeof c?.content === 'string' ? c.content : '')).join(' ')
  return ''
}

function sampleArgs(schema, question) {
  const args = {}
  if (schema?.properties?.reason && schema?.properties?.payload) {
    const order = (question.match(/NW-\d{5}/) || ['NW-44120'])[0]
    return { reason: `Refund of $820 on order ${order} is over the $500 limit for automatic refunds`, payload: { orderId: order, amount: 820, currency: 'USD', customer: 'Brightway Logistics', tool: 'northwind_orders_create_refund' } }
  }
  const props = schema?.properties || {}
  const order = (question.match(/NW-\d{5}/) || ['NW-10428'])[0]
  for (const [name, prop] of Object.entries(props)) {
    if (!(schema.required || []).includes(name) && !/order|id|query|city/i.test(name)) continue
    if (/order/i.test(name)) args[name] = order
    else if (/ticket/i.test(name)) args[name] = 'T-5521'
    else if (/account/i.test(name)) args[name] = 'A-2204'
    else if (/email/i.test(name)) args[name] = 'sam.rivera@northwind.example'
    else if (/summary|text|body|note/i.test(name)) args[name] = question.slice(0, 280)
    else if (name === 'name') args[name] = (question.match(/Kestrel|Brightway/i) || ['Kestrel'])[0]
    else if (/customer/i.test(name)) args[name] = 'C-1182'
    else if (/amount/i.test(name)) { const m = question.match(/\$\s?([\d,]+(?:\.\d+)?)/); args[name] = m ? Number(m[1].replace(/,/g, '')) : 7 }
    else if (/reason/i.test(name)) args[name] = /defective/i.test(question) ? 'Arrived defective' : 'Customer request'
    else if (prop?.type === 'number' || prop?.type === 'integer') args[name] = 7
    else if (prop?.type === 'boolean') args[name] = false
    else args[name] = /query/i.test(name) ? question.slice(0, 60) : 'Northwind'
  }
  return args
}

// Told to ask for approval itself (the seed's support agent), the model calls the
// built-in approval tool for a big refund; otherwise it calls the refund tool,
// and an amount rule, if there is one, holds the call for a person.
function pickTool(tools, question, convo = '') {
  const askFirst = /ask (?:a person to approve|for approval)/i.test(convo)
  const q = question.toLowerCase()
  const score = (t) => {
    const n = `${t.name} ${t.description || ''}`.toLowerCase()
    let s = 0
    if (/track|ship|where|delay/.test(q) && /track|shipment/.test(n)) s += 3
    if (/order|nw-/.test(q) && /get.?order|getorder/.test(n)) s += 2
    if (/refund/.test(q) && /refund/.test(n)) s += 3
    // A refund over the limit goes to a person first: the built-in approval tool.
    if (askFirst && /refund/.test(q) && /\$\d{3,}|over|approv/.test(q) && n.startsWith('request_approval')) s += 5
    if (/ticket|triage/.test(q) && /ticket/.test(n)) s += 2
    if (/csat|satisfaction/.test(q) && /csat/.test(n)) s += 3
    if (/remember|recall|memory/.test(q) && /memory|recall/.test(n)) s += 2
    // The use-case guides: sales, operations, marketing, internal help desk.
    if (/note|notes|write (?:it|them) back|save/.test(q) && /meeting.?note/.test(n)) s += 6
    if (/call|account|kestrel|brief|crm/.test(q) && /get.?account/.test(n)) s += 4
    if (/check|systems?|health|nightly|report/.test(q) && /health.?check/.test(n)) s += 4
    if (/post|send|slack|share/.test(q) && /post.?to.?slack|slack/.test(n) && /report|summary|posted|send/.test(q)) s += 1
    if (/voltage|volt|grinder|brew|product|warranty|work with|does it/.test(q) && /search.?articles/.test(n)) s += 4
    if (/vacation|holiday|leave|days off/.test(q) && /leave.?balance/.test(n)) s += 5
    if (/laptop|password|access|it request/.test(q) && /polic/.test(n)) s += 3
    if (/policy|handbook|expense/.test(q) && /polic/.test(n)) s += 3
    return s
  }
  return [...tools].sort((a, b) => score(b) - score(a))[0]
}

const ANSWERS = [
  [/verdict|refute|check (?:the|this) answer|verifier/i, '{"verdict":"pass","confidence":0.92,"issues":[]}'],
  // The use-case guides first: each keys on what its own tool returned.
  [/"noteId"|N-5120/i, 'Saved to Kestrel Coffee Co. in the CRM (note N-5120): Dana wants volume pricing for 12 more grinders before the November renewal. Next step: you send a quote by Friday.'],
  [/"renewal"|Espresso line expansion/i, 'Kestrel Coffee Co. (A-2204): customer since March 2022, 38 locations. Renewal due November 30, worth $48,000 a year. Open deal: Espresso line expansion, $22,000, in negotiation. Last contact September 18: Dana Ortiz (COO) asked about volume pricing for 12 more grinders. Two support tickets are open. Suggested opener: bring the volume quote.'],
  [/"systems"|Payment webhooks/i, 'Nightly check, September 30: 4 of 5 systems healthy. Needs attention: payment webhooks had 3 failed deliveries since 02:10 UTC (retrying), and the reporting database disk is 81% full. Backups finished at 01:04 UTC.'],
  [/KB-118|power and voltage/i, 'Yes. The Brew 2 grinder runs on 100 to 240 V, so it works in the US, the EU and the UK with the plug that ships for your country. Source: "Brew 2 grinder: power and voltage" in the help center.'],
  [/"allowance"|section 6\.1/i, 'You have 12 vacation days left this year: 28 in your allowance, 16 taken. Unused days carry over until March 31 (staff handbook, section 6.1).'],
  [/HB-4\.2|Laptops and equipment/i, 'Laptops are replaced every three years, or sooner if broken (staff handbook, section 4.2). Yours is due, so ask IT through an IT request and mention the model you have now.'],
  [/RF-2291/, 'Refund RF-2291 of $820 on order NW-44120 is issued, after a manager approved it. Brightway Logistics will see it on their card in 3 to 5 business days.'],
  [/refund|NW-44120/i, 'Brightway Logistics reported order NW-44120 ($820) arrived defective. Refunds over $500 need a human decision, so I have escalated it for approval and let the customer know we will confirm within one business day.'],
  [/delay|NW-10428|where is/i, 'Order NW-10428 for Harbor & Pine Outfitters is delayed: DHL Express is holding it at customs in Leipzig. The new delivery estimate is October 2. I drafted a reply apologising for the delay and offering free expedited shipping on the next order, per the delayed-shipment policy.'],
  [/csat|satisfaction|digest|report/i, 'Last 7 days: 214 CSAT responses, average 4.6 out of 5. Two themes in the low scores: customs delays on EU shipments and slow refund confirmations. No action is overdue.'],
  [/contract|clause|liabil/i, 'Clause 9.2 caps liability at twelve months of fees but excludes data-protection breaches, which leaves that exposure uncapped. Recommend asking for a separate cap of 2x annual fees for data claims.'],
  [/triage|ticket/i, 'Ticket T-5521 is a shipping delay on a high-value account: priority high, routed to Tier 2, reply drafted from the "Shipping delay apology" macro.'],
]

// The question and what the tool returned decide the answer; the rest of the
// conversation (system prompts mention refunds and policies) only breaks a tie.
function answerFor(question, toolResult, conversation) {
  const [verdict, ...rest] = ANSWERS
  if (verdict[0].test(conversation)) return verdict[1]
  for (const text of [question + ' ' + (toolResult || ''), conversation]) {
    for (const [re, answer] of rest) if (re.test(text)) return answer
  }
  return 'Done. Everything checks out and nothing needs a follow-up.'
}

function decide({ messages, tools, system }) {
  const users = messages.filter((m) => m.role === 'user')
  const question = text(users[users.length - 1]?.content) || ''
  // Only this turn counts: tool calls and results after the last user message.
  const lastUser = messages.map((m) => m.role).lastIndexOf('user')
  const turn = messages.slice(lastUser + 1)
  const results = turn.filter((m) => m.role === 'tool' || m.role === 'function' ||
    (Array.isArray(m.content) && m.content.some((c) => c?.type === 'tool_result' || c?.functionResponse)))
  const hasToolResult = results.length > 0
  const called = turn.flatMap((m) => (m.tool_calls || []).map((c) => c.function?.name))
  const convo = `${system || ''} ${messages.map((m) => text(m.content)).join(' ')}`
  const promptTokens = Math.max(180, Math.round(convo.length / 3.8))
  // A question the organization's shared memory answers (the internal help
  // desk guide adds the office Wi-Fi document there): answered from what the
  // agent was given, without a tool. Without the document it goes on as usual.
  if (/wi-?fi/i.test(question) && /NW-Guest/.test(convo)) {
    const content = 'The guest Wi-Fi is NW-Guest. The password changes every Monday and is on the card at reception. Staff laptops join NW-Staff automatically. (From the office guide.)'
    return { content, promptTokens, completionTokens: Math.round(content.length / 4) }
  }
  if (tools?.length && !hasToolResult) {
    const tool = pickTool(tools, question, convo)
    return { toolCall: { name: tool.name, args: sampleArgs(tool.parameters, question) }, promptTokens, completionTokens: 42 }
  }
  const found = results.map((m) => text(m.content)).join(' ')
  const content = answerFor(question, found, convo.slice(-4000))
  // Asked to post a report to Slack and holding a tool for it: post, then say so.
  const post = (tools || []).find((t) => /slack/i.test(`${t.name} ${t.description || ''}`) && /post|send/i.test(`${t.name} ${t.description || ''}`))
  if (post && /slack/i.test(convo) && !called.includes(post.name)) {
    return { toolCall: { name: post.name, args: { text: content } }, promptTokens, completionTokens: 60 }
  }
  if (post && called.includes(post.name)) {
    const report = answerFor(question, found.replace(/\{"ok":true\}/g, ''), convo.slice(-4000))
    return { content: `Posted to Slack. ${report}`, promptTokens, completionTokens: Math.round(report.length / 4) }
  }
  return { content, promptTokens, completionTokens: Math.round(content.length / 4) }
}

// ---------- HTTP ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
let seq = 0
const callId = () => `call_${(++seq).toString(36).padStart(6, '0')}`

function openaiChat(res, body) {
  const tools = (body.tools || []).map((t) => ({ name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters }))
  const d = decide({ messages: body.messages || [], tools })
  const created = 1790000000
  const model = body.model || 'gpt-4o'
  const usage = { prompt_tokens: d.promptTokens, completion_tokens: d.completionTokens, total_tokens: d.promptTokens + d.completionTokens }
  const toolCalls = d.toolCall ? [{ id: callId(), type: 'function', function: { name: d.toolCall.name, arguments: JSON.stringify(d.toolCall.args) } }] : undefined
  const message = { role: 'assistant', content: d.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }
  const finish = toolCalls ? 'tool_calls' : 'stop'
  if (!body.stream) return json(res, 200, { id: 'chatcmpl-demo', object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const chunk = (delta, finish_reason, extra = {}) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`)
  if (toolCalls) chunk({ role: 'assistant', tool_calls: toolCalls.map((c, index) => ({ index, ...c })) }, null)
  else for (const piece of d.content.match(/.{1,40}(\s|$)/g) || [d.content]) chunk({ content: piece }, null)
  chunk({}, finish)
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-demo', object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`)
  res.end('data: [DONE]\n\n')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', ORIGIN)
  const path = url.pathname
  try {
    if (path === '/health') return json(res, 200, { ok: true })
    if (path === '/orders/openapi.json') return json(res, 200, ordersOpenApi())
    if (path === '/helpdesk/openapi.json') return json(res, 200, helpdeskOpenApi())
    const guideSpec = path.match(/^\/(crm|status|kb|intranet)\/openapi\.json$/)
    if (guideSpec) return json(res, 200, guideOpenApi(guideSpec[1]))

    let m
    if ((m = path.match(/^\/(\w+)\/v1\/models$/)) && MODELS[m[1]]) {
      return json(res, 200, { object: 'list', data: MODELS[m[1]].map((model) => ({ ...model, object: 'model', owned_by: model.id.split('/')[0] })) })
    }
    if ((m = path.match(/^\/(\w+)\/v1\/chat\/completions$/)) && MODELS[m[1]]) return openaiChat(res, JSON.parse(await readBody(req)))
    if ((m = path.match(/^\/(\w+)\/v1\/embeddings$/)) && MODELS[m[1]]) {
      const body = JSON.parse(await readBody(req))
      const inputs = Array.isArray(body.input) ? body.input : [body.input]
      const dims = Number(body.dimensions) || 1536
      return json(res, 200, { object: 'list', model: body.model, data: inputs.map((s, index) => ({ object: 'embedding', index, embedding: Array.from({ length: dims }, (_, i) => Math.sin((String(s).length + 1) * (i + 1)) / 10) })), usage: { prompt_tokens: 8, total_tokens: 8 } })
    }

    const answer = apiAnswer(req.method, path, url)
    if (answer) return json(res, req.method === 'POST' ? 201 : 200, answer)
    json(res, 404, { error: 'not found', path })
  } catch (error) {
    json(res, 500, { error: String(error?.message || error) })
  }
})

server.listen(PORT, () => console.log(`fake upstream on ${ORIGIN}`))
