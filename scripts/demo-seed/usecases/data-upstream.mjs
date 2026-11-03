// A local stand-in for Stripe, Xero, BigQuery and Slack, plus scripted
// OpenAI-compatible and Mistral models (data-model.mjs), for the data and
// finance example guides in docs-site/content/examples. Paths match the real
// public APIs; only the host differs. Nothing here talks to the internet.
//
// The company is Larkspur Home (made up): an online homeware shop in
// Amsterdam that sells across Europe, the UK and the US.
//
//   node data-upstream.mjs         listens on USECASE_PORT (default 4293)
//   GET  /_admin/state             everything posted so far
//   POST /_admin/reset             forget the outbox
//
// BigQuery queries really run: the tables live in an in-memory SQLite
// database (node:sqlite) and the few BigQuery functions the guides use are
// translated, so every number an answer gives was computed from the rows.
import http from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = Number(process.env.USECASE_PORT || 4293)
const LOG = process.env.USECASE_LOG || '/tmp/almyty-demo/data-requests.log'
const DAY = 86400000
const today0 = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d.getTime() }
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10)

// A deterministic random source, so every start has the same rows.
let seed = 20261022
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const cents = (n) => Math.round(n)

// ---------------- Stripe (base https://api.stripe.com) ----------------
// Larkspur Home keeps EUR, GBP and USD balances, so Stripe pays out once a
// day per currency, each to its own bank account.
const Y = today0() - DAY
const yTs = Math.floor(Y / 1000)
const ACCT = 'acct_1LarkspurHome01'
const payoutSpecs = [
  { id: 'po_1QLk7mF4aRhG2xYzEUR0921', currency: 'eur', bank: 'ING Business (EUR)', bankLast4: '4417', charges: 41, refunds: [{ amount: 148000, order: 'LH-20931', reason: 'requested_by_customer' }, { amount: 6450, order: 'LH-21107', reason: 'duplicate' }], target: 1824055 },
  { id: 'po_1QLk7nF4aRhG2xYzGBP0921', currency: 'gbp', bank: 'Wise Business (GBP)', bankLast4: '7730', charges: 19, refunds: [], target: 691210 },
  { id: 'po_1QLk7oF4aRhG2xYzUSD0921', currency: 'usd', bank: 'Wise Business (USD)', bankLast4: '2268', charges: 8, refunds: [], target: 231000 },
]
const balanceTxns = []
const payouts = []
let btSeq = 0
for (const p of payoutSpecs) {
  const txns = []
  const refundTotal = p.refunds.reduce((s, r) => s + r.amount, 0)
  // charges whose net (amount - fee) sums with the refunds to exactly the payout
  const wantNet = p.target + refundTotal
  const raw = Array.from({ length: p.charges }, () => 2500 + Math.floor(rnd() * 60000))
  const rawSum = raw.reduce((a, b) => a + b, 0)
  let amounts = raw.map((a) => Math.round(a * (wantNet / 0.97) / rawSum))
  const fees = amounts.map((a) => Math.round(a * 0.015) + 25)
  // fix rounding on the last charge
  const net = () => amounts.reduce((s, a, i) => s + a - fees[i], 0)
  amounts[amounts.length - 1] += wantNet - net()
  fees[fees.length - 1] = fees[fees.length - 1]
  amounts.forEach((a, i) => {
    const id = `txn_3QL${String(++btSeq).padStart(4, '0')}F4aRhG2xYz`
    txns.push({ id, object: 'balance_transaction', amount: a, currency: p.currency, fee: fees[i], net: a - fees[i], type: 'charge', reporting_category: 'charge', status: 'available', source: `ch_3QL${String(btSeq).padStart(4, '0')}F4aRhG2xYz`, description: `Order LH-${20800 + btSeq}`, created: yTs - 2 * 86400 + i * 1800, available_on: yTs, fee_details: [{ amount: fees[i], currency: p.currency, description: 'Stripe processing fees', type: 'stripe_fee' }] })
  })
  for (const r of p.refunds) {
    const id = `txn_3QR${String(++btSeq).padStart(4, '0')}F4aRhG2xYz`
    txns.push({ id, object: 'balance_transaction', amount: -r.amount, currency: p.currency, fee: 0, net: -r.amount, type: 'refund', reporting_category: 'refund', status: 'available', source: `re_3QR${String(btSeq).padStart(4, '0')}F4aRhG2xYz`, description: `Refund for order ${r.order} (${r.reason.replace(/_/g, ' ')})`, created: yTs - 86400 + 3600 * 3, available_on: yTs, fee_details: [] })
  }
  const total = txns.reduce((s, t) => s + t.net, 0)
  const payoutTxn = { id: `txn_1QP${String(++btSeq).padStart(4, '0')}F4aRhG2xYz`, object: 'balance_transaction', amount: -total, currency: p.currency, fee: 0, net: -total, type: 'payout', reporting_category: 'payout', status: 'available', source: p.id, description: 'STRIPE PAYOUT', created: yTs - 86400, available_on: yTs, fee_details: [] }
  for (const t of txns) balanceTxns.push({ ...t, payout: p.id })
  balanceTxns.push({ ...payoutTxn, payout: null })
  payouts.push({ id: p.id, object: 'payout', amount: total, arrival_date: yTs, automatic: true, balance_transaction: payoutTxn.id, created: yTs - 86400, currency: p.currency, description: 'STRIPE PAYOUT', destination: `ba_1Lark${p.bankLast4}Bank`, livemode: true, metadata: {}, method: 'standard', reconciliation_status: 'completed', source_type: 'card', statement_descriptor: null, status: 'paid', type: 'bank_account', _bank: p.bank })
}
// Older payouts, all booked in Xero, so a run that asks for more than one day still sees history.
for (let d = 2; d <= 6; d++) {
  for (const [cur, base] of [['eur', 1600000], ['gbp', 600000], ['usd', 200000]]) {
    const amount = base + Math.floor(rnd() * base * 0.3)
    payouts.push({ id: `po_1QK${d}${cur.toUpperCase()}F4aRhG2xYz`, object: 'payout', amount, arrival_date: Math.floor((today0() - d * DAY) / 1000), automatic: true, created: Math.floor((today0() - (d + 1) * DAY) / 1000), currency: cur, description: 'STRIPE PAYOUT', livemode: true, metadata: {}, method: 'standard', status: 'paid', type: 'bank_account' })
  }
}
const publicPayout = ({ _bank, ...p }) => p

