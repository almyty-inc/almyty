// A local stand-in for the services the engineering examples
// (docs-site/content/examples: issue triage, pull request review, on-call
// summaries, the old SOAP stock service) talk to, so their agents run end to
// end without anyone's real account: GitHub's REST API, PagerDuty's REST API,
// a legacy SOAP stock service of a made-up company, and a scripted
// OpenAI-compatible model (engineering-model.mjs). Paths match the real
// public APIs; only the host differs. Nothing here talks to the internet.
//
// Used by engineering-guides.mjs. State lives in memory: a restart starts fresh.
//
//   node engineering-upstream.mjs   listens on ENG_UPSTREAM_PORT (default 4292)
//   GET  /_admin/state              everything written so far (labels, comments, reviews, notes)
//   GET  /_admin/files              the pull request's new lines by number
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const PORT = Number(process.env.ENG_UPSTREAM_PORT || 4292)
const ORIGIN = `http://localhost:${PORT}`
const LOG = process.env.ENG_UPSTREAM_LOG || '/tmp/almyty-demo/eng-requests.log'
const MODEL_LOG = process.env.ENG_MODEL_LOG || '/tmp/almyty-demo/eng-model.log'
const MIN = 60000
const DAY = 86400000
const ago = (ms) => new Date(Date.now() - ms).toISOString()

// ---------------- GitHub: tidewater-labs/ledgerly ----------------
const OWNER = 'tidewater-labs', REPO = 'ledgerly'
const user = (login, id) => ({ login, id, type: 'User', html_url: `https://github.com/${login}`, avatar_url: `https://avatars.githubusercontent.com/u/${id}` })
const repoUrl = `https://github.com/${OWNER}/${REPO}`
const labelDefs = [
  ['bug', 'd73a4a', "Something isn't working"], ['feature', 'a2eeef', 'New feature or request'], ['question', 'd876e3', 'Further information is requested'],
  ['duplicate', 'cfd3d7', 'This issue or pull request already exists'], ['needs-repro', 'fbca04', 'Needs steps to reproduce'],
  ['area: pdf-export', '0e8a16', 'Invoice PDFs and printing'], ['area: payments', '1d76db', 'Payment providers, payouts, QR bills'],
  ['area: invoices', '5319e7', 'Creating and editing invoices'], ['area: mobile', 'c2e0c6', 'The iOS and Android apps'], ['core-team', '000000', 'Core team only'],
]
const labels = labelDefs.map(([name, color, description], i) => ({ id: 4100 + i, node_id: `LA_${i}`, url: `https://api.github.com/repos/${OWNER}/${REPO}/labels/${encodeURIComponent(name)}`, name, color, default: false, description }))
const L = (name) => labels.find((l) => l.name === name)
const issue = (number, title, body, login, uid, created, extra = {}) => ({
  id: 90000 + number, node_id: `I_${number}`, number, title, body, user: user(login, uid), labels: [], state: 'open', locked: false,
  assignee: null, assignees: [], comments: 0, created_at: created, updated_at: created, closed_at: null, author_association: 'NONE',
  html_url: `${repoUrl}/issues/${number}`, url: `https://api.github.com/repos/${OWNER}/${REPO}/issues/${number}`, repository_url: `https://api.github.com/repos/${OWNER}/${REPO}`, ...extra,
})
const issues = [
  issue(431, 'PDF export drops the last line item when an invoice has more than 20 lines',
    'When an invoice has 21 or more line items, the exported PDF ends after line 20. The total at the bottom is still right, so the PDF does not add up.\n\nSteps to reproduce:\n1. Create an invoice with 21 line items\n2. Click Export PDF\n3. Line 21 is missing\n\nLedgerly web 2026.10.2, Chrome 141.',
    'hana-sato', 7001, ago(9 * DAY), { labels: [L('bug'), L('area: pdf-export')], comments: 2, author_association: 'CONTRIBUTOR' }),
  issue(447, 'Pay invoices with a Swiss QR-bill', 'Our Swiss customers ask for a QR-bill on the invoice so they can pay from their banking app.', 'marco-bianchi', 7002, ago(5 * DAY), { labels: [L('feature'), L('area: payments')] }),
  issue(482, 'Invoice PDF missing the last row',
    'Exported an invoice for a client today and the PDF stops at row 20 of 24. Ledgerly says the total is 4,180.00 but the rows in the PDF only add up to 3,640.00. Our client noticed before we did.',
    'oliver-brandt', 7101, ago(7 * 3600000)),
  issue(483, 'Add Swiss QR-bill to invoices',
    'We invoice a lot of customers in Switzerland. They expect a QR-bill (the payment part with the QR code) at the bottom of the invoice. Could Ledgerly add one? We would need the IBAN and the reference number in it.',
    'claire-dubois', 7102, ago(5 * 3600000)),
  issue(484, 'App crashes', 'The app crashes sometimes. Please fix, this is really annoying.', 'jpark-dev', 7103, ago(3 * 3600000)),
  issue(485, 'How do I change the currency of an invoice I already sent?',
    'I sent an invoice in EUR but the client wants it in CHF. Can I change the currency on the existing invoice, or do I have to cancel it and create a new one?',
    'amira-haddad', 7104, ago(80 * MIN)),
  issue(486, 'Recurring invoices are created twice on the 1st of the month',
    'Since the 2026.10.2 update every recurring invoice that is due on the 1st was created twice for us (Oct 1). Invoices INV-2210 and INV-2211 are the same, so are INV-2212 and INV-2213.\n\nSteps to reproduce:\n1. Create a recurring invoice, monthly, on the 1st\n2. Wait for the 1st\n3. Two invoices are created\n\nWe are on the web app, account ID 88412.',
    'lukas-meier', 7105, ago(40 * MIN)),
]
const comments = { 431: [
  { id: 6001, user: user('ines-duarte', 7201), body: 'Confirmed: the page break logic stops after the first page. Looking into it.', created_at: ago(8 * DAY), author_association: 'MEMBER' },
] }
const written = { labels: [], comments: [], reviews: [], pdNotes: [], stockReservations: [] }

