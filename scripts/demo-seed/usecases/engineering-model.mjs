// A scripted stand-in for an OpenAI-compatible chat model, so the
// engineering examples run the same way every time without a real model.
// It is NOT clever: for each example it follows a fixed plan of tool calls,
// reads what the tools really returned, and writes its answer from that
// data. Every label, comment, review line and incident summary it produces
// comes from the tool results almyty handed it, so a run shows whether the
// platform plumbing (tools, keys, schedules, channels, runners) works end
// to end. The judgement it applies (what counts as a duplicate, which diff
// lines deserve a comment) is a handful of fixed rules, written down here.
// In the coding-fleet example the work itself is done by the real coding
// assistants on the runner machine; this model only sequences the commands.
//
// Each tool call id carries the plan step it belongs to (call_<step>_n), so
// the plan picks up where the conversation left off.
import { appendFileSync } from 'node:fs'

const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : c == null ? '' : JSON.stringify(c))
function parse(s) {
  if (s == null) return null
  if (typeof s !== 'string') return s
  try { return JSON.parse(s) } catch {}
  const i = s.search(/[[{]/); const j = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)) } catch {} }
  return s
}
// Tool results arrive wrapped ({success, data}, {result}, ...); find the payload.
function unwrap(v) {
  let x = parse(v)
  for (let k = 0; k < 6 && x && typeof x === 'object' && !Array.isArray(x); k++) {
    const next = x.data ?? x.result ?? x.output ?? x.body ?? x.response
    if (next === undefined || ('id' in x) || ('number' in x) || ('incidents' in x) || ('incident' in x) || ('items' in x)) break
    x = parse(next)
  }
  return x
}
function nowFrom(system) {
  const m = system.match(/\[CURRENT TIME\][\s\S]*?\((\d{4}-\d\d-\d\dT[^)]+)\)/)
  return m ? new Date(m[1]) : new Date()
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
  return { msgs, system, userText, turn, results, tools, now: nowFrom(system) }
}

let seq = 0
const has = (st, step) => !!st.results[step]
const tool = (st, re) => st.tools.find((n) => re.test(n))
const call = (step, name, args) => ({ toolCalls: [{ id: `call_${step}_${Date.now() % 1e6}${seq++}`, name, args }] })
const done = (st, step) => (st.results[step] || []).map((r) => JSON.stringify(r.args))
const repoOf = (st) => (st.userText.match(/([a-z0-9-]+)\/([a-z0-9-]+)/i) || st.system.match(/([a-z0-9-]+)\/([a-z0-9-]+)/i) || [, 'tidewater-labs', 'ledgerly']).slice(1)