function rangeOf(params, key) {
  // arrival_date=123, arrival_date[gte]=123 (deepObject) or arrival_date={"gte":..} (a tool that sent JSON)
  const out = {}
  for (const [k, v] of params) {
    const m = k.match(new RegExp(`^${key}(?:\\[(gt|gte|lt|lte)\\])?$`))
    if (!m) continue
    if (m[1]) out[m[1]] = Number(v)
    else {
      try { const o = JSON.parse(v); if (o && typeof o === 'object') Object.assign(out, Object.fromEntries(Object.entries(o).map(([a, b]) => [a, Number(b)]))); else out.eq = Number(v) } catch { out.eq = Number(v) }
    }
  }
  return out
}
const inRange = (v, r) => (r.eq == null || v === r.eq) && (r.gt == null || v > r.gt) && (r.gte == null || v >= r.gte) && (r.lt == null || v < r.lt) && (r.lte == null || v <= r.lte)
const list = (url, data) => ({ object: 'list', data, has_more: false, url })

// ---------------- Xero (base https://api.xero.com/api.xro/2.0) ----------------
const TENANT = '7a3c51e2-0d4b-4c7e-9a52-6f1e8b2d4c90'
const xeroDate = (ms) => `/Date(${ms}+0000)/`
const bankTxns = []
let xSeq = 0
const xero = (ms, amount, currency, bank, ref, extra = {}) => bankTxns.push({
  BankTransactionID: `b${String(++xSeq).padStart(7, '0')}-6c1d-4f0a-9d2e-4a7b1c3e5f${String(xSeq).padStart(2, '0')}`,
  Type: 'RECEIVE', Contact: { ContactID: '5f2e7d10-3a9b-4c61-8e44-2b7d9f0a1c35', Name: 'Stripe' },
  Date: xeroDate(ms), DateString: `${ymd(ms)}T00:00:00`, Status: 'AUTHORISED', LineAmountTypes: 'NoTax',
  LineItems: [{ Description: 'Stripe payout', UnitAmount: amount, AccountCode: '610', LineAmount: amount }],
  SubTotal: amount, TotalTax: 0, Total: amount, CurrencyCode: currency.toUpperCase(),
  BankAccount: { AccountID: `acc-${currency}`, Code: { eur: '090', gbp: '091', usd: '092' }[currency], Name: { eur: 'ING Business (EUR)', gbp: 'Wise Business (GBP)', usd: 'Wise Business (USD)' }[currency] },
  Reference: ref, IsReconciled: false, UpdatedDateUTC: xeroDate(ms + 9 * 3600000), ...extra,
})
for (const p of payouts.filter((x) => x.arrival_date < yTs)) xero(p.arrival_date * 1000, p.amount / 100, p.currency, null, p.id, { IsReconciled: true })
// yesterday: EUR booked right, GBP booked with two digits swapped, USD not booked at all
xero(Y, 18240.55, 'eur', null, 'po_1QLk7mF4aRhG2xYzEUR0921')
xero(Y, 6921.10, 'gbp', null, 'po_1QLk7nF4aRhG2xYzGBP0921')
function xeroWhere(where) {
  let rows = bankTxns.slice()
  const w = String(where || '')
  const type = w.match(/Type\s*==\s*"(\w+)"/i)
  if (type) rows = rows.filter((r) => r.Type === type[1].toUpperCase())
  const contact = w.match(/Contact\.Name\s*==\s*"([^"]+)"/i)
  if (contact) rows = rows.filter((r) => r.Contact.Name.toLowerCase() === contact[1].toLowerCase())
  const dt = (s) => { const m = s.match(/DateTime\((\d+),\s*(\d+),\s*(\d+)\)/); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null }
  for (const m of w.matchAll(/Date\s*(>=|>|<=|<|==)\s*(DateTime\([^)]*\))/gi)) {
    const v = dt(m[2]); if (v == null) continue
    rows = rows.filter((r) => { const d = Number(r.Date.match(/\d+/)[0]); return { '>=': d >= v, '>': d > v, '<=': d <= v, '<': d < v, '==': d === v }[m[1]] })
  }
  return rows
}

