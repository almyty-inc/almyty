// A scripted stand-in for OpenAI-compatible chat models (OpenAI and
// Mistral), for the data and finance example guides (data-guides.mjs).
// Like usecases/model.mjs it is not clever: per use case it follows a fixed
// plan of tool calls, reads what the tools really returned, and writes its
// answer from that data, so a run shows whether the platform plumbing
// (tools, keys, channels, schedules, work modes, budgets) works end to end.
//
// Each tool call id carries the plan step it belongs to (call_<step>_n).
import { appendFileSync } from 'node:fs'

const LOG = process.env.USECASE_MODEL_LOG || '/tmp/almyty-demo/data-model.log'
const DAY = 86400000
const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : c == null ? '' : JSON.stringify(c))
function parse(s) {
  if (s == null) return null
  if (typeof s !== 'string') return s
  try { return JSON.parse(s) } catch {}
  const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)) } catch {} }
  return s
}
// Tool results arrive wrapped ({success, data}, {result}, ...); find the payload.
function unwrap(v, isPayload) {
  let x = parse(v)
  for (let k = 0; k < 6 && x && typeof x === 'object' && !Array.isArray(x); k++) {
    if (isPayload(x)) break
    const next = x.data ?? x.result ?? x.output ?? x.body ?? x.response
    if (next === undefined) break
    x = parse(next)
  }
  return x
}

function stateOf(body) {
  const msgs = body.messages || []
  const system = msgs.filter((m) => m.role === 'system').map((m) => text(m.content)).join('\n')
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user')
  const userText = text(msgs[lastUser]?.content)
  const turn = msgs.slice(lastUser + 1)
  const results = {}
  const pending = {}
  for (const m of turn) {
    for (const c of m.tool_calls || []) pending[c.id] = { name: c.function?.name, args: parse(c.function?.arguments) }
    if (m.role === 'tool') {
      const call = pending[m.tool_call_id] || {}
      const step = (String(m.tool_call_id).match(/^call_([a-z0-9-]+)_\d+/) || [])[1] || 'unknown'
      ;(results[step] ||= []).push({ ...call, result: text(m.content) })
    }
  }
  const tools = (body.tools || []).map((t) => t.function?.name)
  return { msgs, system, userText, results, tools, all: msgs.map((m) => text(m.content)).join('\n') }
}

let seq = 0
function call(st, step, realName, args) {
  const id = `call_${step}_${Date.now() % 1e6}${seq++}`
  if (st.tools.includes(realName)) return { id, name: realName, args }
  return { id, name: 'call_tool', args: { name: realName, arguments: args } }
}
const has = (st, step) => !!st.results[step]
const argOf = (r, k) => r.args?.[k] ?? r.args?.arguments?.[k]
const tool = (st, re) => st.tools.find((n) => re.test(n))