// ---------- issue triage ----------
const STOP = new Set(['add', 'the', 'a', 'an', 'to', 'of', 'on', 'in', 'is', 'are', 'how', 'do', 'i', 'my', 'invoice', 'invoices', 'missing', 'app', 'already', 'sent', 'month', 'created', 'with', 'for', 'when', 'and', 'it', 'change'])
const keywords = (title) => title.toLowerCase().replace(/[^a-z0-9\- ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).slice(0, 2)
function owners(system) {
  const map = {}
  for (const [, area, who] of system.matchAll(/(area: [a-z-]+)[^\n@]*?(@[a-z0-9-]+)/gi)) map[area.toLowerCase()] = who
  return map
}
function triage(st) {
  const [owner, repo] = repoOf(st)
  const base = { owner, repo }
  const tLabels = tool(st, /list_labels_for_repo$/), tList = tool(st, /issues_list_for_repo$/), tSearch = tool(st, /search_issues_and_pull_requests$/)
  const tAdd = tool(st, /issues_add_labels$/), tComment = tool(st, /issues_create_comment$/)
  if (tLabels && !has(st, 'labels')) return call('labels', tLabels, { ...base, per_page: 100 })
  const known = (unwrap(st.results.labels?.[0]?.result) || []).map((l) => l.name)
  const since = new Date(st.now.getTime() - 86400000).toISOString()
  if (!has(st, 'issues')) return call('issues', tList, { ...base, state: 'open', since, sort: 'created', direction: 'asc', per_page: 50 })
  const all = unwrap(st.results.issues[0].result)
  const fresh = (Array.isArray(all) ? all : []).filter((i) => !i.pull_request && !(i.labels || []).length && Date.parse(i.created_at) >= Date.parse(since)).sort((a, b) => a.number - b.number)

  // look for an older issue about the same thing
  const queryOf = (i) => `repo:${owner}/${repo} is:issue ${keywords(i.title).join(' ')}`
  for (const i of fresh) if (tSearch && !done(st, 'dup').some((a) => a.includes(`"${queryOf(i)}"`))) return call('dup', tSearch, { q: queryOf(i), per_page: 5 })
  const dupOf = (i) => {
    const r = (st.results.dup || []).find((x) => JSON.stringify(x.args).includes(`"${queryOf(i)}"`))
    const items = unwrap(r?.result)?.items || []
    return items.filter((x) => x.number < i.number && (x.labels || []).length).sort((a, b) => a.number - b.number)[0]
  }
  const map = owners(st.system)
  const plan = fresh.map((i) => {
    const t = `${i.title}\n${i.body || ''}`.toLowerCase()
    const orig = dupOf(i)
    const type = orig ? (orig.labels.find((l) => ['bug', 'feature', 'question'].includes(l.name))?.name) :
      /\?\s*$/.test(i.title.trim()) || /^how /i.test(i.title) ? 'question' : /crash|drops|missing|twice|error|broken|wrong/.test(t) ? 'bug' : /add |support|could ledgerly|would like|please add/.test(t) ? 'feature' : 'question'
    const area = orig ? orig.labels.find((l) => l.name.startsWith('area: '))?.name :
      /pdf|export|print/.test(t) ? 'area: pdf-export' : /qr|payment|payout|iban/.test(t) ? 'area: payments' : /invoice|currency|recurring/.test(t) ? 'area: invoices' : null
    const repro = type === 'bug' && !orig && !/steps to reproduce/.test(t)
    const labels = [type, area, orig && 'duplicate', repro && 'needs-repro'].filter((x) => x && known.includes(x))
    let comment = null
    if (orig) comment = `Thanks for the report! This looks like the same thing as #${orig.number} ("${orig.title}"), which the team is already tracking. Please follow #${orig.number} for updates, and add anything that differs in your case there.`
    else if (repro) comment = 'Thanks for reporting this. To track it down we need a bit more:\n\n1. What were you doing when it crashed (which page or screen)?\n2. Web, iOS or Android, and which version (Settings > About)?\n3. Does it happen every time? If so, the exact steps.\n\nA screenshot or the time it happened (with your time zone) helps too.'
    const who = area && map[area]
    const urgent = type === 'bug' && /since the .* update|regression|twice|every /.test(t) && !orig && !repro
    return { i, labels, comment, orig, who, urgent }
  })
  for (const p of plan) if (tAdd && p.labels.length && !done(st, 'label').some((a) => a.includes(`"issue_number":${p.i.number}`))) return call('label', tAdd, { ...base, issue_number: p.i.number, labels: p.labels })
  for (const p of plan) if (tComment && p.comment && !done(st, 'comment').some((a) => a.includes(`"issue_number":${p.i.number}`))) return call('comment', tComment, { ...base, issue_number: p.i.number, body: p.comment })

  if (!plan.length) return { content: `No new issues in ${owner}/${repo} in the last 24 hours. Nothing to do.` }
  const lines = [`**Triage of ${owner}/${repo}: ${plan.length} new issues in the last 24 hours**`, '']
  for (const p of plan) {
    const parts = [`Labelled ${p.labels.map((l) => `\`${l}\``).join(', ')}.`]
    if (p.orig) parts.push(`Duplicate of #${p.orig.number}; commented with a link.`)
    if (p.comment && !p.orig) parts.push('Asked for steps to reproduce.')
    if (p.who) parts.push(`Suggest ${p.who} (${p.labels.find((l) => l.startsWith('area: '))}).`)
    if (p.urgent) parts.push('**Looks urgent:** a regression that affects every customer with recurring invoices.')
    lines.push(`- **#${p.i.number} ${p.i.title}**: ${parts.join(' ')}`)
  }
  lines.push('', 'I did not close, assign or edit any issue.')
  return { content: lines.join('\n') }
}