// ---------------- BigQuery (base https://bigquery.googleapis.com/bigquery/v2) ----------------
const PROJECT = 'larkspur-analytics'
const db = new DatabaseSync(':memory:')
db.exec(`CREATE TABLE shop_orders (order_id TEXT, created_at TEXT, customer_id TEXT, shipping_country TEXT, channel TEXT, status TEXT, total_eur REAL, shipped_at TEXT);
CREATE TABLE shop_order_items (order_id TEXT, sku TEXT, quantity INTEGER, line_total_eur REAL);
CREATE TABLE shop_products (sku TEXT, name TEXT, category TEXT, price_eur REAL);
CREATE TABLE shop_payments (payment_id TEXT, order_id TEXT, created_at TEXT, payment_method TEXT, amount_eur REAL, status TEXT);
CREATE TABLE shop_web_sessions (session_id TEXT, started_at TEXT, source TEXT, country TEXT, converted INTEGER);`)
const products = [
  ['LH-LIN-001', 'Stonewashed linen duvet cover, double', 'Bedding', 129], ['LH-LIN-002', 'Linen pillowcase set of 2', 'Bedding', 39],
  ['LH-CER-010', 'Hand-glazed stoneware mug, sage', 'Kitchen', 18], ['LH-CER-011', 'Stoneware dinner plate set of 4', 'Kitchen', 64],
  ['LH-TEX-020', 'Waffle cotton bath towel', 'Bath', 34], ['LH-TEX-021', 'Merino wool throw, oat', 'Living', 149],
  ['LH-LGT-030', 'Rattan pendant lamp', 'Lighting', 119], ['LH-LGT-031', 'Ceramic table lamp, chalk', 'Lighting', 89],
  ['LH-KIT-040', 'Oak serving board', 'Kitchen', 45], ['LH-KIT-041', 'Cast iron casserole 24 cm', 'Kitchen', 159],
  ['LH-DEC-050', 'Hand-woven jute rug 160x230', 'Living', 229], ['LH-DEC-051', 'Glass bud vase set of 3', 'Living', 29],
]
const insP = db.prepare('INSERT INTO shop_products VALUES (?,?,?,?)')
for (const p of products) { p[3] = p[3] - 0.05; insP.run(...p) }
const countries = [['NL', 30], ['DE', 26], ['BE', 9], ['FR', 10], ['GB', 12], ['US', 6], ['AT', 4], ['DK', 3]]
const countryBag = countries.flatMap(([c, w]) => Array(w).fill(c))
const methods = ['card', 'card', 'card', 'ideal', 'ideal', 'paypal', 'klarna', 'apple_pay']
const insO = db.prepare('INSERT INTO shop_orders VALUES (?,?,?,?,?,?,?,?)')
const insI = db.prepare('INSERT INTO shop_order_items VALUES (?,?,?,?)')
const insPay = db.prepare('INSERT INTO shop_payments VALUES (?,?,?,?,?,?)')
const insS = db.prepare('INSERT INTO shop_web_sessions VALUES (?,?,?,?,?)')
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
let oSeq = 180000
db.exec('BEGIN')
for (let d = 45; d >= 0; d--) {
  const day = today0() - d * DAY
  const weekday = new Date(day).getUTCDay()
  let n = Math.round((d === 0 ? 0.3 : 1) * (1150 + (weekday === 0 || weekday === 1 ? 160 : 0) + Math.floor(rnd() * 120)))
  for (let k = 0; k < n; k++) {
    const t = day + Math.floor(rnd() * (d === 0 ? 7 * 3600000 : DAY))
    const id = `LH-${++oSeq}`
    const country = pick(countryBag)
    const items = 1 + Math.floor(rnd() * 3)
    let total = 0
    for (let i = 0; i < items; i++) { const p = pick(products); const q = 1 + (rnd() < 0.15 ? 1 : 0); const line = Math.round(p[3] * q * 100) / 100; total += line; insI.run(id, p[0], q, line) }
    const status = d <= 1 ? (rnd() < 0.5 ? 'paid' : 'shipped') : (rnd() < 0.03 ? 'cancelled' : rnd() < 0.6 ? 'delivered' : 'shipped')
    const shipped = status === 'shipped' || status === 'delivered' ? iso(t + DAY * (0.5 + rnd())) : null
    insO.run(id, iso(t), `C${100000 + Math.floor(rnd() * 40000)}`, country, rnd() < 0.8 ? 'web' : 'app', status, Math.round(total * 100) / 100, shipped)
    // From yesterday on, a checkout release leaves the payment method empty for some payments.
    const method = d <= 1 && rnd() < 0.068 ? null : pick(methods)
    insPay.run(`pay_${id}`, id, iso(t + 20000), method, Math.round(total * 100) / 100, 'succeeded')
  }
  // The GA4 export stopped 31 hours ago: no sessions after that.
  if (day < Date.now() - 31 * 3600000) {
    const s = n * 34
    for (let k = 0; k < s; k += 1) {
      const t = day + Math.floor(rnd() * DAY)
      if (t > Date.now() - 31 * 3600000) continue
      if (k % 10) continue // keep it light: one in ten, the counts are only for the size
      insS.run(`s${d}_${k}`, iso(t), pick(['google', 'direct', 'instagram', 'newsletter', 'pinterest']), pick(countryBag), rnd() < 0.03 ? 1 : 0)
    }
  }
}
db.exec('COMMIT')
const loaded = {
  orders: Date.now() - 52 * 60000, order_items: Date.now() - 52 * 60000, products: Date.now() - 3 * DAY,
  payments: Date.now() - 48 * 60000, web_sessions: Date.now() - 31 * 3600000 - 12 * 60000,
}
db.exec('CREATE TABLE shop___TABLES__ (project_id TEXT, dataset_id TEXT, table_id TEXT, creation_time INTEGER, last_modified_time INTEGER, row_count INTEGER, size_bytes INTEGER, type INTEGER)')
const insT = db.prepare('INSERT INTO shop___TABLES__ VALUES (?,?,?,?,?,?,?,?)')
for (const t of Object.keys(loaded)) {
  const rows = db.prepare(`SELECT count(*) n FROM shop_${t}`).get().n
  insT.run(PROJECT, 'shop', t, Date.now() - 400 * DAY, loaded[t], t === 'web_sessions' ? rows * 10 : rows, rows * 180, 1)
}