// ---------- money ----------
const SYM = { eur: '€', gbp: '£', usd: '$' }
const money = (cents, cur) => `${SYM[cur] || ''}${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dayName = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

// ---------- 1. Stripe payouts against Xero ----------
function payouts(st) {
  const y = new Date(); y.setUTCHours(0, 0, 0, 0)
  const Y = y.getTime() - DAY
  const tenant = (st.system.match(/xero-tenant-id\W+([0-9a-f-]{36})/i) || [])[1]
  const tp = tool(st, /stripe_get_payouts$/)
  if (tp && !has(st, 'payouts')) return { toolCalls: [call(st, 'payouts', tp, { arrival_date: String(Y / 1000), status: 'paid', limit: 10 })] }
  const list = unwrap(st.results.payouts?.[0]?.result, (x) => x.object === 'list')
  const found = list?.data || []
  if (!found.length) {
    const err = String(st.results.payouts?.[0]?.result || '').slice(0, 200)
    return { content: err && /error|denied|401|403/i.test(err) ? `I could not read the payouts from Stripe: ${err}` : `No Stripe payouts arrived on ${dayName(Y)}.` }
  }
  const tb = tool(st, /stripe_get_balance_transactions$/)
  const done = (st.results.txns || []).map((r) => String(argOf(r, 'payout')))
  const next = found.find((p) => !done.includes(p.id))
  if (tb && next) return { toolCalls: [call(st, 'txns', tb, { payout: next.id, limit: 100 })] }
  const tx = tool(st, /xero_accounting_get_bank_transactions$/)
  const d = new Date(Y)
  if (tx && !has(st, 'xero')) return { toolCalls: [call(st, 'xero', tx, { 'xero-tenant-id': tenant, where: `Type=="RECEIVE" AND Contact.Name=="Stripe" AND Date>=DateTime(${d.getUTCFullYear()},${d.getUTCMonth() + 1},${d.getUTCDate()})` })] }
  const xr = unwrap(st.results.xero?.[0]?.result, (x) => Array.isArray(x.BankTransactions))
  if (!xr?.BankTransactions) return { content: `I could not read the bank transactions from Xero, so I did not compare anything: ${String(st.results.xero?.[0]?.result || 'no answer').slice(0, 300)}` }
  const booked = xr.BankTransactions
  const lines = []
  const problems = []
  const refunds = []
  for (const p of found) {
    const r = (st.results.txns || []).find((x) => String(argOf(x, 'payout')) === p.id)
    const txns = unwrap(r?.result, (x) => x.object === 'list')?.data || []
    const charges = txns.filter((t) => t.type === 'charge')
    const refs = txns.filter((t) => t.type === 'refund')
    const gross = charges.reduce((s, t) => s + t.amount, 0)
    const fees = txns.reduce((s, t) => s + t.fee, 0)
    const refunded = refs.reduce((s, t) => s - t.amount, 0)
    for (const t of refs) if (-t.amount >= 50000) refunds.push({ t, p })
    const breakdown = `${charges.length} charges ${money(gross, p.currency)}, fees ${money(fees, p.currency)}${refs.length ? `, ${refs.length} refund${refs.length > 1 ? 's' : ''} ${money(refunded, p.currency)}` : ', no refunds'}`
    const x = booked.find((b) => b.Reference === p.id)
    const cur = p.currency.toUpperCase()
    if (!x) {
      problems.push(`- **${cur} ${money(p.amount, p.currency)}** (\`${p.id}\`): **not in Xero.** Stripe: ${breakdown}. Book it as a Receive Money from Stripe with this payout id as the reference.`)
    } else if (Math.round(x.Total * 100) !== p.amount) {
      const diff = Math.round(x.Total * 100) - p.amount
      problems.push(`- **${cur} ${money(p.amount, p.currency)}** (\`${p.id}\`): **Xero has ${money(Math.round(x.Total * 100), p.currency)}** in ${x.BankAccount?.Name}, ${money(Math.abs(diff), p.currency)} ${diff > 0 ? 'more' : 'less'} than Stripe paid. Stripe: ${breakdown}.`)
    } else {
      lines.push(`- ${cur} ${money(p.amount, p.currency)} matches Xero (${x.BankAccount?.Name}).`)
    }
  }
  const out = [`**Stripe payouts for ${dayName(Y)}: ${found.length} payouts, ${lines.length} match Xero, ${problems.length} need a look**`, '']
  if (problems.length) out.push('**Needs a look**', ...problems, '')
  if (lines.length) out.push('**Matches**', ...lines, '')
  if (refunds.length) {
    out.push('**Refunds over 500**')
    for (const { t, p } of refunds) out.push(`- ${money(-t.amount, t.currency)}: ${t.description}, in the ${p.currency.toUpperCase()} payout.`)
    out.push('')
  }
  out.push('I only read Stripe and Xero; nothing was changed.')
  return { content: out.join('\n') }
}

