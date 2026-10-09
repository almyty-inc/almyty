// A local stand-in for Google Calendar, Gmail, Google Tasks, HubSpot CRM and
// an OAuth 2.0 sign-in, so the founder and biz-dev agents can run end to end
// without anyone's real account. Paths match the real public APIs; only the
// host differs. Nothing here ever talks to the internet.
//
// Used by the tutorials' screenshots (tutorials.mjs); stack.sh starts it
// when USECASES=1. State lives in memory: a restart starts fresh.
//
//   node upstream.mjs          listens on USECASE_PORT (default 4291)
//   GET  /_admin/state         everything sent/created so far
//   POST /_admin/reply         {to, body}: the prospect at `to` answers our last mail
//   POST /_admin/age?days=4    move every sent mail N days into the past
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.USECASE_PORT || 4291)
// Every request, one line each, for reading what a run did.
const LOG = process.env.USECASE_LOG || '/tmp/almyty-demo/usecase-requests.log'
const DAY = 86400000
const now = () => new Date()
const at = (dayOffset, hh, mm = 0) => {
  const d = new Date(); d.setUTCHours(hh, mm, 0, 0); return new Date(d.getTime() + dayOffset * DAY).toISOString()
}

// ---------------- calendar ----------------
const ME = { email: 'maya@lumenlabs.example', name: 'Maya Chen' }
const calendars = [
  { id: 'primary', summary: 'Maya Chen (work)', primary: true, accessRole: 'owner', timeZone: 'UTC' },
  { id: 'team@lumenlabs.example', summary: 'Lumen Labs team', accessRole: 'reader', timeZone: 'UTC' },
  { id: 'maya.personal@example.com', summary: 'Personal', accessRole: 'owner', timeZone: 'UTC' },
]
const ev = (cal, id, day, h1, m1, h2, m2, summary, extra = {}) => ({
  kind: 'calendar#event', id, calendarId: cal, status: 'confirmed', summary,
  start: { dateTime: at(day, h1, m1) }, end: { dateTime: at(day, h2, m2) },
  organizer: { email: ME.email }, ...extra,
})
const events = [
  ev('team@lumenlabs.example', 'ev-standup', 0, 8, 30, 8, 45, 'Team standup'),
  ev('primary', 'ev-investor', 0, 10, 0, 11, 0, 'Brightline Ventures: follow-up on seed extension', {
    description: 'Daniel wants the updated metrics deck and the hiring plan.',
    attendees: [{ email: ME.email, responseStatus: 'accepted' }, { email: 'daniel.okafor@brightline.example', displayName: 'Daniel Okafor', responseStatus: 'accepted' }],
    location: 'Google Meet',
  }),
  ev('maya.personal@example.com', 'ev-dentist', 0, 10, 30, 11, 15, 'Dentist (Dr. Alvarez)', { location: '12 Harbor St' }),
  ev('primary', 'ev-intro-priya', 0, 14, 0, 14, 45, 'Intro: Priya Raman (Kestrel Logistics)', {
    description: 'Intro via Tom Becker. Kestrel is looking at route-planning tools.',
    attendees: [{ email: ME.email, responseStatus: 'accepted' }, { email: 'priya.raman@kestrel-logistics.example', displayName: 'Priya Raman', responseStatus: 'accepted' }],
  }),
  ev('primary', 'ev-board-prep', 0, 16, 0, 17, 0, 'Board meeting prep'),
  ev('team@lumenlabs.example', 'ev-hiring', 0, 16, 30, 17, 0, 'Hiring sync: senior engineer pipeline'),
  ev('primary', 'ev-customer', 1, 9, 0, 9, 45, 'Customer check-in: Harbor Freight Co.', {
    attendees: [{ email: ME.email }, { email: 'li.wong@harborfreight.example', displayName: 'Li Wong' }],
  }),
  ev('primary', 'ev-board', 2, 15, 0, 17, 0, 'Board meeting', { attendees: [{ email: ME.email }, { email: 'daniel.okafor@brightline.example', displayName: 'Daniel Okafor' }] }),
]