// BigQuery SQL -> SQLite, for the functions these guides use.
function translate(sql) {
  let s = String(sql)
  s = s.replace(/`(?:[\w-]+\.)?(\w+)\.(\w+)`/g, (_, ds, t) => `${ds}_${t}`)
  s = s.replace(/\b(?:[\w-]+\.)?shop\.(\w+)\b/g, (_, t) => `shop_${t}`)
  const date = (e) => e
  // CURRENT_DATE() / CURRENT_TIMESTAMP()
  s = s.replace(/CURRENT_DATE\(\s*\)/gi, "date('now')").replace(/CURRENT_TIMESTAMP\(\s*\)/gi, "datetime('now')")
  // DATE_TRUNC(x, WEEK(MONDAY)) and DATE_TRUNC(x, MONTH)
  for (let i = 0; i < 4; i++) {
    s = s.replace(/DATE_TRUNC\(([^(),]+(?:\([^()]*\))?),\s*WEEK\(MONDAY\)\)/gi, (_, e) => `date(${date(e)}, '-6 days', 'weekday 1')`)
    s = s.replace(/DATE_TRUNC\(([^(),]+(?:\([^()]*\))?),\s*MONTH\)/gi, (_, e) => `date(${e}, 'start of month')`)
    s = s.replace(/DATE_(SUB|ADD)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))+?),\s*INTERVAL\s+(\d+)\s+(DAY|HOUR|WEEK)\)/gi, (_, op, e, n, u) => {
      const k = u.toUpperCase() === 'WEEK' ? Number(n) * 7 : Number(n)
      const unit = u.toUpperCase() === 'HOUR' ? 'hours' : 'days'
      return `date(${e}, '${op.toUpperCase() === 'SUB' ? '-' : '+'}${k} ${unit}')`
    })
    s = s.replace(/TIMESTAMP_(SUB|ADD)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))+?),\s*INTERVAL\s+(\d+)\s+(DAY|HOUR)\)/gi, (_, op, e, n, u) => `datetime(${e}, '${op.toUpperCase() === 'SUB' ? '-' : '+'}${n} ${u.toUpperCase() === 'HOUR' ? 'hours' : 'days'}')`)
  }
  s = s.replace(/TIMESTAMP_MILLIS\(([^()]+)\)/gi, (_, e) => `datetime((${e}) / 1000, 'unixepoch')`)
  s = s.replace(/TIMESTAMP_DIFF\(([^,]+(?:\([^()]*\))?),\s*([^,]+(?:\([^()]*(?:\([^()]*\))?[^()]*\))?),\s*HOUR\)/gi, (_, a, b) => `CAST(ROUND((julianday(${a}) - julianday(${b})) * 24 - 0.5) AS INTEGER)`)
  // COUNTIF(cond), with any nesting inside
  for (let i = s.search(/COUNTIF\(/i); i >= 0; i = s.search(/COUNTIF\(/i)) {
    let depth = 0; let j = i + 'COUNTIF'.length
    for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break }
    s = `${s.slice(0, i)}SUM(CASE WHEN ${s.slice(i + 8, j)} THEN 1 ELSE 0 END)${s.slice(j + 1)}`
  }
  s = s.replace(/SAFE_DIVIDE\(([^,]+),\s*([^()]+(?:\([^()]*\))?)\)/gi, (_, a, b) => `(CAST(${a} AS REAL) / NULLIF(${b}, 0))`)
  s = s.replace(/\bDATE\(([^()]+)\)/g, (_, e) => `date(${e})`)
  // BigQuery's "/" always divides as FLOAT64
  s = s.replace(/\/\s*(\d+)(?![\d.])/g, '/ $1.0')
  return s
}
const bqType = (v, name) => typeof v === 'number' ? (Number.isInteger(v) && !/eur|share|pct|avg|revenue/i.test(name) ? 'INTEGER' : 'FLOAT') : 'STRING'
function bigquery(body) {
  const q = String(body?.query || '')
  if (/^\s*(insert|update|delete|merge|drop|create|alter|truncate)\b/i.test(q)) {
    return [403, { error: { code: 403, message: `Access Denied: Project ${PROJECT}: User does not have bigquery.tables.updateData permission for table ${PROJECT}:shop.orders.`, status: 'PERMISSION_DENIED' } }]
  }
  let rows
  // defaultDataset: bare table names are tables in that dataset
  const ds = body?.defaultDataset?.datasetId
  let sqlText = q
  if (ds) {
    if (ds !== 'shop' || (body.defaultDataset.projectId && body.defaultDataset.projectId !== PROJECT)) return [404, { error: { code: 404, message: `Not found: Dataset ${body.defaultDataset.projectId || PROJECT}:${ds}`, status: 'NOT_FOUND' } }]
    sqlText = q.replace(/\b(FROM|JOIN)\s+(orders|order_items|products|payments|web_sessions)\b/gi, '$1 shop_$2')
  }
  try { rows = db.prepare(translate(sqlText)).all() } catch (e) {
    return [400, { error: { code: 400, message: `Syntax error: ${String(e.message).replace(/^.*?: /, '')}`, status: 'INVALID_ARGUMENT' } }]
  }
  const names = rows[0] ? Object.keys(rows[0]) : (q.match(/select([\s\S]+?)from/i)?.[1] || '').split(',').map((x) => x.trim().split(/\s+as\s+|\s+/i).pop())
  const bytes = 10485760 + rows.length * 2048 + q.length * 977
  if (body?.dryRun) return [200, { kind: 'bigquery#queryResponse', jobReference: { projectId: PROJECT, location: 'EU' }, totalBytesProcessed: String(bytes), jobComplete: true, cacheHit: false }]
  return [200, {
    kind: 'bigquery#queryResponse',
    schema: { fields: names.map((n) => ({ name: n, type: bqType(rows[0]?.[n], n), mode: 'NULLABLE' })) },
    jobReference: { projectId: PROJECT, jobId: `job_${Math.random().toString(36).slice(2, 14)}`, location: 'EU' },
    totalRows: String(rows.length),
    rows: rows.slice(0, Number(body?.maxResults || 1000)).map((r) => ({ f: names.map((n) => ({ v: r[n] == null ? null : String(r[n]) })) })),
    totalBytesProcessed: String(bytes), totalBytesBilled: String(Math.max(10485760, Math.ceil(bytes / 1048576) * 1048576)), jobComplete: true, cacheHit: false,
  }]
}