// ---------- BigQuery ----------
const bqRows = (r) => {
  const x = unwrap(r?.result, (y) => y.kind === 'bigquery#queryResponse' || 'error' in y)
  if (!x || x.error || !x.schema) return { error: x?.error?.message || String(r?.result || 'no answer').slice(0, 300) }
  const names = x.schema.fields.map((f) => f.name)
  return { rows: (x.rows || []).map((row) => Object.fromEntries(row.f.map((c, i) => [names[i], c.v]))), bytes: Number(x.totalBytesProcessed || 0) }
}
const n = (v) => Number(v).toLocaleString('en-US')
const eur = (v) => `€${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const T = (t) => (t === '__TABLES__' ? 'shop.__TABLES__' : t)
function bq(st, step, sql) {
  const name = tool(st, /jobs_query$/)
  if (!name) return null
  return call(st, step, name, { projectId: 'larkspur-analytics', query: sql, useLegacySql: false, maximumBytesBilled: '1000000000', maxResults: 100, defaultDataset: { projectId: 'larkspur-analytics', datasetId: 'shop' } })
}

const Q_FRESH = `SELECT table_id, row_count, TIMESTAMP_DIFF(CURRENT_TIMESTAMP(), TIMESTAMP_MILLIS(last_modified_time), HOUR) AS hours_since_update
FROM ${T('__TABLES__')}
ORDER BY table_id`
const Q_VOLUME = `SELECT
  COUNTIF(DATE(created_at) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)) AS orders_yesterday,
  ROUND(COUNTIF(DATE(created_at) BETWEEN DATE_SUB(CURRENT_DATE(), INTERVAL 8 DAY) AND DATE_SUB(CURRENT_DATE(), INTERVAL 2 DAY)) / 7, 1) AS avg_previous_7_days
FROM ${T('orders')}`
const Q_NULLS = `SELECT
  (SELECT COUNT(*) FROM ${T('payments')} WHERE DATE(created_at) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)) AS payments,
  (SELECT COUNTIF(payment_method IS NULL) FROM ${T('payments')} WHERE DATE(created_at) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)) AS payments_without_method,
  (SELECT COUNT(*) FROM ${T('orders')} WHERE DATE(created_at) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)) AS orders,
  (SELECT COUNTIF(customer_id IS NULL OR shipping_country IS NULL) FROM ${T('orders')} WHERE DATE(created_at) = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY)) AS orders_missing_customer_or_country`

function quality(st) {
  for (const [step, q] of [['fresh', Q_FRESH], ['volume', Q_VOLUME], ['nulls', Q_NULLS]]) {
    if (!has(st, step)) { const c = bq(st, step, q); return c ? { toolCalls: [c] } : { content: 'I have no BigQuery tool to run the checks with.' } }
  }
  const fresh = bqRows(st.results.fresh[0]); const vol = bqRows(st.results.volume[0]); const nul = bqRows(st.results.nulls[0])
  const err = [fresh, vol, nul].find((r) => r.error)
  if (err) return { content: `A check query failed, so tonight's report is incomplete: ${err.error}` }
  const y = new Date(Date.now() - DAY)
  const problems = []; const passed = []
  const stale = fresh.rows.filter((r) => r.table_id !== 'products' && Number(r.hours_since_update) > 6)
  for (const r of stale) problems.push(`- **\`shop.${r.table_id}\` was last updated ${r.hours_since_update} hours ago** (limit: 6). It has ${n(r.row_count)} rows. Every other table was updated within the last hour.`)
  if (!stale.length) passed.push('freshness (every table updated in the last 6 hours)')
  const v = vol.rows[0]; const change = (Number(v.orders_yesterday) - Number(v.avg_previous_7_days)) / Number(v.avg_previous_7_days) * 100
  const volLine = `order volume (${n(v.orders_yesterday)} orders yesterday, 7-day average ${n(v.avg_previous_7_days)}, ${change >= 0 ? '+' : ''}${change.toFixed(1)}%)`
  if (Math.abs(change) > 30) problems.push(`- **Orders ${change > 0 ? 'up' : 'down'} ${Math.abs(change).toFixed(0)}%**: ${volLine}.`); else passed.push(volLine)
  const z = nul.rows[0]; const pm = Number(z.payments_without_method) / Number(z.payments) * 100; const oc = Number(z.orders_missing_customer_or_country) / Number(z.orders) * 100
  if (pm > 1) problems.push(`- **${pm.toFixed(1)}% of yesterday's payments have no \`payment_method\`** (${n(z.payments_without_method)} of ${n(z.payments)}; limit: 1%).`)
  if (oc > 1) problems.push(`- **${oc.toFixed(1)}% of yesterday's orders have no customer or country** (${n(z.orders_missing_customer_or_country)} of ${n(z.orders)}).`)
  if (pm <= 1 && oc <= 1) passed.push('empty values')
  else if (oc <= 1) passed.push(`orders with customer and country (${n(z.orders_missing_customer_or_country)} missing of ${n(z.orders)})`)
  const head = problems.length ? `**Shop data check for ${dayName(y.getTime())}: ${problems.length} problem${problems.length > 1 ? 's' : ''}**` : `**Shop data check for ${dayName(y.getTime())}: all checks passed**`
  return { content: [head, '', ...problems, ...(problems.length ? [''] : []), `Passed: ${passed.join('; ')}.`, '', `3 queries, ${(([fresh, vol, nul].reduce((s, r) => s + r.bytes, 0)) / 1048576).toFixed(0)} MB read.`].join('\n') }
}