// ---------------- gmail ----------------
let msgSeq = 100
const mail = [] // {id, threadId, from, to, subject, body, date, labels}
const addMail = (m) => { const id = m.id || `m${++msgSeq}`; const msg = { labels: ['INBOX'], ...m, id, threadId: m.threadId || id }; mail.push(msg); return msg }
addMail({ id: 'm1', from: 'Daniel Okafor <daniel.okafor@brightline.example>', to: ME.email, subject: 'Before Thursday', date: at(-2, 18, 12), body: 'Hi Maya, ahead of our call could you send the updated metrics deck? I would also like to understand the hiring plan for Q1. Also: are you still open to an intro to Sana at Fieldstone? Best, Daniel' })
addMail({ id: 'm2', from: 'Tom Becker <tom@beckerpartners.example>', to: ME.email, subject: 'Intro: Maya <> Priya (Kestrel Logistics)', date: at(-6, 9, 3), body: 'Maya, meet Priya. Priya runs operations at Kestrel Logistics and is rethinking how they plan routes. Maya and I worked together at Atlas; she built the routing engine there. I will let you two take it from here. Tom' })
addMail({ id: 'm3', threadId: 'm2', from: 'Priya Raman <priya.raman@kestrel-logistics.example>', to: ME.email, subject: 'Re: Intro: Maya <> Priya (Kestrel Logistics)', date: at(-5, 11, 40), body: 'Thanks Tom! Maya, happy to talk. We have 140 trucks and still plan routes in spreadsheets. Thursday at 14:00 works.' })
addMail({ id: 'm4', from: 'Li Wong <li.wong@harborfreight.example>', to: ME.email, subject: 'Invoice question', date: at(-1, 7, 55), body: 'Hi Maya, our finance team asks whether the October invoice can be split across two cost centers. Thanks, Li' })
addMail({ id: 'm5', from: 'Newsletter <news@saasweekly.example>', to: ME.email, subject: 'This week in SaaS', date: at(-1, 6, 0), body: 'Ten links you missed...' })

// ---------------- tasks ----------------
const taskLists = [{ kind: 'tasks#taskList', id: 'list-work', title: 'Work' }, { kind: 'tasks#taskList', id: 'list-personal', title: 'Personal' }]
const tasks = {
  'list-work': [
    { id: 't1', title: 'Send updated metrics deck to Daniel', status: 'needsAction', due: at(0, 0) , notes: 'Before the Brightline call' },
    { id: 't2', title: 'Write Q1 hiring plan', status: 'needsAction', due: at(1, 0) },
    { id: 't3', title: 'Reply to Li about split invoice', status: 'needsAction', due: at(-1, 0) },
    { id: 't4', title: 'Review pricing page copy', status: 'completed', completed: at(-1, 15) },
  ],
  'list-personal': [{ id: 't5', title: 'Book flights for the offsite', status: 'needsAction', due: at(3, 0) }],
}