// A made-up key in the shape of a live Stripe one, for the review to catch.
// Put together here so secret scanners do not take this file for a real leak.
const FAKE_LIVE_KEY = ['sk', 'live', '51Nq8TidewaterXk2LmQ9vR4tY7uI0pA3sD6fG8hJ'].join('_')
// One pull request, with a diff worth a first pass.
const PR_FILES = [
  { filename: 'src/billing/late-fees.ts', status: 'added', additions: 31, deletions: 0, changes: 31, patch: `@@ -0,0 +1,31 @@
+import moment from 'moment'
+import { Invoice } from '../invoices/types'
+
+// Late fee: 1.5% of the open amount for every started month overdue.
+export const LATE_FEE_RATE = 0.015
+
+export function monthsOverdue(invoice: Invoice, today = new Date()): number {
+  const due = moment(invoice.dueDate)
+  const days = moment(today).diff(due, 'days')
+  return Math.floor(days / 30)
+}
+
+export function lateFee(invoice: Invoice, today = new Date()): number {
+  const months = monthsOverdue(invoice, today)
+  if (months <= 0) return 0
+  return invoice.openAmount * LATE_FEE_RATE * months
+}
+
+export async function applyLateFees(invoices: Invoice[], db: Db) {
+  for (const invoice of invoices) {
+    const fee = lateFee(invoice)
+    if (fee > 0) {
+      await db.invoices.update(invoice.id, {
+        openAmount: invoice.openAmount + fee,
+        lateFee: fee,
+      })
+    }
+  }
+}
+
+export default applyLateFees` },
  { filename: 'src/billing/jobs.ts', status: 'modified', additions: 6, deletions: 0, changes: 6, patch: `@@ -12,6 +12,12 @@ export const jobs = [
   { name: 'send-reminders', cron: '0 8 * * *', run: sendReminders },
   { name: 'sync-payouts', cron: '*/30 * * * *', run: syncPayouts },
+  {
+    name: 'apply-late-fees',
+    cron: '0 2 * * *',
+    run: (db) => db.invoices.overdue().then((list) => applyLateFees(list, db)),
+  },
 ]` },
  { filename: 'config/payments.ts', status: 'modified', additions: 2, deletions: 1, changes: 3, patch: `@@ -1,5 +1,6 @@
 export const payments = {
-  stripeKey: process.env.STRIPE_SECRET_KEY,
+  stripeKey: process.env.STRIPE_SECRET_KEY || '${FAKE_LIVE_KEY}',
+  lateFeesEnabled: true,
   currency: 'EUR',
 }` },
  { filename: 'package.json', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: `@@ -18,6 +18,7 @@
     "pdfkit": "^0.15.0",
+    "moment": "^2.30.1",
     "zod": "^3.23.8"` },
]
const PR = {
  id: 2120001, number: 212, state: 'open', title: 'Add late fees to overdue invoices', user: user('kai-nakamura', 7203), draft: false,
  body: 'Charges a 1.5% late fee per month on overdue invoices, applied by a nightly job.\n\nCloses #398.',
  head: { ref: 'feature/late-fees', sha: '9f3c2a1e7b4d', label: 'tidewater-labs:feature/late-fees' }, base: { ref: 'main', sha: '41aa07c2d9e0', label: 'tidewater-labs:main' },
  created_at: ago(50 * MIN), updated_at: ago(45 * MIN), additions: 40, deletions: 1, changed_files: 4, commits: 3, comments: 0, review_comments: 0, mergeable: true,
  html_url: `${repoUrl}/pull/212`, url: `https://api.github.com/repos/${OWNER}/${REPO}/pulls/212`, requested_reviewers: [user('ines-duarte', 7201)],
}