const LAST_WEEK = `DATE(o.shipped_at) BETWEEN DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 7 DAY)
  AND DATE_SUB(DATE_TRUNC(CURRENT_DATE(), WEEK(MONDAY)), INTERVAL 1 DAY)`
const COUNTRY = { germany: 'DE', netherlands: 'NL', france: 'FR', belgium: 'BE', uk: 'GB', 'united kingdom': 'GB', austria: 'AT', denmark: 'DK', 'united states': 'US', us: 'US' }
function ask(st) {
  const q = st.userText.replace(/<@[A-Z0-9]+>/g, '').trim()
  if (/\b(delete|remove|drop|update|change|insert)\b/i.test(q)) return { content: 'I only read data, so I did not run anything. To delete or change orders, ask someone on the data team.' }
  const cname = Object.keys(COUNTRY).find((c) => new RegExp(`\\b${c}\\b`, 'i').test(q)) || 'germany'
  const cc = COUNTRY[cname]
  const country = cname.replace(/\b\w/g, (m) => m.toUpperCase())
  let sql; let answer
  if (/product|sold best|top|best.?sell/i.test(q)) {
    const k = Number((q.match(/\b(\d+|three|five|ten)\b/i) || [])[1]?.replace(/three/i, '3').replace(/five/i, '5').replace(/ten/i, '10')) || 5
    sql = `SELECT p.name, SUM(i.quantity) AS units, ROUND(SUM(i.line_total_eur), 2) AS revenue_eur
FROM ${T('order_items')} AS i
JOIN ${T('orders')} AS o ON o.order_id = i.order_id
JOIN ${T('products')} AS p ON p.sku = i.sku
WHERE o.shipping_country = '${cc}'
  AND ${LAST_WEEK}
GROUP BY p.name
ORDER BY revenue_eur DESC
LIMIT ${k}`
    answer = (rows) => [`The ${rows.length} best sellers shipped to ${country} last week, by revenue:`, '', ...rows.map((r, i) => `${i + 1}. ${r.name}: ${n(r.units)} sold, ${eur(r.revenue_eur)}`)].join('\n')
  } else {
    sql = `SELECT COUNT(*) AS orders, ROUND(SUM(o.total_eur), 2) AS revenue_eur
FROM ${T('orders')} AS o
WHERE o.shipping_country = '${cc}'
  AND ${LAST_WEEK}`
    answer = (rows) => `Last week (Monday to Sunday) we shipped **${n(rows[0].orders)} orders** to ${country}, worth **${eur(rows[0].revenue_eur)}** (order totals including VAT and shipping).`
  }
  if (!has(st, 'ask')) { const c = bq(st, 'ask', sql); return c ? { toolCalls: [c] } : { content: 'I have no BigQuery tool to run the query with.' } }
  const r = bqRows(st.results.ask[0])
  if (r.error) return { content: `BigQuery refused the query: ${r.error}` }
  return { content: `${answer(r.rows)}\n\nThe query I ran (${(r.bytes / 1048576).toFixed(0)} MB read):\n\`\`\`\n${sql}\n\`\`\`` }
}