// ---------------- hubspot ----------------
let crmSeq = 9000
const companies = [
  { id: '501', properties: { name: 'Kestrel Logistics', domain: 'kestrel-logistics.example', industry: 'TRANSPORTATION_TRUCKING_RAILROAD', numberofemployees: '320', city: 'Rotterdam', country: 'Netherlands', lifecyclestage: 'lead', description: 'Regional freight carrier, 140 trucks, plans routes in spreadsheets.' } },
  { id: '502', properties: { name: 'Bluefin Couriers', domain: 'bluefin.example', industry: 'TRANSPORTATION_TRUCKING_RAILROAD', numberofemployees: '210', city: 'Hamburg', country: 'Germany', lifecyclestage: 'lead', description: 'Same-day courier network across northern Germany, growing 40% a year.' } },
  { id: '503', properties: { name: 'Northgate Cold Chain', domain: 'northgate-cold.example', industry: 'LOGISTICS_AND_SUPPLY_CHAIN', numberofemployees: '480', city: 'Antwerp', country: 'Belgium', lifecyclestage: 'lead', description: 'Refrigerated transport for food retailers; just opened a second depot.' } },
  { id: '504', properties: { name: 'Pinecrest Bakery', domain: 'pinecrest.example', industry: 'FOOD_PRODUCTION', numberofemployees: '35', city: 'Utrecht', country: 'Netherlands', lifecyclestage: 'lead', description: 'Local bakery chain.' } },
  { id: '505', properties: { name: 'Harbor Freight Co.', domain: 'harborfreight.example', industry: 'LOGISTICS_AND_SUPPLY_CHAIN', numberofemployees: '900', city: 'Rotterdam', country: 'Netherlands', lifecyclestage: 'customer', description: 'Existing customer.' } },
]
const contacts = [
  { id: '601', properties: { firstname: 'Priya', lastname: 'Raman', email: 'priya.raman@kestrel-logistics.example', jobtitle: 'Head of Operations', company: 'Kestrel Logistics', associatedcompanyid: '501', hs_linkedin_url: 'https://www.linkedin.com/in/priya-raman-example' } },
  { id: '602', properties: { firstname: 'Jonas', lastname: 'Weber', email: 'jonas.weber@bluefin.example', jobtitle: 'COO', company: 'Bluefin Couriers', associatedcompanyid: '502', hs_linkedin_url: 'https://www.linkedin.com/in/jonas-weber-example' } },
  { id: '603', properties: { firstname: 'Mia', lastname: 'Schulz', email: 'mia.schulz@bluefin.example', jobtitle: 'Dispatcher', company: 'Bluefin Couriers', associatedcompanyid: '502' } },
  { id: '604', properties: { firstname: 'Elise', lastname: 'Maes', email: 'elise.maes@northgate-cold.example', jobtitle: 'VP Operations', company: 'Northgate Cold Chain', associatedcompanyid: '503', hs_linkedin_url: 'https://www.linkedin.com/in/elise-maes-example' } },
  { id: '605', properties: { firstname: 'Ruben', lastname: 'Claes', email: 'ruben.claes@northgate-cold.example', jobtitle: 'Fleet Planner', company: 'Northgate Cold Chain', associatedcompanyid: '503' } },
  { id: '606', properties: { firstname: 'Li', lastname: 'Wong', email: 'li.wong@harborfreight.example', jobtitle: 'Operations Manager', company: 'Harbor Freight Co.', associatedcompanyid: '505' } },
]
const deals = []
const outbox = []
const notes = []

const wrap = (o) => ({ ...o, createdAt: o.createdAt || at(-30, 9), updatedAt: o.updatedAt || at(-1, 9), archived: false })

function matchFilters(obj, body) {
  const groups = body?.filterGroups || []
  const q = (body?.query || '').toLowerCase()
  const props = obj.properties
  if (q && !Object.values(props).some((v) => String(v).toLowerCase().includes(q))) return false
  if (!groups.length) return true
  return groups.some((g) => (g.filters || []).every((f) => {
    const v = props[f.propertyName]
    const want = f.value
    switch (f.operator) {
      case 'EQ': return String(v ?? '').toLowerCase() === String(want ?? '').toLowerCase()
      case 'NEQ': return String(v ?? '').toLowerCase() !== String(want ?? '').toLowerCase()
      case 'GT': return Number(v) > Number(want)
      case 'GTE': return Number(v) >= Number(want)
      case 'LT': return Number(v) < Number(want)
      case 'LTE': return Number(v) <= Number(want)
      case 'CONTAINS_TOKEN': return String(v ?? '').toLowerCase().includes(String(want ?? '').replace(/\*/g, '').toLowerCase())
      case 'IN': return (f.values || []).map((x) => String(x).toLowerCase()).includes(String(v ?? '').toLowerCase())
      case 'HAS_PROPERTY': return v != null && v !== ''
      default: return true
    }
  }))
}