function searchIssues(q) {
  q = String(q || '').toLowerCase()
  const free = q.replace(/(repo|is|state|label|in|type):\S+/g, ' ').split(/\s+/).filter(Boolean)
  return issues.filter((i) => free.every((w) => `${i.title} ${i.body}`.toLowerCase().includes(w)))
}

// ---------------- PagerDuty ----------------
const SERVICE = { id: 'PLDG3RA', type: 'service', summary: 'Ledgerly API', name: 'Ledgerly API', html_url: 'https://tidewater.pagerduty.com/service-directory/PLDG3RA',
  description: 'Public REST API behind app.ledgerly.example. Runbook: https://wiki.tidewater.example/runbooks/ledgerly-api' }
const person = (id, name, email) => ({ id, type: 'user_reference', summary: name, email })
const incidents = [
  { id: 'Q2KF8NXJ1T', incident_number: 1187, title: '[Datadog] 5xx rate on ledgerly-api above 5% (checkout)', status: 'triggered', urgency: 'high',
    created_at: ago(4 * MIN), service: SERVICE, assignments: [{ assignee: person('PUSAM01', 'Sam Okafor', 'sam.okafor@tidewater.example') }],
    html_url: 'https://tidewater.pagerduty.com/incidents/Q2KF8NXJ1T', escalation_policy: { id: 'PESC01', summary: 'Ledgerly API on-call' },
    body: { details: { monitor: '5xx rate on ledgerly-api', query: 'sum(last_5m):sum:trace.http.request.errors{service:ledgerly-api,env:prod}.as_count() / sum:trace.http.request.hits{service:ledgerly-api,env:prod}.as_count() > 0.05',
      value: '7.8%', threshold: '5%', top_endpoints: 'POST /v1/checkout/sessions (91% of errors), POST /v1/invoices/{id}/pay',
      error_sample: 'TimeoutError: ResourceRequest timed out (pool: pg, max: 20, waiting: 63)', version: '2026.10.3', deployed: ago(19 * MIN),
      dashboard: 'https://app.datadoghq.eu/dashboard/lgy-api-prod' } } },
  { id: 'Q0W7M4BC2D', incident_number: 1149, title: '[Datadog] 5xx rate on ledgerly-api above 5% (checkout)', status: 'resolved', urgency: 'high',
    created_at: ago(23 * DAY), resolved_at: ago(23 * DAY - 38 * MIN), service: SERVICE, assignments: [], html_url: 'https://tidewater.pagerduty.com/incidents/Q0W7M4BC2D',
    body: { details: { value: '9.1%', error_sample: 'TimeoutError: ResourceRequest timed out (pool: pg, max: 20, waiting: 48)', version: '2026.9.4' } } },
  { id: 'Q9Z1R5TY8E', incident_number: 1102, title: '[Datadog] p95 latency on ledgerly-api above 2s', status: 'resolved', urgency: 'low',
    created_at: ago(41 * DAY), resolved_at: ago(41 * DAY - 15 * MIN), service: SERVICE, assignments: [], html_url: 'https://tidewater.pagerduty.com/incidents/Q9Z1R5TY8E', body: { details: { value: '2.4s' } } },
]
const pdNotes = {
  Q0W7M4BC2D: [{ id: 'PNOTE1', user: person('PUINE01', 'Ines Duarte', 'ines.duarte@tidewater.example'), created_at: ago(23 * DAY - 40 * MIN),
    content: 'Cause: 2026.9.4 opened a second Postgres connection per checkout request, so the pool (max 20) ran dry under load. Fix: rolled back to 2026.9.3, then raised DB_POOL_MAX to 40 and fixed the double connection in 2026.9.5.' }],
  Q9Z1R5TY8E: [{ id: 'PNOTE2', user: person('PUSAM01', 'Sam Okafor', 'sam.okafor@tidewater.example'), created_at: ago(41 * DAY - 16 * MIN), content: 'Slow report query, added an index. Not related to checkout.' }],
}
const logEntries = (inc) => [
  { id: 'R1', type: 'trigger_log_entry', summary: 'Triggered through the Datadog integration', created_at: inc.created_at, channel: { type: 'api', details: inc.body?.details } },
  { id: 'R2', type: 'notify_log_entry', summary: 'Notified Sam Okafor by push notification and phone call', created_at: inc.created_at },
]
const pdIncident = (i) => { const { body, ...rest } = i; return { ...rest, type: 'incident', summary: `[#${i.incident_number}] ${i.title}`, body: body ? { type: 'incident_body', details: JSON.stringify(body.details) } : undefined } }