// ---------- 4. contract review by a panel ----------
// What each reader finds in the Northgate draft (contract.html). The
// stand-in cannot read a PDF, so it checks one was attached and answers
// from the clauses of the draft it was made from.
function contractFile(body) {
  for (const m of body.messages || []) {
    if (!Array.isArray(m.content)) continue
    for (const p of m.content) {
      if (p?.type === 'file' || p?.type === 'document' || p?.type === 'input_file') return p.file?.filename || p.filename || p.name || 'the attachment'
      if (p?.type === 'text' && /Warehousing and Fulfilment Services Agreement/.test(p.text || '')) return 'the pasted text'
    }
    if (typeof m.content === 'string' && /Warehousing and Fulfilment Services Agreement/.test(m.content)) return 'the pasted text'
  }
  return null
}
const OUR_SIDE = [
  ['5.3', 'high', 'Uncapped indemnity from us for anything arising from the products, packaging or labelling. Ask for a cap (12 months of fees) and carve out claims caused by Northgate.'],
  ['5.1', 'high', "Northgate's liability is capped at 3 months of fees, about EUR 22,000 at our volumes, while it holds roughly EUR 1.4 million of our stock. Ask for 12 months of fees and a separate cap for stock loss."],
  ['4.2', 'high', 'Northgate is liable for lost or damaged stock only for gross negligence. Ask for ordinary negligence, with a per-pallet value.'],
  ['2.2', 'medium', 'Renews for 12 months unless we give notice 120 days before the end. Put 1 September 2028 in the calendar or ask for 60 days.'],
  ['3.3', 'medium', 'Fees can rise up to 9% a year on 30 days notice. Ask for a cap tied to Dutch CPI and 90 days notice.'],
  ['3.2', 'medium', 'Minimum of 6,000 orders a month at EUR 1.10 per missing order. Our January to February average was 5,200 orders, so expect about EUR 880 a month in shortfall fees then.'],
  ['7.2', 'medium', 'Leaving early costs 6 months of minimum fees, about EUR 34,200.'],
]
const THEIR_SIDE = [
  ['3.2', 'They will defend the 6,000-order minimum hardest: it pays for the space they reserve. Offer a seasonal minimum (4,500 in January and February) instead of asking to drop it.'],
  ['5.1', 'A 3-month cap is their standard. They usually move to 6 or 12 months if the stock-loss cap is separate.'],
  ['4.1', 'The lien protects them against unpaid invoices; expect them to keep it, but they can drop the right to sell stock.'],
  ['3.3', 'They will want some indexation; 9% is high and a CPI link is common.'],
  ['8.1', 'English law is their default; they may accept Dutch law since the warehouse is in Venlo.'],
]
const LAW = [
  ['6.1', 'high', 'No data processing agreement, and sub-processors "at its discretion". Under GDPR Article 28 we must approve sub-processors and have a written processing agreement. Add a DPA as a schedule before signing.'],
  ['8.1', 'medium', 'English law and London courts for a Dutch company and a warehouse in the Netherlands. Any dispute would be run abroad. Ask for Dutch law and the Amsterdam court.'],
  ['4.1', 'medium', 'A general lien with a right to sell our stock 30 days after notice. Limit it to stock related to overdue undisputed invoices, and remove the right to sell.'],
  ['1.2', 'low', 'A 2% credit is the only remedy for missed dispatch targets. Add a right to terminate after 3 missed months in a row.'],
]
function contract(st, body, vendor) {
  // the judge: "Several responses to the same question follow ..." and a JSON reply
  if (/^Several responses to the same question/.test(st.userText.trim())) {
    const n = (st.userText.match(/^Response \d+:/gm) || []).length
    const blind = (st.userText.match(/cannot see a contract/g) || []).length
    if (blind >= n) return { content: JSON.stringify({ agreeing: n, answer: 'I cannot see a contract: no file came with the message. Attach the PDF and ask again.' }) }
    return { content: JSON.stringify({ agreeing: 1, answer: memo(blind) }) }
  }
  const file = contractFile(body)
  if (!file) return { content: 'I cannot see a contract: no file came with the message. Attach the PDF and ask again.' }
  const role = (st.system.match(/\[YOUR ROLE: ([^\]]+)\]/) || [])[1] || ''
  if (/Northgate|supplier/i.test(role)) return { content: ['**Where Northgate will push back** (read as their lawyer)', '', ...THEIR_SIDE.map(([c, t]) => `- Clause ${c}: ${t}`)].join('\n') }
  if (/Dutch|EU|law/i.test(role)) return { content: ['**Dutch and EU law check**', '', ...LAW.map(([c, s, t]) => `- Clause ${c} (${s}): ${t}`)].join('\n') }
  return { content: ['**Risks for Larkspur Home**', '', ...OUR_SIDE.map(([c, s, t]) => `- Clause ${c} (${s}): ${t}`)].join('\n') }
}
function memo(blind) {
  const all = [...OUR_SIDE.slice(0, 3), LAW[0], OUR_SIDE[3], OUR_SIDE[4], OUR_SIDE[5], LAW[1], LAW[2], OUR_SIDE[6]]
  return [
    '**Risk memo: Northgate Fulfilment, warehousing and fulfilment agreement (draft NGF-2026-0412)**',
    '',
    '**Not yet.** Four clauses need changing before signing; the rest are worth asking for.',
    '',
    '**Must change before signing**',
    ...all.slice(0, 4).map(([c, , t]) => `- **Clause ${c}.** ${t}`),
    '',
    '**Worth negotiating**',
    ...all.slice(4).map(([c, , t]) => `- Clause ${c}. ${t}`),
    '',
    '**Where to expect push-back** (the reading as Northgate): the order minimum in 3.2 and the lien in 4.1. Offer a seasonal minimum rather than asking to drop the minimum.',
    '',
    '**Where the readers disagreed:** the reading for Larkspur ranks the fee increase in 3.3 as medium; the reading as Northgate expects them to accept a CPI link easily. Only the Dutch-law reading flags the missing data processing agreement (6.1), and that one cannot be negotiated away: GDPR requires it.',
    ...(blind ? ['', `(${blind} of the readers could not see the PDF.)`] : []),
  ].join('\n')
}

