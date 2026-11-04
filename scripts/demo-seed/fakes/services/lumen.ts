// The outside world of the tutorials (Maya Chen at Lumen) and of the
// personal-assistant tutorial (Elena Park), on one local port: Google
// Calendar, Gmail, Google Tasks, Google Drive, HubSpot CRM, an OAuth 2.0
// sign-in, a scripted OpenAI-compatible model (fakes/models/lumen.ts), and
// the outbox the API's email, Slack and Telegram calls land in. Paths match
// the real public APIs; only the host differs. Nothing here talks to the
// internet, and state lives in memory: a restart starts fresh.
//
// USECASE_PERSONA=elena serves Elena's calendars, mail and tasks instead of Maya's.
//
//   GET  /_admin/state         everything sent/created so far
//   POST /_admin/reply         {to, body}: the person at `to` answers our last mail
//   POST /_admin/age?days=4    move every sent mail N days into the past
//   POST /_admin/mail          {from, subject, body}: a new email arrives in the inbox
//   POST /_admin/win?company=  the company's deal is marked won (onboarding tutorial)
//   POST /_admin/upload        the customer's files land in their shared Drive folder
//   POST /_admin/move?id=&inMinutes=  an event moves to start soon
import { any, get, json, html, noContent, post, type Route, type Service } from '../server.ts'
import { vendor } from '../openai.ts'
import { outbox } from '../outbox.ts'
import { decide } from '../models/lumen.ts'

const DAY = 86400000
const now = () => new Date()
const at = (dayOffset: number, hh: number, mm = 0): string => {
  const d = new Date(); d.setUTCHours(hh, mm, 0, 0); return new Date(d.getTime() + dayOffset * DAY).toISOString()
}