// ---------------- the old SOAP stock service (Harbor Supply, made up) ----------------
const STOCK = {
  'HS-10442': { sku: 'HS-10442', name: 'Pallet wrap, 500 mm x 300 m', warehouses: { RTM: 1840, ANR: 320, HAM: 0 } },
  'HS-20817': { sku: 'HS-20817', name: 'Euro pallet, heat treated', warehouses: { RTM: 96, ANR: 410, HAM: 75 } },
  'HS-31005': { sku: 'HS-31005', name: 'Strapping band, PET 16 mm', warehouses: { RTM: 0, ANR: 0, HAM: 12 } },
}
const WAREHOUSES = [['RTM', 'Rotterdam'], ['ANR', 'Antwerp'], ['HAM', 'Hamburg']]
const NS = 'http://harborsupply.example/stock/2009'
const WSDL = () => `<?xml version="1.0" encoding="utf-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:xs="http://www.w3.org/2001/XMLSchema"
  xmlns:tns="${NS}" targetNamespace="${NS}" name="StockService">
  <wsdl:documentation>Harbor Supply stock system (StockService 3.2, 2009). Stock levels and reservations per warehouse.</wsdl:documentation>
  <wsdl:types>
    <xs:schema targetNamespace="${NS}" elementFormDefault="qualified">
      <xs:element name="GetStockLevel"><xs:complexType><xs:sequence>
        <xs:element name="Sku" type="xs:string"/><xs:element name="WarehouseCode" type="xs:string" minOccurs="0"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="GetStockLevelResponse"><xs:complexType><xs:sequence>
        <xs:element name="Sku" type="xs:string"/><xs:element name="Description" type="xs:string"/>
        <xs:element name="Level" minOccurs="0" maxOccurs="unbounded"><xs:complexType><xs:sequence>
          <xs:element name="WarehouseCode" type="xs:string"/><xs:element name="OnHand" type="xs:int"/>
        </xs:sequence></xs:complexType></xs:element>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="ReserveStock"><xs:complexType><xs:sequence>
        <xs:element name="Sku" type="xs:string"/><xs:element name="WarehouseCode" type="xs:string"/>
        <xs:element name="Quantity" type="xs:int"/><xs:element name="OrderReference" type="xs:string"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="ReserveStockResponse"><xs:complexType><xs:sequence>
        <xs:element name="ReservationId" type="xs:string"/><xs:element name="Status" type="xs:string"/><xs:element name="RemainingOnHand" type="xs:int"/>
      </xs:sequence></xs:complexType></xs:element>
      <xs:element name="ListWarehouses"><xs:complexType><xs:sequence/></xs:complexType></xs:element>
      <xs:element name="ListWarehousesResponse"><xs:complexType><xs:sequence>
        <xs:element name="Warehouse" maxOccurs="unbounded"><xs:complexType><xs:sequence>
          <xs:element name="Code" type="xs:string"/><xs:element name="City" type="xs:string"/>
        </xs:sequence></xs:complexType></xs:element>
      </xs:sequence></xs:complexType></xs:element>
    </xs:schema>
  </wsdl:types>
  ${['GetStockLevel', 'ReserveStock', 'ListWarehouses'].map((op) => `<wsdl:message name="${op}SoapIn"><wsdl:part name="parameters" element="tns:${op}"/></wsdl:message>
  <wsdl:message name="${op}SoapOut"><wsdl:part name="parameters" element="tns:${op}Response"/></wsdl:message>`).join('\n  ')}
  <wsdl:portType name="StockServiceSoap">
    <wsdl:operation name="GetStockLevel"><wsdl:documentation>Units on hand for an article, per warehouse.</wsdl:documentation><wsdl:input message="tns:GetStockLevelSoapIn"/><wsdl:output message="tns:GetStockLevelSoapOut"/></wsdl:operation>
    <wsdl:operation name="ReserveStock"><wsdl:documentation>Reserve units of an article in one warehouse for an order.</wsdl:documentation><wsdl:input message="tns:ReserveStockSoapIn"/><wsdl:output message="tns:ReserveStockSoapOut"/></wsdl:operation>
    <wsdl:operation name="ListWarehouses"><wsdl:documentation>The warehouses and their codes.</wsdl:documentation><wsdl:input message="tns:ListWarehousesSoapIn"/><wsdl:output message="tns:ListWarehousesSoapOut"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="StockServiceSoap" type="tns:StockServiceSoap">
    <soap:binding transport="http://schemas.xmlsoap.org/soap/http"/>
    ${['GetStockLevel', 'ReserveStock', 'ListWarehouses'].map((op) => `<wsdl:operation name="${op}"><soap:operation soapAction="${NS}/${op}" style="document"/><wsdl:input><soap:body use="literal"/></wsdl:input><wsdl:output><soap:body use="literal"/></wsdl:output></wsdl:operation>`).join('\n    ')}
  </wsdl:binding>
  <wsdl:service name="StockService">
    <wsdl:port name="StockServiceSoap" binding="tns:StockServiceSoap"><soap:address location="${ORIGIN}/StockService.asmx"/></wsdl:port>
  </wsdl:service>
</wsdl:definitions>`
const envelope = (inner) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`
const fault = (msg) => envelope(`<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${msg}</faultstring></soap:Fault>`)
const tag = (xml, name) => (xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`)) || [])[1]
let reservationSeq = 70410
function soap(xml, auth) {
  if (!auth || !auth.startsWith('Basic ') || Buffer.from(auth.slice(6), 'base64').toString() !== 'svc-almyty:Harbor-2009!') return [500, fault('Access denied: unknown user or wrong password')]
  if (/GetStockLevel/.test(xml)) {
    const sku = tag(xml, 'Sku'), wh = tag(xml, 'WarehouseCode')
    const s = STOCK[sku]; if (!s) return [500, fault(`Unknown article ${sku}`)]
    const levels = Object.entries(s.warehouses).filter(([c]) => !wh || c === wh)
    return [200, envelope(`<GetStockLevelResponse xmlns="${NS}"><Sku>${sku}</Sku><Description>${s.name}</Description>${levels.map(([c, n]) => `<Level><WarehouseCode>${c}</WarehouseCode><OnHand>${n}</OnHand></Level>`).join('')}</GetStockLevelResponse>`)]
  }
  if (/ReserveStock/.test(xml)) {
    const sku = tag(xml, 'Sku'), wh = tag(xml, 'WarehouseCode'), qty = Number(tag(xml, 'Quantity')), ref = tag(xml, 'OrderReference')
    const s = STOCK[sku]; if (!s) return [500, fault(`Unknown article ${sku}`)]
    if (!(wh in s.warehouses)) return [500, fault(`Unknown warehouse ${wh}`)]
    if (s.warehouses[wh] < qty) return [500, fault(`Not enough stock: ${s.warehouses[wh]} on hand in ${wh}`)]
    s.warehouses[wh] -= qty
    const id = `RSV-${++reservationSeq}`
    written.stockReservations.push({ id, sku, wh, qty, ref })
    return [200, envelope(`<ReserveStockResponse xmlns="${NS}"><ReservationId>${id}</ReservationId><Status>RESERVED</Status><RemainingOnHand>${s.warehouses[wh]}</RemainingOnHand></ReserveStockResponse>`)]
  }
  if (/ListWarehouses/.test(xml)) return [200, envelope(`<ListWarehousesResponse xmlns="${NS}">${WAREHOUSES.map(([c, n]) => `<Warehouse><Code>${c}</Code><City>${n}</City></Warehouse>`).join('')}</ListWarehousesResponse>`)]
  return [500, fault('Unknown operation')]
}