// ---------------- Slack (redirected by redirect-fetch.mjs) ----------------
const outbox = []
const SLACK_USERS = { U0FENNA: { real_name: 'Fenna de Wit', email: 'fenna@larkspurhome.example' }, U0INES: { real_name: 'Ines Duarte', email: 'ines@larkspurhome.example' } }
const CHANNELS = [{ id: 'C0FINOPS', name: 'finance-ops' }, { id: 'C0DATAALERTS', name: 'data-alerts' }, { id: 'C0ASKDATA', name: 'ask-data' }, { id: 'C0LEGAL', name: 'legal-review' }, { id: 'C0GENERAL', name: 'general' }]

// ---------------- helpers ----------------
const send = (res, status, body, headers = {}) => {
  const str = typeof body === 'string'
  res.writeHead(status, { 'content-type': str ? 'text/plain; charset=utf-8' : 'application/json', ...headers })
  res.end(str ? body : JSON.stringify(body))
}
const readBody = (req) => new Promise((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { r(s ? JSON.parse(s) : {}) } catch { r(Object.fromEntries(new URLSearchParams(s))) } }) })

const MODELS = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'],
  mistral: ['mistral-large-latest', 'mistral-small-latest'],
}

async function chat(req, res, body, vendor) {
  const { decide } = await import(`./data-model.mjs?t=${Date.now()}`)
  const d = await decide(body, vendor)
  const model = body.model || MODELS[vendor][0]
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
  else for (const piece of (d.content || '').match(/[\s\S]{1,60}/g) || [d.content || '']) chunk({ content: piece }, null)
  chunk({}, finish)
  res.write(`data: ${JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage })}\n\n`)
  return res.end('data: [DONE]\n\n')
}