export function lumenService(persona: string = process.env.USECASE_PERSONA || 'maya'): Service {
  // ---------------- calendar ----------------
  const ME = persona === 'elena' ? { email: 'elena.park@example.com', name: 'Elena Park' } : { email: 'maya@lumenlabs.example', name: 'Maya Chen' }
  const calendars: any[] = [
    { id: 'primary', summary: 'Maya Chen (work)', primary: true, accessRole: 'owner', timeZone: 'UTC' },
    { id: 'team@lumenlabs.example', summary: 'Lumen Labs team', accessRole: 'reader', timeZone: 'UTC' },
    { id: 'maya.personal@example.com', summary: 'Personal', accessRole: 'owner', timeZone: 'UTC' },
  ]
  const ev = (cal: string, id: string, day: number, h1: number, m1: number, h2: number, m2: number, summary: string, extra: Record<string, unknown> = {}): any => ({
    kind: 'calendar#event', id, calendarId: cal, status: 'confirmed', summary,
    start: { dateTime: at(day, h1, m1) }, end: { dateTime: at(day, h2, m2) },
    organizer: { email: ME.email }, ...extra,
  })
  const events: any[] = [
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
  const mail: any[] = [] // {id, threadId, from, to, subject, body, date, labels}
  const addMail = (m: any): any => { const id = m.id || `m${++msgSeq}`; const msg = { labels: ['INBOX'], ...m, id, threadId: m.threadId || id }; mail.push(msg); return msg }
  addMail({ id: 'm1', from: 'Daniel Okafor <daniel.okafor@brightline.example>', to: ME.email, subject: 'Before Thursday', date: at(-2, 18, 12), body: 'Hi Maya, ahead of our call could you send the updated metrics deck? I would also like to understand the hiring plan for Q1. Also: are you still open to an intro to Sana at Fieldstone? Best, Daniel' })
  addMail({ id: 'm2', from: 'Tom Becker <tom@beckerpartners.example>', to: ME.email, subject: 'Intro: Maya <> Priya (Kestrel Logistics)', date: at(-6, 9, 3), body: 'Maya, meet Priya. Priya runs operations at Kestrel Logistics and is rethinking how they plan routes. Maya and I worked together at Atlas; she built the routing engine there. I will let you two take it from here. Tom' })
  addMail({ id: 'm3', threadId: 'm2', from: 'Priya Raman <priya.raman@kestrel-logistics.example>', to: ME.email, subject: 'Re: Intro: Maya <> Priya (Kestrel Logistics)', date: at(-5, 11, 40), body: 'Thanks Tom! Maya, happy to talk. We have 140 trucks and still plan routes in spreadsheets. Thursday at 14:00 works.' })
  addMail({ id: 'm4', from: 'Li Wong <li.wong@harborfreight.example>', to: ME.email, subject: 'Invoice question', date: at(-1, 7, 55), body: 'Hi Maya, our finance team asks whether the October invoice can be split across two cost centers. Thanks, Li' })
  addMail({ id: 'm5', from: 'Newsletter <news@saasweekly.example>', to: ME.email, subject: 'This week in SaaS', date: at(-1, 6, 0), body: 'Ten links you missed...' })

  // ---------------- tasks ----------------
  const taskLists: any[] = [{ kind: 'tasks#taskList', id: 'list-work', title: 'Work' }, { kind: 'tasks#taskList', id: 'list-personal', title: 'Personal' }]
  const tasks: Record<string, any[]> = {
    'list-work': [
      { id: 't1', title: 'Send updated metrics deck to Daniel', status: 'needsAction', due: at(0, 0), notes: 'Before the Brightline call' },
      { id: 't2', title: 'Write Q1 hiring plan', status: 'needsAction', due: at(1, 0) },
      { id: 't3', title: 'Reply to Li about split invoice', status: 'needsAction', due: at(-1, 0) },
      { id: 't4', title: 'Review pricing page copy', status: 'completed', completed: at(-1, 15) },
    ],
    'list-personal': [{ id: 't5', title: 'Book flights for the offsite', status: 'needsAction', due: at(3, 0) }],
  }

  // ---------------- the personal assistant's person (USECASE_PERSONA=elena) ----------------
  // The personal-assistant tutorial is about one private person, Elena Park,
  // not Maya's company, so the same endpoints serve her calendars, mail and
  // tasks instead. A flight change arrives later through POST /_admin/mail.
  if (persona === 'elena') {
    calendars.splice(0, calendars.length,
      { id: 'primary', summary: 'Elena Park', primary: true, accessRole: 'owner', timeZone: 'UTC' },
      { id: 'family.park@example.com', summary: 'Family', accessRole: 'writer', timeZone: 'UTC' })
    const mine = { email: ME.email, self: true, responseStatus: 'accepted' }
    events.splice(0, events.length,
      ev('primary', 'ev-yoga', 0, 17, 30, 18, 30, 'Yoga', { location: 'Studio Alfama' }),
      ev('primary', 'ev-flight', 1, 6, 0, 8, 10, 'Flight AT 552 Lisbon to Berlin', { location: 'Lisbon airport (LIS)', description: 'Booking ref QX7P2L. Seat 14A.' }),
      ev('primary', 'ev-review', 1, 9, 0, 10, 0, 'Design review with Tom', {
        location: 'Northwind Studio, Berlin', description: 'Onboarding flow mockups, open questions on the settings page.',
        organizer: { email: 'tom.becker@northwind-studio.example', displayName: 'Tom Becker' },
        attendees: [mine, { email: 'tom.becker@northwind-studio.example', displayName: 'Tom Becker', responseStatus: 'accepted' }],
      }),
      ev('family.park@example.com', 'ev-lunch', 1, 13, 0, 14, 0, 'Lunch with Ana', { location: 'Cafe Einstein', attendees: [mine, { email: 'ana.park@example.com', displayName: 'Ana Park' }] }),
      ev('family.park@example.com', 'ev-dinner', 3, 19, 0, 21, 0, "Dinner at Marta's"))
    mail.splice(0, mail.length)
    addMail({ id: 'p1', from: 'Tom Becker <tom.becker@northwind-studio.example>', to: ME.email, subject: 'Agenda for tomorrow', date: at(0, 8, 14), body: 'Hi Elena, for tomorrow at 9: the onboarding flow mockups and the open questions on the settings page. If your flight runs late just tell me, I can move us to later in the morning. Tom' })
    addMail({ id: 'p2', from: 'Ana Park <ana.park@example.com>', to: ME.email, subject: 'Lunch in Berlin?', date: at(-1, 19, 2), body: 'So you are in Berlin tomorrow! Lunch at 1 at Cafe Einstein like last time? Ana' })
    addMail({ id: 'p3', from: 'City Library <notices@library.example>', to: ME.email, subject: 'Your books are due on Friday', date: at(-1, 7, 0), body: 'Two items are due back on Friday.' })
    taskLists.splice(0, taskLists.length, { kind: 'tasks#taskList', id: 'list-mine', title: 'My tasks' })
    for (const k of Object.keys(tasks)) delete tasks[k]
    tasks['list-mine'] = [
      { id: 'e1', title: 'Send Tom the onboarding mockups', status: 'needsAction', due: at(1, 0) },
      { id: 'e2', title: 'Renew passport', status: 'needsAction', due: at(9, 0), notes: 'It runs out in two months.' },
      { id: 'e3', title: "Book a table for Ana's birthday", status: 'needsAction', due: at(4, 0) },
    ]
  }

  // ---------------- hubspot ----------------
  let crmSeq = 9000
  const companies: any[] = [
    { id: '501', properties: { name: 'Kestrel Logistics', domain: 'kestrel-logistics.example', industry: 'TRANSPORTATION_TRUCKING_RAILROAD', numberofemployees: '320', city: 'Rotterdam', country: 'Netherlands', lifecyclestage: 'lead', description: 'Regional freight carrier, 140 trucks, plans routes in spreadsheets.' } },
    { id: '502', properties: { name: 'Bluefin Couriers', domain: 'bluefin.example', industry: 'TRANSPORTATION_TRUCKING_RAILROAD', numberofemployees: '210', city: 'Hamburg', country: 'Germany', lifecyclestage: 'lead', description: 'Same-day courier network across northern Germany, growing 40% a year.' } },
    { id: '503', properties: { name: 'Northgate Cold Chain', domain: 'northgate-cold.example', industry: 'LOGISTICS_AND_SUPPLY_CHAIN', numberofemployees: '480', city: 'Antwerp', country: 'Belgium', lifecyclestage: 'lead', description: 'Refrigerated transport for food retailers; just opened a second depot.' } },
    { id: '504', properties: { name: 'Pinecrest Bakery', domain: 'pinecrest.example', industry: 'FOOD_PRODUCTION', numberofemployees: '35', city: 'Utrecht', country: 'Netherlands', lifecyclestage: 'lead', description: 'Local bakery chain.' } },
    { id: '505', properties: { name: 'Harbor Freight Co.', domain: 'harborfreight.example', industry: 'LOGISTICS_AND_SUPPLY_CHAIN', numberofemployees: '900', city: 'Rotterdam', country: 'Netherlands', lifecyclestage: 'customer', description: 'Existing customer.' } },
  ]
  const contacts: any[] = [
    { id: '601', properties: { firstname: 'Priya', lastname: 'Raman', email: 'priya.raman@kestrel-logistics.example', jobtitle: 'Head of Operations', company: 'Kestrel Logistics', associatedcompanyid: '501', hs_linkedin_url: 'https://www.linkedin.com/in/priya-raman-example' } },
    { id: '602', properties: { firstname: 'Jonas', lastname: 'Weber', email: 'jonas.weber@bluefin.example', jobtitle: 'COO', company: 'Bluefin Couriers', associatedcompanyid: '502', hs_linkedin_url: 'https://www.linkedin.com/in/jonas-weber-example' } },
    { id: '603', properties: { firstname: 'Mia', lastname: 'Schulz', email: 'mia.schulz@bluefin.example', jobtitle: 'Dispatcher', company: 'Bluefin Couriers', associatedcompanyid: '502' } },
    { id: '604', properties: { firstname: 'Elise', lastname: 'Maes', email: 'elise.maes@northgate-cold.example', jobtitle: 'VP Operations', company: 'Northgate Cold Chain', associatedcompanyid: '503', hs_linkedin_url: 'https://www.linkedin.com/in/elise-maes-example' } },
    { id: '605', properties: { firstname: 'Ruben', lastname: 'Claes', email: 'ruben.claes@northgate-cold.example', jobtitle: 'Fleet Planner', company: 'Northgate Cold Chain', associatedcompanyid: '503' } },
    { id: '606', properties: { firstname: 'Li', lastname: 'Wong', email: 'li.wong@harborfreight.example', jobtitle: 'Operations Manager', company: 'Harbor Freight Co.', associatedcompanyid: '505' } },
  ]
  const deals: any[] = []
  const notes: any[] = []

  // ---------------- google drive (the onboarding tutorial) ----------------
  // The shared folder a new customer uploads their data into.
  let fileSeq = 0
  const files: any[] = [] // {id, name, mimeType, parents, createdTime, owners, size}
  const permissions: any[] = [] // {fileId, id, type, role, emailAddress}
  const FOLDER = 'application/vnd.google-apps.folder'

  // ---------------- what the API sent out (email, Slack, Telegram) ----------------
  const ext = outbox({
    team: { name: 'Lumen Labs', id: 'T0LUMEN' },
    users: { U0MAYA: { real_name: 'Maya Chen', email: ME.email } },
    channels: [{ id: 'C0SALES', name: 'sales' }],
    defaultChannel: 'D0MAYA',
    telegramBot: { id: 7000001, first_name: 'Elena assistant', username: 'elena_assistant_bot' },
  })

  const crm = (kind: string): any[] => ({ companies, contacts, deals, notes, '0-1': contacts, '0-2': companies, '0-3': deals } as Record<string, any[]>)[kind]
  const OBJ = '(companies|contacts|deals|notes|0-1|0-2|0-3)'

  const routes: Route[] = [
    // The scripted model (fakes/models/lumen.ts), with the wire details the published run views show.
    ...vendor({
      prefix: '/openai',
      models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'].map((id) => ({ id, created: 1715367049, owned_by: 'openai' })),
      decide,
      usage: (body, d) => ({
        prompt: Math.round(JSON.stringify(body.messages || []).length / 4) + 200,
        completion: Math.round(((d.content || '') + JSON.stringify(d.toolCalls || '')).length / 4) + 5,
      }),
      chunks: (c) => c.match(/[\s\S]{1,60}/g) || [c],
      completionId: 'chatcmpl-local',
      created: () => Math.floor(Date.now() / 1000),
      callId: (i) => `call_x_${Date.now() % 1e6}${i}`,
      embeddings: false,
    }),
    // Outbound channel traffic the redirect preload sends here (never sent for real).
    ...ext.routes,

    // ---------------- admin ----------------
    get('/_admin/state', () => json({ outbox: ext.sent, sent: mail.filter((x) => x.labels.includes('SENT')), drafts: mail.filter((x) => x.labels.includes('DRAFT')), deals, notes, contacts: contacts.slice(6), tasks, files, permissions, events })),
    // The deal for `company` is marked won in the CRM (what Maya does in HubSpot).
    post('/_admin/win', (req) => {
      const company = req.query.get('company') || 'Bluefin Couriers'
      let d = deals.find((x) => String(x.properties.dealname || '').startsWith(company))
      if (!d) { d = { id: String(++crmSeq), properties: { dealname: `${company}: Lumen Fleet`, pipeline: 'default', amount: '24000' }, createdAt: at(-20, 9) }; deals.push(d) }
      Object.assign(d.properties, { dealstage: 'closedwon', closedate: now().toISOString(), description: `Signed on ${now().toISOString().slice(0, 10)}: Lumen Fleet, 12 months.` })
      d.updatedAt = now().toISOString()
      return json(wrap(d))
    }),
    // The customer uploads their data into the shared folder.
    post('/_admin/upload', (req) => {
      const folder = files.filter((f) => f.mimeType === FOLDER && f.name.startsWith(req.query.get('company') || 'Bluefin Couriers')).pop()
      if (!folder) return json({ error: 'no shared folder yet' }, 404)
      const by = { emailAddress: 'jonas.weber@bluefin.example', displayName: 'Jonas Weber' }
      for (const [name, size] of [['Bluefin vehicles 2026.xlsx', '48213'], ['Depots.csv', '412']]) {
        files.push({ kind: 'drive#file', id: `1Bf${++fileSeq}xQ7`, name, mimeType: name.endsWith('.csv') ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parents: [folder.id], createdTime: now().toISOString(), owners: [by], lastModifyingUser: by, size })
      }
      return json({ files: files.filter((f) => f.parents?.includes(folder.id)) })
    }),
    post('/_admin/reply', (req) => {
      const body = req.body
      const last = mail.filter((x) => x.labels.includes('SENT') && x.to.toLowerCase().includes(String(body.to).toLowerCase())).pop()
      if (!last) return json({ error: 'nothing sent to ' + body.to }, 404)
      const c = contacts.find((x) => x.properties.email === body.to)
      const msg = addMail({ threadId: last.threadId, from: c ? `${c.properties.firstname} ${c.properties.lastname} <${body.to}>` : body.to, to: ME.email, subject: last.subject.startsWith('Re:') ? last.subject : `Re: ${last.subject}`, date: now().toISOString(), body: body.body || 'Thanks for reaching out. Happy to talk, does next Tuesday work?' })
      return json(msg)
    }),
    post('/_admin/move', (req) => {
      const e = events.find((x) => x.id === req.query.get('id'))
      if (!e) return json({ error: 'no such event' }, 404)
      const len = Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)
      const start = Date.now() + Number(req.query.get('inMinutes') || 40) * 60000
      e.start.dateTime = new Date(start).toISOString(); e.end.dateTime = new Date(start + len).toISOString()
      return json(e)
    }),
    post('/_admin/mail', (req) => json(addMail({ from: req.body.from, to: ME.email, subject: req.body.subject, body: req.body.body, date: now().toISOString() }))),
    post('/_admin/age', (req) => {
      const days = Number(req.query.get('days') || 4)
      for (const x of mail) if (x.labels.includes('SENT')) x.date = new Date(Date.parse(x.date) - days * DAY).toISOString()
      return json({ aged: days })
    }),

    // ---------------- oauth (a local stand-in for "Sign in with Google") ----------------
    any('/oauth/authorize', (req) => html(consent(req.url, ME.email))),
    any('/oauth/approve', (req) => {
      const back = new URL(req.query.get('redirect_uri') || '')
      back.searchParams.set('code', 'local-test-code'); if (req.query.get('state')) back.searchParams.set('state', req.query.get('state')!)
      return { status: 302, redirect: back.toString() }
    }),
    any('/oauth/token', () => json({ access_token: 'local-test-access-' + Date.now(), refresh_token: 'local-test-refresh', expires_in: 3600, token_type: 'Bearer', scope: 'all' })),
    any('/oauth/userinfo', () => json({ email: ME.email, name: ME.name, sub: '1' })),

    // ---------------- google calendar (base .../calendar/v3) ----------------
    // Push wakes: a notification channel is opened and closed, and lasts a week.
    post(/\/calendars\/([^/]+)\/events\/watch$/, (req, m) => json({ kind: 'api#channel', id: req.body.id, resourceId: 'local-resource-' + m[1], resourceUri: req.url.href, token: req.body.token, expiration: String(Date.now() + 7 * DAY) })),
    post(/\/channels\/stop$/, () => noContent()),
    get(/\/users\/me\/calendarList$/, () => json({ kind: 'calendar#calendarList', items: calendars })),
    get(/\/calendars\/([^/]+)\/events$/, (req, m) => {
      const cal = m[1] === 'primary' || m[1] === ME.email ? 'primary' : m[1]
      const tMin = Date.parse(req.query.get('timeMin') || '1970-01-01'), tMax = Date.parse(req.query.get('timeMax') || '2999-01-01')
      const q = (req.query.get('q') || '').toLowerCase()
      const items = events.filter((e) => e.calendarId === cal && Date.parse(e.end.dateTime) > tMin && Date.parse(e.start.dateTime) < tMax && (!q || JSON.stringify(e).toLowerCase().includes(q)))
        .sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))
      return json({ kind: 'calendar#events', summary: calendars.find((c) => c.id === cal)?.summary, timeZone: 'UTC', items, nextSyncToken: 'local-sync-' + events.length })
    }),
    any(/\/calendars\/([^/]+)\/events\/([^/]+)$/, (req, m) => {
      const e = events.find((x) => x.id === m[2])
      if (!e) return json({ error: { code: 404, message: 'Not Found' } }, 404)
      // patch/update: a moved meeting keeps its id, as in Google Calendar
      if (req.method === 'PATCH' || req.method === 'PUT') {
        for (const k of ['summary', 'description', 'location', 'start', 'end', 'attendees']) if (req.body?.[k] !== undefined) e[k] = req.body[k]
        e.updated = now().toISOString()
      }
      return json(e)
    }),
    post(/\/calendars\/([^/]+)\/events$/, (req, m) => {
      const e = { kind: 'calendar#event', id: `ev-${++crmSeq}`, calendarId: m[1] === ME.email ? 'primary' : m[1], status: 'confirmed', organizer: { email: ME.email }, htmlLink: `https://calendar.google.com/event?eid=${crmSeq}`, ...req.body }
      events.push(e)
      return json(e)
    }),
    post(/\/freeBusy$/, (req) => {
      const body = req.body
      const tMin = Date.parse(body.timeMin), tMax = Date.parse(body.timeMax)
      const cals: Record<string, unknown> = {}
      for (const { id } of body.items || []) {
        const cal = id === ME.email ? 'primary' : id
        cals[id] = { busy: events.filter((e) => e.calendarId === cal && Date.parse(e.end.dateTime) > tMin && Date.parse(e.start.dateTime) < tMax).map((e) => ({ start: e.start.dateTime, end: e.end.dateTime })) }
      }
      return json({ kind: 'calendar#freeBusy', timeMin: body.timeMin, timeMax: body.timeMax, calendars: cals })
    }),

    // ---------------- gmail ----------------
    // Push wakes: Gmail's watch and stop (the watch publishes nowhere; this stand-in only answers).
    post(/\/gmail\/v1\/users\/[^/]+\/watch$/, () => json({ historyId: '1000', expiration: String(Date.now() + 7 * DAY) })),
    post(/\/gmail\/v1\/users\/[^/]+\/stop$/, () => noContent()),
    any(/\/gmail\/v1\/users\/[^/]+\/history$/, () => json({ history: [], historyId: '1000' })),
    post(/\/gmail\/v1\/users\/[^/]+\/messages\/send$/, (req) => {
      const raw = unb64(req.body.raw || '')
      const h = (n: string) => (raw.match(new RegExp(`^${n}:\\s*(.*)$`, 'mi')) || [])[1] || ''
      const text = raw.split(/\r?\n\r?\n/).slice(1).join('\n\n') || raw
      const msg = addMail({ threadId: req.body.threadId, from: ME.email, to: h('To'), subject: h('Subject'), date: now().toISOString(), body: text, labels: ['SENT'] })
      return json({ id: msg.id, threadId: msg.threadId, labelIds: ['SENT'] })
    }),
    post(/\/gmail\/v1\/users\/[^/]+\/drafts$/, (req) => {
      const raw = unb64(req.body.message?.raw || '')
      const h = (n: string) => (raw.match(new RegExp(`^${n}:\\s*(.*)$`, 'mi')) || [])[1] || ''
      const msg = addMail({ from: ME.email, to: h('To'), subject: h('Subject'), date: now().toISOString(), body: raw.split(/\r?\n\r?\n/).slice(1).join('\n\n') || raw, labels: ['DRAFT'] })
      return json({ id: 'd' + msg.id, message: { id: msg.id, threadId: msg.threadId, labelIds: ['DRAFT'] } })
    }),
    any(/\/gmail\/v1\/users\/[^/]+\/messages$/, (req) => {
      const list = gmailFilter(mail, req.query.get('q')).slice(0, Number(req.query.get('maxResults') || 20))
      return json({ messages: list.map((x) => ({ id: x.id, threadId: x.threadId })), resultSizeEstimate: list.length })
    }),
    any(/\/gmail\/v1\/users\/[^/]+\/messages\/([^/]+)$/, (req, m) => {
      const x = mail.find((y) => y.id === m[1])
      return x ? json(gmailMsg(x, req.query.get('format'))) : json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404)
    }),
    any(/\/gmail\/v1\/users\/[^/]+\/threads$/, (req) => {
      const list = gmailFilter(mail, req.query.get('q'))
      const ids = [...new Set(list.map((x) => x.threadId))]
      return json({ threads: ids.map((id) => ({ id, snippet: mail.filter((x) => x.threadId === id).pop().body.slice(0, 100) })), resultSizeEstimate: ids.length })
    }),
    any(/\/gmail\/v1\/users\/[^/]+\/threads\/([^/]+)$/, (_req, m) => {
      const ms = mail.filter((x) => x.threadId === m[1])
      return ms.length ? json({ id: m[1], messages: ms.map((x) => gmailMsg(x)) }) : json({ error: { code: 404, message: 'Not Found' } }, 404)
    }),
    any(/\/gmail\/v1\/users\/[^/]+\/profile$/, () => json({ emailAddress: ME.email, messagesTotal: mail.length })),

    // ---------------- google tasks ----------------
    any(/\/tasks\/v1\/users\/@me\/lists$/, () => json({ kind: 'tasks#taskLists', items: taskLists })),
    any(/\/tasks\/v1\/lists\/([^/]+)\/tasks$/, (req, m) => {
      if (req.method === 'POST') { const t = { id: 't' + ++crmSeq, status: 'needsAction', ...req.body }; (tasks[m[1]] ||= []).push(t); return json(t) }
      const showDone = req.query.get('showCompleted') !== 'false'
      return json({ kind: 'tasks#tasks', items: (tasks[m[1]] || []).filter((t) => showDone || t.status !== 'completed') })
    }),

    // ---------------- hubspot ----------------
    post(new RegExp(`^/crm/v3/objects/${OBJ}/search$`), (req, m) => {
      const results = crm(m[1]).filter((o) => matchFilters(o, req.body)).slice(0, req.body.limit || 10).map(wrap)
      return json({ total: results.length, results })
    }),
    any(new RegExp(`^/crm/v3/objects/${OBJ}$`), (req, m) => {
      const src = crm(m[1])
      if (req.method === 'POST') { const o = { id: String(++crmSeq), properties: req.body.properties || {}, associations: req.body.associations, createdAt: now().toISOString() }; src.push(o); return json(wrap(o), 201) }
      return json({ results: src.slice(0, Number(req.query.get('limit') || 10)).map(wrap) })
    }),
    any(new RegExp(`^/crm/v3/objects/${OBJ}/([^/]+)$`), (req, m) => {
      const o = crm(m[1]).find((x) => x.id === m[2])
      if (!o) return json({ status: 'error', message: 'resource not found', category: 'OBJECT_NOT_FOUND' }, 404)
      if (req.method === 'PATCH') { Object.assign(o.properties, req.body.properties || {}); o.updatedAt = now().toISOString() }
      return json(wrap(o))
    }),

    // ---------------- google drive (base .../drive/v3) ----------------
    post(/\/drive\/v3\/files\/([^/]+)\/permissions$/, (req, m) => {
      if (!files.some((f) => f.id === m[1])) return json({ error: { code: 404, message: `File not found: ${m[1]}.` } }, 404)
      const perm = { kind: 'drive#permission', id: `perm${permissions.length + 1}`, fileId: m[1], type: req.body.type || 'user', role: req.body.role || 'writer', emailAddress: req.body.emailAddress }
      permissions.push(perm)
      return json(perm)
    }),
    any(/\/drive\/v3\/files\/([^/]+)\/permissions$/, (_req, m) => json({ kind: 'drive#permissionList', permissions: permissions.filter((x) => x.fileId === m[1]) })),
    post(/\/drive\/v3\/files$/, (req) => {
      const f: any = { kind: 'drive#file', id: `1Fo${++fileSeq}lDr`, name: req.body.name, mimeType: req.body.mimeType || 'application/octet-stream', parents: req.body.parents || ['root'], createdTime: now().toISOString(), owners: [{ emailAddress: ME.email, displayName: ME.name }] }
      f.webViewLink = `https://drive.google.com/drive/folders/${f.id}`
      files.push(f)
      return json(f)
    }),
    any(/\/drive\/v3\/files$/, (req) => json({ kind: 'drive#fileList', incompleteSearch: false, files: driveQuery(files, req.query.get('q')).map(({ parents, ...f }) => ({ ...f, parents })) })),
  ]
  return { name: 'lumen', routes }
}

