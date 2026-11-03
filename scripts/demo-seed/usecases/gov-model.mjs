// A scripted stand-in for an OpenAI-compatible chat model, for the
// governance example guides (gov-guides.mjs). Like usecases/model.mjs it is
// not clever: it follows a fixed plan of tool calls, reads what the tools
// really returned, and writes its answer from that data, so a run shows
// whether the platform plumbing (tools, approvals and their policies, the
// audit trail) works end to end.
//
// Each tool call id carries the plan step it belongs to (call_<step>_n).
import { appendFileSync } from 'node:fs'

const LOG = process.env.USECASE_MODEL_LOG || '/tmp/almyty-demo/gov-model.log'
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
  return { msgs, system, userText, results, tools }
}

let seq = 0
function call(st, step, realName, args) {
  const id = `call_${step}_${Date.now() % 1e6}${seq++}`
  if (st.tools.includes(realName)) return { id, name: realName, args }
  return { id, name: 'call_tool', args: { name: realName, arguments: args } }
}
const has = (st, step) => !!st.results[step]
const tool = (st, re) => st.tools.find((n) => re.test(n))
const eur = (cents) => `€${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const date = (s) => new Date(s * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

// ---------- the billing assistant ----------
function billing(st) {
  const u = st.userText
  const search = tool(st, /get_customers$/)
  const listCharges = tool(st, /get_charges$/)
  const refund = tool(st, /post_refunds$/)
  if (!search || !listCharges) return { content: 'I cannot look customers up: the Stripe tools are not available to me.' }
  if (!has(st, 'customer')) {
    const email = u.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/)?.[0]
    if (!email) return { content: 'Which email address is on the customer\'s account? I look customers up in Stripe by email.' }
    return { toolCalls: [call(st, 'customer', search, { email: email.toLowerCase(), limit: 3 })] }
  }
  const found = unwrap(st.results.customer[0].result, (x) => Array.isArray(x.data))?.data || []
  if (!found.length) return { content: 'I could not find that customer in Stripe. Could you give me the email address on the account?' }
  const cust = found[0]
  if (!has(st, 'charges')) return { toolCalls: [call(st, 'charges', listCharges, { customer: cust.id, limit: 10 })] }
  const charges = unwrap(st.results.charges[0].result, (x) => Array.isArray(x.data))?.data || []
  const wantsRefund = /refund/i.test(u)

  // Which charge, and how much.
  let target = null
  let amount = null
  let why = ''
  let stripeReason = 'requested_by_customer'
  const byInvoice = {}
  for (const c of charges) (byInvoice[c.invoice] ||= []).push(c)
  const dup = Object.values(byInvoice).find((g) => g.length > 1)
  if (/twice|double|duplicate/i.test(u) && dup) {
    const [later] = dup.slice().sort((a, b) => b.created - a.created)
    target = later; amount = later.amount; stripeReason = 'duplicate'
    why = `the ${later.description.replace(/^Invoice /, 'invoice ')} was collected twice (${date(dup[1].created)} and ${date(dup[0].created)})`
  } else {
    const asked = (u.match(/refund\s+€\s?(\d[\d,]*(?:\.\d+)?)/i) || [...u.matchAll(/€\s?(\d[\d,]*(?:\.\d+)?)/g)].pop())?.[1]
    target = charges[0]
    if (asked) amount = Math.round(Number(asked.replace(/,/g, '')) * 100)
    else amount = target?.amount
    why = /estimat|meter|reading/i.test(u) ? `the annual settlement was based on an estimated meter reading; the actual reading gives ${eur(target.amount - amount)}` : 'the customer asked for it'
  }

  if (!wantsRefund || !target) {
    const lines = charges.slice(0, 4).map((c) => `- ${date(c.created)}: ${eur(c.amount)}, ${c.description}${c.amount_refunded ? ` (refunded ${eur(c.amount_refunded)})` : ''}`)
    return { content: [`**${cust.name}** (${cust.description}). Latest charges in Stripe:`, ...lines].join('\n') }
  }

  // Over €500: a person decides first.
  const appr = st.results.approval?.[0]
  if (amount > 50000 && !appr) {
    const approval = tool(st, /^request_approval$/) || 'request_approval'
    return { toolCalls: [call(st, 'approval', approval, {
      reason: `Refund ${eur(amount)} to ${cust.name} (${cust.metadata?.contract || cust.id}): ${why}. Charge ${target.id}.`,
      payload: { amount_eur: amount / 100, customer: cust.name, charge: target.id, invoice: target.invoice },
    })] }
  }
  // A rejected request cancels the run, so being asked to go on after it means it was approved.
  if (!refund) return { content: 'I cannot make refunds: the Stripe refund tool is not available to me.' }
  if (!has(st, 'refund')) {
    return { toolCalls: [call(st, 'refund', refund, { charge: target.id, amount, reason: stripeReason, metadata: { contract: cust.metadata?.contract || '', requested_via: 'almyty billing assistant' } })] }
  }
  const r = unwrap(st.results.refund[0].result, (x) => x.object === 'refund' || 'error' in x)
  if (!r || r.error || r.object !== 'refund') return { content: `Stripe refused the refund: ${r?.error?.message || String(st.results.refund[0].result).slice(0, 300)}` }
  const approvedNote = appr ? ' It was approved first, as refunds over €500 need.' : ''
  return { content: [
    `Refunded **${eur(r.amount)}** to **${cust.name}** (${cust.metadata?.contract || cust.id}).${approvedNote}`,
    '',
    `- Stripe refund: \`${r.id}\` (${r.status})`,
    `- Charge: \`${target.id}\`, ${target.description}`,
    `- Reason: ${why}.`,
    '',
    'SEPA refunds reach the customer\'s bank in 5 to 10 business days.',
  ].join('\n') }
}

// ---------- the support assistant (multi-team guide; it is never run with tools) ----------
// ---------- the public website assistant (EU AI Act guide); it has no tools ----------
function help(st) {
  const u = st.userText
  if (/dynamic/i.test(u)) {
    const next = new Date(); next.setUTCMonth(next.getUTCMonth() + 1, 1)
    const first = next.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    return { content: `Yes. You can switch to the Dynamic tariff once a month, and a switch starts on the first day of the next month, so yours would start on ${first}.\n\nOn Dynamic you pay the hourly market price plus €0.021 per kWh, so your price changes during the day: using power when it is cheap, for example at night or on sunny afternoons, saves the most.\n\nTo switch, tell me the email address on your account, and our billing team will confirm by email within one working day.` }
  }
  return { content: 'I can help with tariffs, meter readings, moving house and paying your bill. What would you like to know?' }
}

function support(st) {
  return { content: 'I can help with questions about your Velora Energy contract and your meter readings. What would you like to know?' }
}

export async function decide(body) {
  const st = stateOf(body)
  let out
  if (/Velora Energy's finance team/i.test(st.system)) out = billing(st)
  else if (/support team/i.test(st.system)) out = support(st)
  else if (/customers on our website/i.test(st.system)) out = help(st)
  else out = { content: 'Hello.' }
  try { appendFileSync(LOG, `${new Date().toISOString()} ${JSON.stringify({ user: st.userText.slice(0, 200), steps: Object.keys(st.results), tools: st.tools.length, out }).slice(0, 2000)}\n`) } catch {}
  return out
}