// ---------- 5. product copy (govern-ai-spend) ----------
const COPY = {
  'oak serving board': "**Oak serving board**\nCut from a single piece of FSC-certified European oak and finished with food-safe linseed oil. Big enough for a cheese board for six, small enough to slide into a drawer. Wash by hand and oil it now and then, and it will last for years.",
  'linen napkins': "**Stonewashed linen napkins, set of 4**\nSoft from the first use, because the linen is washed before it is sewn. 45 by 45 cm, with mitred corners that stay flat. Machine wash at 40 degrees; they get softer every time.",
  'ceramic pendant lamp': "**Ceramic pendant lamp, chalk**\nHand-thrown stoneware shade in a matt chalk glaze, 28 cm across, on a 1.5 m cotton-covered cord. Takes an E27 bulb up to 60 W. Every shade is slightly different, so yours is one of a kind.",
}
function copy(st) {
  const want = Object.keys(COPY).filter((k) => st.userText.toLowerCase().includes(k))
  return { content: (want.length ? want : Object.keys(COPY)).map((k) => COPY[k]).join('\n\n') }
}

function sideCall(st) {
  if (/pick out what is worth remembering|extract.*facts/i.test(st.system)) return { content: JSON.stringify({ facts: [] }) }
  if (/title/i.test(st.system) && /conversation/i.test(st.system) && !st.tools.length) return { content: 'Conversation' }
  if (/verdict|refute/i.test(st.system)) return { content: '{"verdict":"pass","confidence":0.9,"issues":[]}' }
  return null
}

export function decide(body, vendor = 'openai') {
  const st = stateOf(body)
  let out = sideCall(st)
  if (!out) {
    if (/Stripe payouts/i.test(st.system)) out = payouts(st)
    else if (/check Larkspur Home's shop data/i.test(st.system)) out = quality(st)
    else if (/answer questions about Larkspur Home's shop data/i.test(st.system)) out = ask(st)
    else if (/supplier contracts/i.test(st.all) || (/^Several responses to the same question/.test(st.userText.trim()) && /Clause \d|cannot see a contract/.test(st.userText))) out = contract(st, body, vendor)
    else if (/product descriptions/i.test(st.system)) out = copy(st)
    else out = { content: 'Done.' }
  }
  if (process.env.CONTRACT_TRACE && /supplier contracts/i.test(st.all)) {
    try { appendFileSync(`${LOG}.contract`, JSON.stringify({ vendor, model: body.model, messages: (body.messages || []).map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 1500) : (m.content || []).map((p) => `${p.type}:${(p.text || p.file?.filename || '').slice(0, 1500)}`) })) }) + '\n') } catch {}
  }
  try {
    appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(), vendor, model: body.model, tools: st.tools.slice(0, 40), system: st.system.slice(0, 300), user: st.userText.slice(0, 400),
      out: out.toolCalls ? out.toolCalls.map((c) => [c.id, c.name, JSON.stringify(c.args).slice(0, 300)]) : out.content.slice(0, 300),
    }) + '\n')
  } catch {}
  return out
}