// ---------------- helpers ----------------

const wrap = (o: any): any => ({ ...o, createdAt: o.createdAt || at(-30, 9), updatedAt: o.updatedAt || at(-1, 9), archived: false })

/** HubSpot's search filters: filterGroups (OR of ANDs) and a free-text query. */
export function matchFilters(obj: any, body: any): boolean {
  const groups = body?.filterGroups || []
  const q = (body?.query || '').toLowerCase()
  const props = obj.properties
  if (q && !Object.values(props).some((v) => String(v).toLowerCase().includes(q))) return false
  if (!groups.length) return true
  return groups.some((g: any) => (g.filters || []).every((f: any) => {
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
      case 'IN': return (f.values || []).map((x: unknown) => String(x).toLowerCase()).includes(String(v ?? '').toLowerCase())
      case 'HAS_PROPERTY': return v != null && v !== ''
      default: return true
    }
  }))
}

/** Enough of Drive's query language for the agent: name = '..', mimeType = '..', '<id>' in parents. */
export function driveQuery(files: any[], q: string | null): any[] {
  let list = files.slice()
  for (const [, k, v] of String(q || '').matchAll(/(name|mimeType)\s*=\s*'((?:[^'\\]|\\.)*)'/g)) list = list.filter((f) => f[k] === v.replace(/\\'/g, "'"))
  for (const [, id] of String(q || '').matchAll(/'([^']+)'\s+in\s+parents/g)) list = list.filter((f) => (f.parents || []).includes(id))
  return list
}