// ---------------- helpers ----------------
const send = (res, status, body, type) => {
  const isStr = typeof body === 'string'
  res.writeHead(status, { 'content-type': type || (isStr ? 'text/plain; charset=utf-8' : 'application/json') })
  res.end(isStr ? body : JSON.stringify(body))
}
const readRaw = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)) })
const json = (s) => { try { return s ? JSON.parse(s) : {} } catch { return { _raw: s } } }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, ORIGIN)
  const p = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/'
  const raw = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readRaw(req) : ''
  const body = json(raw)
  appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${u.pathname}${u.search} auth=${req.headers.authorization ? req.headers.authorization.slice(0, 16) + '...' : 'none'} ${raw.slice(0, 300)}\n`)
  let m
  try {
    if (p === '/health') return send(res, 200, { ok: true })
    if (p === '/_admin/files') {
      // Each file's new lines by number, for showing a review next to the code.
      const out = {}
      for (const f of PR_FILES) {
        let line = 0; out[f.filename] = {}
        for (const l of f.patch.split('\n')) {
          const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
          if (h) { line = Number(h[1]); continue }
          if (l.startsWith('-')) continue
          out[f.filename][line++] = l.slice(1)
        }
      }
      return send(res, 200, out)
    }
    if (p === '/_admin/state') return send(res, 200, { ...written, issues: issues.map((i) => ({ number: i.number, labels: i.labels.map((l) => l.name), comments: (comments[i.number] || []).length })) })

    // ---- scripted model, OpenAI-compatible, one prefix per vendor
    if ((m = p.match(/^\/(openai|mistral)\/v1\/models$/))) {
      const ids = m[1] === 'openai' ? ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'] : ['mistral-large-latest', 'mistral-small-latest']
      return send(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 1744316542, owned_by: m[1] })) })
    }
    if ((m = p.match(/^\/(openai|mistral)\/v1\/chat\/completions$/)) && req.method === 'POST') {
      const { decide } = await import(`./engineering-model.mjs?t=${Date.now()}`)
      const d = await decide(body, { log: MODEL_LOG })
      const model = body.model || 'gpt-4.1'
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

    // ---- SOAP
    if (p === '/StockService.asmx' && req.method === 'GET') return send(res, 200, WSDL(), 'text/xml; charset=utf-8')
    if (p === '/StockService.asmx' && req.method === 'POST') { const [s, x] = soap(raw, req.headers.authorization); return send(res, s, x, 'text/xml; charset=utf-8') }

    // ---- GitHub and PagerDuty refuse a call without their key, as the real ones do
    const auth = req.headers.authorization || ''
    if ((p.startsWith('/repos/') || p === '/search/issues') && !/^Bearer github_pat_/.test(auth)) return send(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' })
    if ((p.startsWith('/incidents') || p.startsWith('/services')) && !/^Token token=\S+/.test(auth)) return send(res, 401, { error: { message: 'Unauthorized', code: 2006 } })

    // ---- GitHub
    const repoBase = `/repos/${OWNER}/${REPO}`
    if (p.startsWith('/repos/') && !p.startsWith(repoBase)) return send(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' })
    if (p === `${repoBase}/labels`) return send(res, 200, labels)
    if (p === `${repoBase}/issues` && req.method === 'GET') {
      const since = Date.parse(u.searchParams.get('since') || '1970-01-01')
      const state = u.searchParams.get('state') || 'open'
      const want = (u.searchParams.get('labels') || '').split(',').filter(Boolean)
      let list = issues.filter((i) => (state === 'all' || i.state === state) && Date.parse(i.updated_at) >= since && want.every((w) => i.labels.some((l) => l.name === w)))
      if (u.searchParams.get('sort') !== 'updated' && u.searchParams.get('direction') === 'asc') list = list.slice().sort((a, b) => a.number - b.number)
      else list = list.slice().sort((a, b) => b.number - a.number)
      return send(res, 200, list.slice(0, Number(u.searchParams.get('per_page') || 30)))
    }
    if ((m = p.match(new RegExp(`^${repoBase}/issues/(\\d+)$`)))) {
      const i = issues.find((x) => x.number === Number(m[1])); return i ? send(res, 200, i) : send(res, 404, { message: 'Not Found' })
    }
    if ((m = p.match(new RegExp(`^${repoBase}/issues/(\\d+)/labels$`))) && req.method === 'POST') {
      const i = issues.find((x) => x.number === Number(m[1])); if (!i) return send(res, 404, { message: 'Not Found' })
      const names = Array.isArray(body) ? body : Array.isArray(body.labels) ? body.labels.map((l) => (typeof l === 'string' ? l : l.name)) : []
      const unknown = names.filter((n) => !L(n))
      if (unknown.length) return send(res, 422, { message: 'Validation Failed', errors: unknown.map((n) => ({ resource: 'Label', code: 'invalid', field: 'name', value: n })) })
      for (const n of names) if (!i.labels.some((l) => l.name === n)) i.labels.push(L(n))
      written.labels.push({ issue: i.number, labels: names })
      return send(res, 200, i.labels)
    }
    if ((m = p.match(new RegExp(`^${repoBase}/issues/(\\d+)/comments$`)))) {
      const n = Number(m[1]); const i = issues.find((x) => x.number === n); if (!i) return send(res, 404, { message: 'Not Found' })
      if (req.method === 'POST') {
        const c = { id: 6100 + written.comments.length, user: user('ledgerly-triage[bot]', 9900), body: body.body, created_at: new Date().toISOString(), author_association: 'NONE', html_url: `${repoUrl}/issues/${n}#issuecomment-${6100 + written.comments.length}` }
        ;(comments[n] ||= []).push(c); i.comments++; written.comments.push({ issue: n, body: body.body }); return send(res, 201, c)
      }
      return send(res, 200, comments[n] || [])
    }
    if (p === '/search/issues') {
      const items = searchIssues(u.searchParams.get('q'))
      return send(res, 200, { total_count: items.length, incomplete_results: false, items })
    }
    if (p === `${repoBase}/pulls`) return send(res, 200, [PR])
    if (p === `${repoBase}/pulls/212`) return send(res, 200, PR)
    if (p === `${repoBase}/pulls/212/files`) return send(res, 200, PR_FILES.map((f, i) => ({ sha: `f${i}`, ...f })))
    if (p === `${repoBase}/pulls/212/reviews`) {
      if (req.method === 'POST') {
        if (body.event && body.event !== 'COMMENT') return send(res, 422, { message: `This token may not ${String(body.event).toLowerCase().replace('_', ' ')} pull requests.` })
        const r = { id: 88001 + written.reviews.length, user: user('ledgerly-review[bot]', 9901), body: body.body, state: 'COMMENTED', commit_id: PR.head.sha, submitted_at: new Date().toISOString(), html_url: `${repoUrl}/pull/212#pullrequestreview-${88001 + written.reviews.length}`, comments: body.comments || [] }
        written.reviews.push(r); return send(res, 200, r)
      }
      return send(res, 200, written.reviews)
    }

    // ---- PagerDuty
    if (p === '/incidents' && req.method === 'GET') {
      const statuses = u.searchParams.getAll('statuses[]').concat(u.searchParams.getAll('statuses'))
      const services = u.searchParams.getAll('service_ids[]').concat(u.searchParams.getAll('service_ids'))
      const since = Date.parse(u.searchParams.get('since') || '1970-01-01')
      const list = incidents.filter((i) => (!statuses.length || statuses.includes(i.status)) && (!services.length || services.includes(i.service.id)) && Date.parse(i.created_at) >= since)
      return send(res, 200, { incidents: list.map(pdIncident), limit: 25, offset: 0, more: false, total: null })
    }
    if ((m = p.match(/^\/incidents\/([A-Z0-9]+)$/))) {
      const i = incidents.find((x) => x.id === m[1]); return i ? send(res, 200, { incident: pdIncident(i) }) : send(res, 404, { error: { message: 'Not Found', code: 2100 } })
    }
    if ((m = p.match(/^\/incidents\/([A-Z0-9]+)\/alerts$/))) {
      const i = incidents.find((x) => x.id === m[1]); if (!i) return send(res, 404, { error: { message: 'Not Found', code: 2100 } })
      return send(res, 200, { alerts: [{ id: `A${i.id}`, type: 'alert', summary: i.title, status: i.status === 'resolved' ? 'resolved' : 'triggered', created_at: i.created_at, body: { type: 'alert_body', details: i.body?.details || {} } }] })
    }
    if ((m = p.match(/^\/incidents\/([A-Z0-9]+)\/log_entries$/))) {
      const i = incidents.find((x) => x.id === m[1]); return i ? send(res, 200, { log_entries: logEntries(i) }) : send(res, 404, { error: { message: 'Not Found', code: 2100 } })
    }
    if ((m = p.match(/^\/incidents\/([A-Z0-9]+)\/notes$/))) {
      const i = incidents.find((x) => x.id === m[1]); if (!i) return send(res, 404, { error: { message: 'Not Found', code: 2100 } })
      if (req.method === 'POST') {
        const from = req.headers.from
        if (!from) return send(res, 400, { error: { message: 'You must specify a user\'s email address in the "From" header to perform this action', code: 2008 } })
        const note = { id: `PNOTE${9 + written.pdNotes.length}`, user: person('PUBOT01', 'Ledgerly on-call assistant', from), content: body?.note?.content, created_at: new Date().toISOString() }
        ;(pdNotes[i.id] ||= []).push(note); written.pdNotes.push({ incident: i.id, from, content: note.content }); return send(res, 201, { note })
      }
      return send(res, 200, { notes: pdNotes[i.id] || [] })
    }
    if ((m = p.match(/^\/services\/([A-Z0-9]+)$/))) return m[1] === SERVICE.id ? send(res, 200, { service: SERVICE }) : send(res, 404, { error: { message: 'Not Found', code: 2100 } })

    return send(res, 404, { error: 'not found in the local stand-in', path: p })
  } catch (e) {
    return send(res, 500, { error: String(e?.stack || e) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`engineering stand-in on ${ORIGIN}`))
const server6 = http.createServer((req, res) => server.emit('request', req, res))
server6.listen(PORT, '::1')