// Anthropic's Messages API, turned into the chat shape decide() reads.
// Document and image parts become a marker the scripted model can see.
const anthropicPart = (p) => p.type === 'text' ? { type: 'text', text: p.text } : p.type === 'document' ? { type: 'file', file: { filename: p.title || p.name || 'document.pdf', mime: p.source?.media_type, bytes: (p.source?.data || '').length } } : p.type === 'tool_result' ? { type: 'text', text: typeof p.content === 'string' ? p.content : JSON.stringify(p.content) } : { type: p.type }
async function anthropic(req, res, body) {
  const { decide } = await import(`./data-model.mjs?t=${Date.now()}`)
  const messages = [
    ...(body.system ? [{ role: 'system', content: Array.isArray(body.system) ? body.system.map((s) => s.text).join('\n') : body.system }] : []),
    ...(body.messages || []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map(anthropicPart) })),
  ]
  const d = await decide({ ...body, messages, tools: [] }, 'anthropic')
  const model = body.model || 'claude-sonnet-4-5'
  const input = Math.round(JSON.stringify(messages).length / 4) + 200
  const output = Math.round((d.content || '').length / 4) + 5
  const content = d.content || ''
  if (!body.stream) return send(res, 200, { id: 'msg_local', type: 'message', role: 'assistant', model, content: [{ type: 'text', text: content }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: input, output_tokens: output } })
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  ev('message_start', { message: { id: 'msg_local', type: 'message', role: 'assistant', model, content: [], usage: { input_tokens: input, output_tokens: 1 } } })
  ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  for (const piece of content.match(/[\s\S]{1,60}/g) || ['']) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } })
  ev('content_block_stop', { index: 0 })
  ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: output } })
  ev('message_stop', {})
  return res.end()
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`)
  const p = decodeURIComponent(u.pathname)
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined
  try { appendFileSync(LOG, `${new Date().toISOString()} ${req.method} ${u.pathname}${u.search} ${body ? JSON.stringify(body).slice(0, 600) : ''}\n`) } catch {}
  let m
  try {
    if (p === '/health') return send(res, 200, { ok: true })
    // ---- the scripted models
    for (const vendor of Object.keys(MODELS)) {
      if (p === `/${vendor}/v1/models`) return send(res, 200, { object: 'list', data: MODELS[vendor].map((id) => ({ id, object: 'model', created: 1715367049, owned_by: vendor })) })
      if (p === `/${vendor}/v1/chat/completions` && req.method === 'POST') return chat(req, res, body, vendor)
    }
    if (p === '/anthropic/v1/models') return send(res, 200, { data: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'].map((id) => ({ type: 'model', id, display_name: id, created_at: '2025-09-29T00:00:00Z' })), has_more: false, first_id: 'claude-sonnet-4-5', last_id: 'claude-haiku-4-5' })
    if (p === '/anthropic/v1/messages' && req.method === 'POST') return anthropic(req, res, body)
    // ---- outbound Slack and Resend traffic, redirected here (never sent for real)
    // A file shared in Slack: the contract PDF the guide posts (CONTRACT_PDF).
    if (p.startsWith('/_ext/files.slack.com/')) {
      outbox.push({ at: new Date().toISOString(), url: p.slice(5), body: null })
      try {
        const bytes = readFileSync(process.env.CONTRACT_PDF || '/tmp/almyty-demo/shots/examples/northgate-fulfilment-agreement.pdf')
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': bytes.length })
        return res.end(bytes)
      } catch { return send(res, 404, 'file_not_found') }
    }
    if (p.startsWith('/_ext/')) {
      outbox.push({ at: new Date().toISOString(), url: p.slice(5) + u.search, body })
      if (p.startsWith('/_ext/api.resend.com')) return send(res, 200, { id: 'local-email-' + outbox.length })
      if (p.includes('/users.info')) { const id = u.searchParams.get('user') || body?.user || 'U0FENNA'; const x = SLACK_USERS[id] || SLACK_USERS.U0FENNA; return send(res, 200, { ok: true, user: { id, name: x.real_name.split(' ')[0].toLowerCase(), real_name: x.real_name, profile: { email: x.email, real_name: x.real_name, display_name: x.real_name.split(' ')[0] } } }) }
      if (p.includes('/conversations.list')) return send(res, 200, { ok: true, channels: CHANNELS })
      if (p.includes('/auth.test')) return send(res, 200, { ok: true, team: 'Larkspur Home', team_id: 'T0LARKSPUR', user_id: 'U0BOT', bot_id: 'B0BOT' })
      return send(res, 200, { ok: true, ts: String(Date.now() / 1000), channel: body?.channel || 'C0GENERAL' })
    }
    if (p === '/_admin/state') return send(res, 200, { outbox })
    if (p === '/_admin/reset' && req.method === 'POST') { outbox.length = 0; return send(res, 200, { reset: true }) }

    // ---- Stripe
    if (p === '/stripe/v1/payouts' && req.method === 'GET') {
      const r = rangeOf(u.searchParams, 'arrival_date')
      const status = u.searchParams.get('status')
      const limit = Number(u.searchParams.get('limit') || 10)
      const data = payouts.filter((x) => inRange(x.arrival_date, r) && (!status || x.status === status)).sort((a, b) => b.arrival_date - a.arrival_date || a.currency.localeCompare(b.currency)).slice(0, limit).map(publicPayout)
      return send(res, 200, list('/v1/payouts', data))
    }
    if ((m = p.match(/^\/stripe\/v1\/payouts\/(po_\w+)$/))) { const x = payouts.find((y) => y.id === m[1]); return x ? send(res, 200, publicPayout(x)) : send(res, 404, { error: { code: 'resource_missing', message: `No such payout: '${m[1]}'`, type: 'invalid_request_error' } }) }
    if (p === '/stripe/v1/balance_transactions' && req.method === 'GET') {
      const payout = u.searchParams.get('payout')
      const type = u.searchParams.get('type')
      const limit = Math.min(100, Number(u.searchParams.get('limit') || 10))
      const data = balanceTxns.filter((t) => (!payout || t.payout === payout) && (!type || t.type === type)).slice(0, limit).map(({ payout: _, ...t }) => t)
      return send(res, 200, list('/v1/balance_transactions', data))
    }

    // ---- Xero
    if (p === '/xero/connections') return send(res, 200, [{ id: 'c0a1b2c3-0000-4000-8000-000000000001', tenantId: TENANT, tenantType: 'ORGANISATION', tenantName: 'Larkspur Home B.V.' }])
    if (p === '/xero/api.xro/2.0/BankTransactions' && req.method === 'GET') {
      const tenant = req.headers['xero-tenant-id']
      if (tenant !== TENANT) return send(res, 403, { Type: null, Title: 'Forbidden', Status: 403, Detail: 'AuthenticationUnsuccessful' })
      return send(res, 200, { Id: 'resp-local', Status: 'OK', ProviderName: 'almyty', DateTimeUTC: xeroDate(Date.now()), BankTransactions: xeroWhere(u.searchParams.get('where')) })
    }

    // ---- BigQuery
    if ((m = p.match(/^\/bigquery\/v2\/projects\/([^/]+)\/queries$/)) && req.method === 'POST') {
      if (m[1] !== PROJECT) return send(res, 404, { error: { code: 404, message: `Not found: Project ${m[1]}`, status: 'NOT_FOUND' } })
      const [status, out] = bigquery(body)
      return send(res, status, out)
    }
    return send(res, 404, { error: 'not found in the local stand-in', path: p })
  } catch (e) {
    return send(res, 500, { error: String(e?.stack || e) })
  }
})
server.listen(PORT, '127.0.0.1', () => console.log(`data stand-in on http://localhost:${PORT}`))
http.createServer((req, res) => server.emit('request', req, res)).listen(PORT, '::1')