// ---------- pull request review ----------
// The lines a patch adds, with their line numbers in the new file.
function added(patch) {
  const out = []
  let line = 0
  for (const l of String(patch || '').split('\n')) {
    const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/)
    if (h) { line = Number(h[1]); continue }
    if (l.startsWith('+')) { out.push({ line, text: l.slice(1) }); line++ } else if (l.startsWith('-')) continue
    else line++
  }
  return out
}
function review(st) {
  const [owner, repo] = repoOf(st)
  const base = { owner, repo }
  const tList = tool(st, /pulls_list$/), tGet = tool(st, /pulls_get$/), tFiles = tool(st, /pulls_list_files$/), tReviews = tool(st, /pulls_list_reviews$/), tCreate = tool(st, /pulls_create_review$/)
  let number = Number((st.userText.match(/#(\d+)|pull request (\d+)/i) || []).slice(1).find(Boolean)) || null
  if (!number) {
    if (!has(st, 'prs')) return call('prs', tList, { ...base, state: 'open', per_page: 20 })
    const prs = unwrap(st.results.prs[0].result) || []
    for (const pr of prs) if (tReviews && !done(st, 'reviews').some((a) => a.includes(`"pull_number":${pr.number}`))) return call('reviews', tReviews, { ...base, pull_number: pr.number })
    const todo = prs.find((pr) => !(unwrap((st.results.reviews || []).find((r) => JSON.stringify(r.args).includes(`"pull_number":${pr.number}`))?.result) || []).some((r) => /review\[bot\]/.test(r.user?.login || '')))
    if (!todo) return { content: `Every open pull request in ${owner}/${repo} already has my review. Nothing to do.` }
    number = todo.number
  }
  if (!has(st, 'pr')) return call('pr', tGet, { ...base, pull_number: number })
  if (!has(st, 'files')) return call('files', tFiles, { ...base, pull_number: number, per_page: 100 })
  const pr = unwrap(st.results.pr[0].result)
  const files = unwrap(st.results.files[0].result) || []
  const allowed = (st.system.match(/allowed dependencies?:?\s*([^\n]+)/i)?.[1] || '').toLowerCase()

  const comments = []
  const findings = []
  const hasTests = files.some((f) => /\.(test|spec)\.[tj]sx?$/.test(f.filename))
  for (const f of files) {
    const lines = added(f.patch)
    for (const { line, text: t } of lines) {
      const key = t.match(/['"](sk_live_[A-Za-z0-9]+|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})['"]/)
      if (key) {
        comments.push({ path: f.filename, line, side: 'RIGHT', body: `**Blocker: a live secret key is committed here.** The fallback value starting \`${key[1].slice(0, 12)}\` is a live Stripe key, and once pushed it is in the history for good. Remove the fallback (read it only from \`STRIPE_SECRET_KEY\`) and rotate this key in the Stripe dashboard today.` })
        findings.push(`a live Stripe key committed in \`${f.filename}\` line ${line}`)
      }
      if (f.filename === 'package.json') {
        const dep = t.match(/^\s*"([@a-z0-9/.-]+)":\s*"/)
        if (dep && allowed && !allowed.includes(dep[1].toLowerCase())) {
          comments.push({ path: f.filename, line, side: 'RIGHT', body: `\`${dep[1]}\` is a new dependency and not on our list. For dates we use \`date-fns\` (already a dependency): \`differenceInCalendarMonths\` covers what \`late-fees.ts\` needs.` })
          findings.push(`a new dependency, \`${dep[1]}\`, not on the allowed list`)
        }
      }
      if (/Math\.floor\(days \/ 30\)/.test(t) && lines.some((x) => /every started month/i.test(x.text))) {
        comments.push({ path: f.filename, line, side: 'RIGHT', body: 'The comment above says "every started month", but `Math.floor(days / 30)` counts only finished 30-day blocks: an invoice 29 days overdue gets no fee, 31 days gets one month. Either use `Math.ceil` or change the comment, and decide whether a month means 30 days or a calendar month.' })
        findings.push('months overdue are rounded down, while the comment says every started month')
      }
      if (/openAmount \* LATE_FEE_RATE/.test(t)) {
        comments.push({ path: f.filename, line, side: 'RIGHT', body: 'This returns fractions of a cent (for example 312.40 x 0.015 x 1 = 4.686). Round to cents before it is stored or shown, the same way `invoiceTotal()` does.' })
        findings.push('the fee is not rounded to cents')
      }
      if (/openAmount: invoice\.openAmount \+ fee/.test(t)) {
        comments.push({ path: f.filename, line, side: 'RIGHT', body: '**Bug: this charges the fee again every night.** The job runs daily and adds the full fee for all overdue months to `openAmount` each time, so an invoice two months overdue grows by 3% a night. Store which months were already charged (or compute the fee from the original amount and set it, rather than add to it).' })
        findings.push('the nightly job adds the fee again every night')
      }
    }
  }
  const tested = hasTests ? '' : 'There are no tests for `lateFee()` or `monthsOverdue()`. Please add some for: not overdue, 1 day, exactly 30 days, 31 days, and running the job twice on the same invoice.'
  if (!hasTests) findings.push('no tests for the new billing code')
  const summary = [`First pass by the review assistant (I don't approve or merge). ${findings.length} things to look at:`, '', ...findings.map((x, i) => `${i + 1}. ${x.charAt(0).toUpperCase() + x.slice(1)}.`), '', tested].join('\n').trim()
  // The instructions ask for code in double quotes, not backticks.
  const quoted = (s) => /backticks/i.test(st.system) ? s.replace(/`([^`]+)`/g, '"$1"') : s
  if (tCreate && !has(st, 'post')) return call('post', tCreate, { ...base, pull_number: number, commit_id: pr?.head?.sha, event: 'COMMENT', body: quoted(summary), comments: comments.map((c) => ({ ...c, body: quoted(c.body) })) })
  const posted = unwrap(st.results.post?.[0]?.result)
  const lines = [`**Reviewed #${number} "${pr?.title}" by ${pr?.user?.login}** (${files.length} files, +${pr?.additions}/-${pr?.deletions})`, '']
  findings.forEach((x, i) => lines.push(`${i + 1}. ${x.charAt(0).toUpperCase() + x.slice(1)}.`))
  lines.push('', posted?.html_url ? `Posted as a comment review with ${comments.length} line comments: ${posted.html_url}` : 'The review could not be posted; the findings are above.')
  return { content: lines.join('\n') }
}

// ---------- on-call summaries (PagerDuty) ----------
const ago = (now, iso) => { const m = Math.round((now - Date.parse(iso)) / 60000); return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago` }
const details = (alertsResult) => {
  const a = (unwrap(alertsResult)?.alerts || [])[0]
  const d = a?.body?.details
  return typeof d === 'string' ? parse(d) || {} : d || {}
}
const sameAlert = (a, b) => a.replace(/^\[[^\]]+\]\s*/, '').toLowerCase() === b.replace(/^\[[^\]]+\]\s*/, '').toLowerCase()
function oncall(st) {
  const service = st.system.match(/\(([A-Z0-9]{7})\)/)?.[1]
  const from = st.system.match(/([a-z0-9.-]+@[a-z0-9.-]+)\s*\(the From field\)/i)?.[1] || st.system.match(/as ([a-z0-9.-]+@[a-z0-9.-]+)/i)?.[1]
  const tList = tool(st, /list_incidents$/), tAlerts = tool(st, /list_incident_alerts$/), tNotes = tool(st, /list_incident_notes$/), tNote = tool(st, /create_incident_note$/)
  if (!has(st, 'open')) return call('open', tList, { 'statuses[]': ['triggered', 'acknowledged'], ...(service ? { 'service_ids[]': [service] } : {}), limit: 25 })
  const open = unwrap(st.results.open[0].result)?.incidents || []
  for (const i of open) if (!done(st, 'mine').some((a) => a.includes(`"${i.id}"`))) return call('mine', tNotes, { id: i.id })
  const fresh = open.filter((i) => {
    const r = (st.results.mine || []).find((x) => JSON.stringify(x.args).includes(`"${i.id}"`))
    return !(unwrap(r?.result)?.notes || []).some((n) => from && n.user?.email === from)
  })
  if (!fresh.length) return { content: open.length ? `Nothing new: the ${open.length} open incident${open.length > 1 ? 's' : ''} on the service already ha${open.length > 1 ? 've' : 's'} my note.` : 'No open incidents. Nothing to do.' }
  for (const i of fresh) if (!done(st, 'alerts').some((a) => a.includes(`"${i.id}"`))) return call('alerts', tAlerts, { id: i.id })
  const since = new Date(st.now.getTime() - 90 * 86400000).toISOString()
  if (!has(st, 'past')) return call('past', tList, { 'statuses[]': ['resolved'], ...(service ? { 'service_ids[]': [service] } : {}), since, limit: 100 })
  const past = unwrap(st.results.past[0].result)?.incidents || []
  const similar = (i) => past.filter((p) => sameAlert(p.title, i.title))
  for (const i of fresh) for (const p of similar(i)) if (!done(st, 'pastnotes').some((a) => a.includes(`"${p.id}"`))) return call('pastnotes', tNotes, { id: p.id })

  const summaries = fresh.map((i) => {
    const d = details((st.results.alerts || []).find((x) => JSON.stringify(x.args).includes(`"${i.id}"`))?.result)
    const prev = similar(i).map((p) => ({ p, notes: unwrap((st.results.pastnotes || []).find((x) => JSON.stringify(x.args).includes(`"${p.id}"`))?.result)?.notes || [] })).filter((x) => x.notes.length)
    const last = prev.sort((a, b) => Date.parse(b.p.created_at) - Date.parse(a.p.created_at))[0]
    const pool = /pool/i.test(d.error_sample || '')
    const deployedMin = d.deployed ? Math.round((Date.parse(i.created_at) - Date.parse(d.deployed)) / 60000) : null
    const cause = pool ? `the Postgres connection pool is exhausted (\`${d.error_sample}\`)${deployedMin != null && deployedMin < 120 ? `, ${deployedMin} minutes after ${d.version} was deployed` : ''}` : (d.error_sample || 'not clear from the alert')
    const lastNote = last?.notes[0]
    const runbook = i.service?.description?.match(/https?:\/\/\S+/)?.[0]
    const onCall = i.assignments?.[0]?.assignee?.summary
    const lines = [
      `**[#${i.incident_number}] ${i.title.replace(/^\[[^\]]+\]\s*/, '')}** (${i.status} ${ago(st.now, i.created_at)}${onCall ? `, ${onCall} is on call` : ''})`,
      `- **What fired:** ${d.monitor || 'the monitor'} at ${d.value} (threshold ${d.threshold})${d.top_endpoints ? `; ${d.top_endpoints}` : ''}.`,
      `- **Likely cause:** ${cause}.`,
      last ? `- **Last time:** #${last.p.incident_number}, ${ago(st.now, last.p.created_at)}, same alert. ${lastNote.user?.summary}: "${lastNote.content}"` : '- **Last time:** no earlier incident like this on the service.',
      `- **First check:** ${pool && d.version ? `did ${d.version} add a database connection per request? If yes, roll back to the release before it, as last time.` : 'the dashboard linked in the alert.'}`,
      `- ${runbook ? `Runbook: ${runbook} · ` : ''}Incident: ${i.html_url}${d.dashboard ? ` · Dashboard: ${d.dashboard}` : ''}`,
    ]
    const note = [`What fired: ${d.value} (threshold ${d.threshold})${d.top_endpoints ? `, ${d.top_endpoints}` : ''}.`, `Likely cause: ${cause.replace(/`/g, '')}.`,
      last ? `Last time (#${last.p.incident_number}): ${lastNote.content}` : '', `First check: ${pool && d.version ? `whether ${d.version} added a DB connection per request; if so roll back.` : 'the dashboard.'}`].filter(Boolean).join('\n')
    return { i, text: lines.join('\n'), note }
  })
  for (const s of summaries) if (tNote && !done(st, 'note').some((a) => a.includes(`"${s.i.id}"`))) return call('note', tNote, { id: s.i.id, ...(from ? { From: from } : {}), note: { content: s.note } })
  return { content: summaries.map((s) => s.text).join('\n\n') }
}

// ---------- the old SOAP stock system ----------
const xmlTag = (x, n) => [...String(x).matchAll(new RegExp(`<(?:\\w+:)?${n}>([^<]*)</(?:\\w+:)?${n}>`, 'g'))].map((m) => m[1])
function stock(st) {
  const tLevel = tool(st, /get_?stock_?level$/i), tReserve = tool(st, /reserve_?stock$/i)
  const sku = st.userText.match(/\b([A-Z]{2}-\d{5})\b/)?.[1]
  const qty = Number(st.userText.match(/\b(\d+)\s+(?:rolls|units|pallets|pieces|of)/i)?.[1] || 0)
  const names = { rotterdam: 'RTM', antwerp: 'ANR', hamburg: 'HAM' }
  const wh = Object.entries(names).find(([n]) => st.userText.toLowerCase().includes(n))?.[1]
  const order = st.userText.match(/\b(SO-\d+)\b/)?.[1]
  if (!sku) return { content: 'Which article do you mean? Give me its number, like HS-10442.' }
  if (!has(st, 'level')) return call('level', tLevel, { Sku: sku, ...(wh ? { WarehouseCode: wh } : {}) })
  const raw = text(unwrap(st.results.level[0].result))
  const desc = xmlTag(raw, 'Description')[0]
  const codes = xmlTag(raw, 'WarehouseCode'), onHand = xmlTag(raw, 'OnHand').map(Number)
  const here = wh ? onHand[codes.indexOf(wh)] : null
  const city = Object.fromEntries(Object.entries(names).map(([n, c]) => [c, n.charAt(0).toUpperCase() + n.slice(1)]))
  if (/reserve/i.test(st.userText) && order && wh && qty && here >= qty && tReserve && !has(st, 'reserve')) return call('reserve', tReserve, { Sku: sku, WarehouseCode: wh, Quantity: qty, OrderReference: order })
  const r = has(st, 'reserve') ? text(unwrap(st.results.reserve[0].result)) : ''
  const lines = [`**${sku}, ${desc}**: ${codes.map((c, k) => `${onHand[k]} on hand in ${city[c] || c}`).join(', ')}.`]
  if (r && xmlTag(r, 'ReservationId')[0]) lines.push(`Reserved ${qty} for order ${order} in ${city[wh]}: reservation **${xmlTag(r, 'ReservationId')[0]}**. ${xmlTag(r, 'RemainingOnHand')[0]} are left there.`)
  else if (r) lines.push(`The stock system refused the reservation: ${r.match(/<faultstring>([^<]*)/)?.[1] || r.slice(0, 200)}`)
  else if (qty && wh && here < qty) lines.push(`Not enough in ${city[wh]} for ${qty}; I did not reserve anything.`)
  return { content: lines.join('\n') }
}

// ---------- several coding assistants on one task (runner) ----------
function fleet(st) {
  const tList = tool(st, /agent[._]list$/), tShell = tool(st, /shell[._]exec$/)
  const task = st.userText.replace(/^\{"message":"|"\}$/g, '').replace(/\\"/g, '"').trim()
  const sh = (step, command, timeoutMs = 120000) => call(step, tShell, { command, timeoutMs })
  const out = (step) => {
    const v = unwrap(st.results[step]?.[0]?.result)
    if (v && typeof v === 'object' && ('stdout' in v || 'stderr' in v)) return `${v.stdout || ''}${v.stderr ? '\n' + v.stderr : ''}`
    return typeof v === 'string' ? v : JSON.stringify(v ?? '')
  }
  if (tList && !has(st, 'list')) return call('list', tList, {})
  const getCode = st.system.match(/Get the code: (.+)/)?.[1]?.trim()
  if (!has(st, 'copy')) return sh('copy', `${getCode} && echo copied`)
  const codePart = `${task} Write only the code in src/, do not write tests.`
  const testPart = `Write tests with node:test in test/ for this change, without touching src/: ${task} Cover a valid IBAN with spaces and lower case, and an IBAN with a wrong checksum.`
  if (!has(st, 'claude')) return sh('claude', `cd app && claude -p "${codePart.replace(/"/g, '\\"')}" --permission-mode acceptEdits`, 600000)
  if (!has(st, 'codex')) return sh('codex', `cd app && codex exec --sandbox workspace-write "${testPart.replace(/"/g, '\\"')}" < /dev/null`, 600000)
  if (!has(st, 'test')) return sh('test', 'cd app && npm test 2>&1 | tail -12')
  if (!has(st, 'diff')) return sh('diff', 'cd app && git add -A && git diff --cached --stat')
  const t = out('test')
  const pass = t.match(/pass (\d+)/)?.[1], fail = t.match(/fail (\d+)/)?.[1]
  const firstPara = (s) => s.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').slice(0, 420)
  const lines = ['**Done.** Two assistants worked on the copy of the project in my workspace:', '',
    `- **Claude Code** wrote the code: ${firstPara(out('claude'))}`,
    `- **Codex** wrote the tests: ${firstPara(out('codex'))}`,
    `- **Tests:** ${pass != null ? `${pass} passed, ${fail} failed` : firstPara(t)}.`,
    '', '**Changed files:**', '```', out('diff').trim(), '```']
  return { content: lines.join('\n') }
}

export function decide(body, opts = {}) {
  const st = stateOf(body)
  let out
  if (/You are a verifier/i.test(st.system)) out = { content: '{"verdict":"pass","failures":[],"passed_rules":["matches the tool results"]}' }
  else if (/title/i.test(st.system) && /conversation/i.test(st.system) && !st.tools.length) out = { content: 'Triage' }
  else if (/triage/i.test(st.system) && /issue/i.test(st.system)) out = triage(st)
  else if (/review/i.test(st.system) && /pull request/i.test(st.system)) out = review(st)
  else if (/on call/i.test(st.system) && /PagerDuty/.test(st.system)) out = oncall(st)
  else if (/Harbor Supply/.test(st.system) && /stock/i.test(st.system)) out = stock(st)
  else if (/coding assistants/i.test(st.system) && /Claude Code/.test(st.system)) out = fleet(st)
  else out = { content: 'Done.' }
  if (opts.log) appendFileSync(opts.log, JSON.stringify({ at: new Date().toISOString(), tools: st.tools, user: st.userText.slice(0, 500),
    turn: st.turn.map((m) => ({ role: m.role, calls: (m.tool_calls || []).map((c) => [c.id, c.function?.name]), content: text(m.content).slice(0, 200) })),
    out: out.toolCalls ? out.toolCalls.map((c) => [c.id, c.name, JSON.stringify(c.args).slice(0, 300)]) : out.content.slice(0, 300) }) + '\n')
  return out
}