// ---------------- helpers ----------------
const send = (res, status, body, headers = {}) => {
  const isStr = typeof body === 'string'
  res.writeHead(status, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', ...headers })
  res.end(isStr ? body : JSON.stringify(body))
}
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { r(s ? JSON.parse(s) : {}) } catch { r({ _raw: s }) } }) })
const b64url = (s) => Buffer.from(s).toString('base64url')
const unb64 = (s) => { try { return Buffer.from(s, 'base64url').toString('utf8') } catch { return '' } }
const header = (m) => [
  { name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date(m.date).toUTCString() },
]
const gmailMsg = (m, format) => ({
  id: m.id, threadId: m.threadId, labelIds: m.labels, snippet: m.body.slice(0, 120), internalDate: String(Date.parse(m.date)),
  payload: format === 'minimal' ? undefined : { mimeType: 'text/plain', headers: header(m), body: { size: m.body.length, data: b64url(m.body) } },
})
function gmailFilter(q) {
  q = (q || '').toLowerCase()
  let list = mail.slice()
  if (/in:sent|label:sent/.test(q)) list = list.filter((m) => m.labels.includes('SENT'))
  else if (/in:inbox|label:inbox/.test(q) || !/in:anywhere/.test(q)) list = list.filter((m) => m.labels.includes('INBOX') || !/in:inbox/.test(q))
  const ors = q.match(/\(([^)]*\bor\b[^)]*)\)/)
  if (ors) {
    const alts = [...ors[1].matchAll(/(from|to):([^\s)]+)/g)].map(([, k, v]) => [k, v])
    list = list.filter((m) => alts.some(([k, v]) => String(m[k]).toLowerCase().includes(v)))
    q = q.replace(ors[0], ' ')
  }
  for (const [, key, val] of q.matchAll(/(from|to|subject):("[^"]+"|\S+)/g)) {
    const v = val.replace(/"/g, '')
    list = list.filter((m) => String(m[key]).toLowerCase().includes(v))
  }
  const nt = q.match(/newer_than:(\d+)d/)
  if (nt) list = list.filter((m) => Date.parse(m.date) > Date.now() - Number(nt[1]) * DAY)
  const free = q.replace(/(in|label|from|to|subject|newer_than|is|after|before):("[^"]+"|\S+)/g, '').trim()
  if (free) list = list.filter((m) => free.split(/\s+/).every((w) => `${m.subject} ${m.body} ${m.from} ${m.to}`.toLowerCase().includes(w)))
  return list.sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
}

// ---------------- oauth (a local stand-in for "Sign in with Google") ----------------
const consent = (u) => `<!doctype html><html><head><title>Sign in (local test)</title><style>body{font-family:system-ui;background:#f4f4f5;display:flex;justify-content:center;padding-top:80px}main{background:#fff;padding:32px;border-radius:12px;width:420px;box-shadow:0 2px 12px #0002}button{background:#1a73e8;color:#fff;border:0;padding:10px 20px;border-radius:6px;font-size:15px}li{margin:6px 0}</style></head><body><main>
<h2>Local test sign-in</h2><p>This is the local stand-in for the provider's consent screen. A real Google sign-in asks the same thing.</p>
<p><b>almyty</b> wants to access <b>${ME.email}</b>:</p><ul>${(u.searchParams.get('scope') || '').split(/[ +]/).filter(Boolean).map((s) => `<li>${s}</li>`).join('')}</ul>
<form method="get" action="/oauth/approve">${[...u.searchParams].map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('')}<button type="submit">Allow</button></form></main></body></html>`

// ---------------- server ----------------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  const p = decodeURIComponent(u.pathname)
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined
  appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${u.pathname}${u.search} auth=${req.headers.authorization ? req.headers.authorization.slice(0, 18) + '...' : 'none'} ${body ? JSON.stringify(body).slice(0, 400) : ''}\n`)
  let m
  try {
    if (p === '/health') return send(res, 200, { ok: true })
    // OpenAI-compatible model stand-in (scripted; see model.mjs)
    if (p === '/openai/v1/models') return send(res, 200, { object: 'list', data: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'].map((id) => ({ id, object: 'model', created: 1715367049, owned_by: 'openai' })) })
    if (p === '/openai/v1/chat/completions' && req.method === 'POST') {
      const { decide } = await import(`./model.mjs?t=${Date.now()}`)
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
    // outbound channel traffic redirected here by the test harness (never sent for real)
    if (p.startsWith('/_ext/')) {
      outbox.push({ at: new Date().toISOString(), url: p.slice(5) + u.search, body })
      if (p.startsWith('/_ext/api.resend.com')) return send(res, 200, { id: 'local-email-' + outbox.length })
      if (p.includes('/users.info')) return send(res, 200, { ok: true, user: { id: 'U0MAYA', name: 'maya', real_name: 'Maya Chen', profile: { email: ME.email, real_name: 'Maya Chen', display_name: 'Maya' } } })
      if (p.includes('/conversations.list')) return send(res, 200, { ok: true, channels: [{ id: 'C0SALES', name: 'sales' }] })
      if (p.includes('/auth.test')) return send(res, 200, { ok: true, team: 'Lumen Labs', team_id: 'T0LUMEN', user_id: 'U0BOT', bot_id: 'B0BOT' })
      return send(res, 200, { ok: true, ts: String(Date.now() / 1000), channel: body?.channel || 'D0MAYA' })
    }
    // admin
    if (p === '/_admin/state') return send(res, 200, { outbox, sent: mail.filter((x) => x.labels.includes('SENT')), drafts: mail.filter((x) => x.labels.includes('DRAFT')), deals, notes, contacts: contacts.slice(6), tasks })
    if (p === '/_admin/reply' && req.method === 'POST') {
      const last = mail.filter((x) => x.labels.includes('SENT') && x.to.toLowerCase().includes(String(body.to).toLowerCase())).pop()
      if (!last) return send(res, 404, { error: 'nothing sent to ' + body.to })
      const c = contacts.find((x) => x.properties.email === body.to)
      const msg = addMail({ threadId: last.threadId, from: c ? `${c.properties.firstname} ${c.properties.lastname} <${body.to}>` : body.to, to: ME.email, subject: last.subject.startsWith('Re:') ? last.subject : `Re: ${last.subject}`, date: now().toISOString(), body: body.body || 'Thanks for reaching out. Happy to talk, does next Tuesday work?' })
      return send(res, 200, msg)
    }
    if (p === '/_admin/move' && req.method === 'POST') {
      const e = events.find((x) => x.id === u.searchParams.get('id'))
      if (!e) return send(res, 404, { error: 'no such event' })
      const len = Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)
      const start = Date.now() + Number(u.searchParams.get('inMinutes') || 40) * 60000
      e.start.dateTime = new Date(start).toISOString(); e.end.dateTime = new Date(start + len).toISOString()
      return send(res, 200, e)
    }
    if (p === '/_admin/age' && req.method === 'POST') {
      const days = Number(u.searchParams.get('days') || 4)
      for (const x of mail) if (x.labels.includes('SENT')) x.date = new Date(Date.parse(x.date) - days * DAY).toISOString()
      return send(res, 200, { aged: days })
    }
    // oauth
    if (p === '/oauth/authorize') return send(res, 200, consent(u))
    if (p === '/oauth/approve') {
      const back = new URL(u.searchParams.get('redirect_uri'))
      back.searchParams.set('code', 'local-test-code'); if (u.searchParams.get('state')) back.searchParams.set('state', u.searchParams.get('state'))
      res.writeHead(302, { location: back.toString() }); return res.end()
    }
    if (p === '/oauth/token') return send(res, 200, { access_token: 'local-test-access-' + Date.now(), refresh_token: 'local-test-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'all' })
    if (p === '/oauth/userinfo') return send(res, 200, { email: ME.email, name: ME.name, sub: '1' })

    // google calendar  (base .../calendar/v3)
    if (p.endsWith('/users/me/calendarList')) return send(res, 200, { kind: 'calendar#calendarList', items: calendars })
    if ((m = p.match(/\/calendars\/([^/]+)\/events$/)) && req.method === 'GET') {
      const cal = m[1] === 'primary' || m[1] === ME.email ? 'primary' : m[1]
      const tMin = Date.parse(u.searchParams.get('timeMin') || '1970-01-01'), tMax = Date.parse(u.searchParams.get('timeMax') || '2999-01-01')
      const q = (u.searchParams.get('q') || '').toLowerCase()
      const items = events.filter((e) => e.calendarId === cal && Date.parse(e.end.dateTime) > tMin && Date.parse(e.start.dateTime) < tMax && (!q || JSON.stringify(e).toLowerCase().includes(q)))
        .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))
      return send(res, 200, { kind: 'calendar#events', summary: calendars.find((c) => c.id === cal)?.summary, timeZone: 'UTC', items })
    }
    if ((m = p.match(/\/calendars\/([^/]+)\/events\/([^/]+)$/))) {
      const e = events.find((x) => x.id === m[2]); return e ? send(res, 200, e) : send(res, 404, { error: { code: 404, message: 'Not Found' } })
    }
    if (p.endsWith('/freeBusy') && req.method === 'POST') {
      const tMin = Date.parse(body.timeMin), tMax = Date.parse(body.timeMax)
      const cals = {}
      for (const { id } of body.items || []) {
        const cal = id === ME.email ? 'primary' : id
        cals[id] = { busy: events.filter((e) => e.calendarId === cal && Date.parse(e.end.dateTime) > tMin && Date.parse(e.start.dateTime) < tMax).map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })) }
      }
      return send(res, 200, { kind: 'calendar#freeBusy', timeMin: body.timeMin, timeMax: body.timeMax, calendars: cals })
    }

    // gmail
    if ((m = p.match(/\/gmail\/v1\/users\/[^/]+\/messages\/send$/)) && req.method === 'POST') {
      const raw = unb64(body.raw || '')
      const h = (n) => (raw.match(new RegExp(`^${n}:\\s*(.*)$`, 'mi')) || [])[1] || ''
      const text = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n') || raw
      const msg = addMail({ threadId: body.threadId, from: ME.email, to: h('To'), subject: h('Subject'), date: now().toISOString(), body: text, labels: ['SENT'] })
      return send(res, 200, { id: msg.id, threadId: msg.threadId, labelIds: ['SENT'] })
    }
    if ((m = p.match(/\/gmail\/v1\/users\/[^/]+\/drafts$/)) && req.method === 'POST') {
      const raw = unb64(body.message?.raw || '')
      const h = (n) => (raw.match(new RegExp(`^${n}:\\s*(.*)$`, 'mi')) || [])[1] || ''
      const msg = addMail({ from: ME.email, to: h('To'), subject: h('Subject'), date: now().toISOString(), body: raw.split(/\r?\n\r?\n/).slice(1).join('\n\n') || raw, labels: ['DRAFT'] })
      return send(res, 200, { id: 'd' + msg.id, message: { id: msg.id, threadId: msg.threadId, labelIds: ['DRAFT'] } })
    }
    if ((m = p.match(/\/gmail\/v1\/users\/[^/]+\/messages$/))) {
      const list = gmailFilter(u.searchParams.get('q')).slice(0, Number(u.searchParams.get('maxResults') || 20))
      return send(res, 200, { messages: list.map((x) => ({ id: x.id, threadId: x.threadId })), resultSizeEstimate: list.length })
    }
    if ((m = p.match(/\/gmail\/v1\/users\/[^/]+\/messages\/([^/]+)$/))) {
      const x = mail.find((y) => y.id === m[1]); return x ? send(res, 200, gmailMsg(x, u.searchParams.get('format'))) : send(res, 404, { error: { code: 404, message: 'Requested entity was not found.' } })
    }
    if ((m = p.match(/\/gmail\/v1\/users\/[^/]+\/threads$/))) {
      const list = gmailFilter(u.searchParams.get('q'))
      const ids = [...new Set(list.map((x) => x.threadId))]
      return send(res, 200, { threads: ids.map((id) => ({ id, snippet: mail.filter((x) => x.threadId === id).pop().body.slice(0, 100) })), resultSizeEstimate: ids.length })
    }
    if ((m = p.match(/\/gmail\/v1\/users\/[^/]+\/threads\/([^/]+)$/))) {
      const ms = mail.filter((x) => x.threadId === m[1]); return ms.length ? send(res, 200, { id: m[1], messages: ms.map((x) => gmailMsg(x)) }) : send(res, 404, { error: { code: 404, message: 'Not Found' } })
    }
    if (p.match(/\/gmail\/v1\/users\/[^/]+\/profile$/)) return send(res, 200, { emailAddress: ME.email, messagesTotal: mail.length })

    // google tasks
    if (p.endsWith('/tasks/v1/users/@me/lists')) return send(res, 200, { kind: 'tasks#taskLists', items: taskLists })
    if ((m = p.match(/\/tasks\/v1\/lists\/([^/]+)\/tasks$/))) {
      if (req.method === 'POST') { const t = { id: 't' + ++crmSeq, status: 'needsAction', ...body }; (tasks[m[1]] ||= []).push(t); return send(res, 200, t) }
      const showDone = u.searchParams.get('showCompleted') !== 'false'
      return send(res, 200, { kind: 'tasks#tasks', items: (tasks[m[1]] || []).filter((t) => showDone || t.status !== 'completed') })
    }

    // hubspot
    if ((m = p.match(/^\/crm\/v3\/objects\/(companies|contacts|deals|notes|0-1|0-2|0-3)\/search$/)) && req.method === 'POST') {
      const src = { companies, contacts, deals, notes, '0-1': contacts, '0-2': companies, '0-3': deals }[m[1]]
      const results = src.filter((o) => matchFilters(o, body)).slice(0, body.limit || 10).map(wrap)
      return send(res, 200, { total: results.length, results })
    }
    if ((m = p.match(/^\/crm\/v3\/objects\/(companies|contacts|deals|notes|0-1|0-2|0-3)$/))) {
      const src = { companies, contacts, deals, notes, '0-1': contacts, '0-2': companies, '0-3': deals }[m[1]]
      if (req.method === 'POST') { const o = { id: String(++crmSeq), properties: body.properties || {}, associations: body.associations, createdAt: now().toISOString() }; src.push(o); return send(res, 201, wrap(o)) }
      return send(res, 200, { results: src.slice(0, Number(u.searchParams.get('limit') || 10)).map(wrap) })
    }
    if ((m = p.match(/^\/crm\/v3\/objects\/(companies|contacts|deals|notes|0-1|0-2|0-3)\/([^/]+)$/))) {
      const src = { companies, contacts, deals, notes, '0-1': contacts, '0-2': companies, '0-3': deals }[m[1]]
      const o = src.find((x) => x.id === m[2])
      if (!o) return send(res, 404, { status: 'error', message: 'resource not found', category: 'OBJECT_NOT_FOUND' })
      if (req.method === 'PATCH') { Object.assign(o.properties, body.properties || {}); o.updatedAt = now().toISOString() }
      return send(res, 200, wrap(o))
    }
    return send(res, 404, { error: 'not found in the local fake', path: p })
  } catch (e) {
    return send(res, 500, { error: String(e) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`fake upstream on http://localhost:${PORT}`))
const server6 = http.createServer((req, res) => server.emit('request', req, res))
server6.listen(PORT, '::1')