const b64url = (s: string) => Buffer.from(s).toString('base64url')
const unb64 = (s: string) => { try { return Buffer.from(s, 'base64url').toString('utf8') } catch { return '' } }
const header = (m: any) => [
  { name: 'From', value: m.from }, { name: 'To', value: m.to }, { name: 'Subject', value: m.subject }, { name: 'Date', value: new Date(m.date).toUTCString() },
]
const gmailMsg = (m: any, format?: string | null) => ({
  id: m.id, threadId: m.threadId, labelIds: m.labels, snippet: m.body.slice(0, 120), internalDate: String(Date.parse(m.date)),
  payload: format === 'minimal' ? undefined : { mimeType: 'text/plain', headers: header(m), body: { size: m.body.length, data: b64url(m.body) } },
})

/** Gmail's search: in:sent, (from:a OR to:b), from:/to:/subject:, newer_than:Nd and free words. */
export function gmailFilter(mail: any[], query: string | null): any[] {
  let q = (query || '').toLowerCase()
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

const consent = (u: URL, email: string) => `<!doctype html><html><head><title>Sign in (local test)</title><style>body{font-family:system-ui;background:#f4f4f5;display:flex;justify-content:center;padding-top:80px}main{background:#fff;padding:32px;border-radius:12px;width:420px;box-shadow:0 2px 12px #0002}button{background:#1a73e8;color:#fff;border:0;padding:10px 20px;border-radius:6px;font-size:15px}li{margin:6px 0}</style></head><body><main>
<h2>Local test sign-in</h2><p>This is the local stand-in for the provider's consent screen. A real Google sign-in asks the same thing.</p>
<p><b>almyty</b> wants to access <b>${email}</b>:</p><ul>${(u.searchParams.get('scope') || '').split(/[ +]/).filter(Boolean).map((s) => `<li>${s}</li>`).join('')}</ul>
<form method="get" action="/oauth/approve">${[...u.searchParams].map(([k, v]) => `<input type="hidden" name="${k}" value="${String(v).replace(/"/g, '&quot;')}">`).join('')}<button type="submit">Allow</button></form></main></body></html>`

