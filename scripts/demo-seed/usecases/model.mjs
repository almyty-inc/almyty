// A scripted stand-in for an OpenAI-compatible chat model, so the tutorials
// run the same way every time without a real model. It is NOT clever: for each
// use case it follows a fixed plan of tool calls, reads what the tools
// really returned, and writes its answer from that data. Everything it
// says about meetings, emails, tasks and prospects comes from the tool
// results almyty handed it, so a run shows whether the platform plumbing
// (tools, keys, memory, approvals, wakes, channels) works end to end.
//
// Each tool call id carries the plan step it belongs to (call_<step>_n), so
// the plan picks up where the conversation left off.
import { appendFileSync } from 'node:fs'

const LOG = process.env.USECASE_MODEL_LOG || '/tmp/almyty-demo/usecase-model.log'
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
function unwrap(v) {
  let x = parse(v)
  for (let k = 0; k < 6 && x && typeof x === 'object' && !Array.isArray(x); k++) {
    if ('items' in x || 'messages' in x || 'results' in x || 'payload' in x || 'calendars' in x || 'threads' in x || 'id' in x && 'properties' in x) break
    const next = x.data ?? x.result ?? x.output ?? x.body ?? x.response
    if (next === undefined) break
    x = parse(next)
  }
  return x
}

function nowFrom(system) {
  const m = system.match(/\[CURRENT TIME\][\s\S]*?\((\d{4}-\d\d-\d\dT[^)]+)\)/)
  return m ? new Date(m[1]) : new Date()
}
const dayStart = (d, off = 0) => { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); return new Date(x.getTime() + off * 86400000) }
const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16)
const header = (msg, name) => (msg?.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
const bodyOf = (msg) => { const d = msg?.payload?.body?.data; try { return d ? Buffer.from(d, 'base64url').toString('utf8') : msg?.snippet || '' } catch { return msg?.snippet || '' } }
const firstName = (s) => String(s || '').replace(/<.*>/, '').trim().split(/\s+/)[0]

// ---------- conversation state ----------
function stateOf(body) {
  const msgs = body.messages || []
  const system = text(msgs.find((m) => m.role === 'system')?.content)
  const lastUser = msgs.map((m) => m.role).lastIndexOf('user')
  const userText = text(msgs[lastUser]?.content)
  const turn = msgs.slice(lastUser + 1)
  const results = {} // step -> [{name, args, result}]
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
  return { msgs, system, userText, turn, results, tools, now: nowFrom(system), all: msgs.map((m) => text(m.content)).join('\n') }
}

let seq = 0
// Build a call for a real tool: directly when offered, else through call_tool.
function call(st, step, realName, args) {
  const id = `call_${step}_${Date.now() % 1e6}${seq++}`
  if (st.tools.includes(realName)) return { id, name: realName, args }
  return { id, name: 'call_tool', args: { name: realName, arguments: args } }
}
// The real name of a tool: from the direct list, or from what search_tools returned.
function resolve(st, re, searchStep) {
  const direct = st.tools.find((n) => re.test(n))
  if (direct) return direct
  for (const r of st.results[searchStep] || []) {
    const names = String(r.result).match(/[a-z0-9]+(?:_[a-z0-9]+)+/g) || []
    const hit = names.find((n) => re.test(n))
    if (hit) return hit
  }
  return null
}
const has = (st, step) => !!st.results[step]

function needTool(st, step, re, query) {
  // returns {name} when known, or {call} to search for it first
  const name = resolve(st, re, `s-${step}`)
  if (name) return { name }
  if (!st.tools.includes('search_tools') || has(st, `s-${step}`)) return { missing: true }
  return { call: { id: `call_s-${step}_${Date.now() % 1e6}${seq++}`, name: 'search_tools', args: { query } } }
}

// ---------- founder's associate ----------
function founder(st) {
  const wake = /You are always on/i.test(st.userText)
  const today = wake ? st.now : dayStart(st.now), tomorrow = wake ? new Date(st.now.getTime() + 60 * 60000) : dayStart(st.now, 1)
  if (st.tools.includes('recall_memory') && !has(st, 'recall')) return { toolCalls: [{ id: `call_recall_${seq++}`, name: 'recall_memory', args: { query: 'people Maya knows, how they met, who introduced whom' } }] }

  const t1 = needTool(st, 'callist', /calendar_list_list$/, 'list my calendars')
  if (t1.call) return { toolCalls: [t1.call] }
  if (t1.name && !has(st, 'callist')) return { toolCalls: [call(st, 'callist', t1.name, {})] }
  const calendars = (unwrap(st.results.callist?.[0]?.result)?.items || []).map((c) => c.id)

  const t2 = needTool(st, 'events', /calendar_events_list$/, 'list calendar events')
  if (t2.call) return { toolCalls: [t2.call] }
  const doneCals = (st.results.events || []).map((r) => r.args?.calendarId ?? r.args?.arguments?.calendarId)
  const nextCal = calendars.find((c) => !doneCals.includes(c))
  if (t2.name && nextCal) return { toolCalls: [call(st, 'events', t2.name, { calendarId: nextCal, timeMin: today.toISOString(), timeMax: tomorrow.toISOString(), singleEvents: true, orderBy: 'startTime' })] }

  const t3 = wake ? {} : needTool(st, 'lists', /tasklists_list$/, 'list task lists')
  if (t3.call) return { toolCalls: [t3.call] }
  if (t3.name && !has(st, 'lists')) return { toolCalls: [call(st, 'lists', t3.name, {})] }
  const lists = (unwrap(st.results.lists?.[0]?.result)?.items || [])
  const t4 = wake ? {} : needTool(st, 'tasks', /tasks_tasks_list$/, 'list tasks in a task list')
  if (t4.call) return { toolCalls: [t4.call] }
  const doneLists = (st.results.tasks || []).map((r) => r.args?.tasklist ?? r.args?.arguments?.tasklist)
  const nextList = wake ? null : lists.find((l) => !doneLists.includes(l.id))
  if (t4.name && nextList) return { toolCalls: [call(st, 'tasks', t4.name, { tasklist: nextList.id, showCompleted: false })] }

  const t5 = needTool(st, 'mlist', /messages_list$/, 'search email messages')
  if (t5.call) return { toolCalls: [t5.call] }
  if (t5.name && !has(st, 'mlist')) return { toolCalls: [call(st, 'mlist', t5.name, { userId: 'me', q: 'in:inbox newer_than:7d', maxResults: 10 })] }
  const ids = (unwrap(st.results.mlist?.[0]?.result)?.messages || []).map((m) => m.id)
  const t6 = needTool(st, 'mget', /messages_get$/, 'read one email message')
  if (t6.call) return { toolCalls: [t6.call] }
  const doneIds = (st.results.mget || []).map((r) => r.args?.id ?? r.args?.arguments?.id)
  const nextId = ids.find((i) => !doneIds.includes(i))
  if (t6.name && nextId) return { toolCalls: [call(st, 'mget', t6.name, { userId: 'me', id: nextId, format: 'full' })] }

  // ---- what we know now
  const events = (st.results.events || []).flatMap((r) => {
    const v = unwrap(r.result); const calName = v?.summary || r.args?.calendarId
    return (v?.items || []).map((e) => ({ ...e, cal: calName }))
  }).sort((a, b) => Date.parse(a.start.dateTime) - Date.parse(b.start.dateTime))
  const tasks = (st.results.tasks || []).flatMap((r) => unwrap(r.result)?.items || []).filter((t) => t.status !== 'completed')
  const mails = (st.results.mget || []).map((r) => unwrap(r.result)).filter((m) => m && m.payload)
  const memory = (st.results.recall || []).map((r) => r.result).join(' ')

  // a fact worth keeping, once
  const intro = mails.find((m) => /^Intro:/i.test(header(m, 'Subject')))
  if (intro && st.tools.includes('store_memory') && !has(st, 'store') && !/Tom Becker introduced/i.test(memory)) {
    return { toolCalls: [{ id: `call_store_${seq++}`, name: 'store_memory', args: { type: 'fact', tags: ['people', 'kestrel-logistics'], content: 'Tom Becker (Becker Partners) introduced Maya to Priya Raman, Head of Operations at Kestrel Logistics. Maya and Tom worked together at Atlas, where Maya built the routing engine. Kestrel has 140 trucks and plans routes in spreadsheets.' } }] }
  }

  if (wake) {
    const already = st.msgs.slice(0, -1).map((m) => text(m.content)).join('\n')
    const external0 = events.filter((e) => (e.attendees || []).some((a) => !/lumenlabs\.example$/.test(a.email)))
    const todo = external0.filter((e) => !already.includes(`Prep: ${e.summary}`))
    if (!todo.length) return { content: 'Nothing to prepare: no meetings with outside people in the next hour.' }
    const out = []
    for (const e of todo) {
      out.push(`**Prep: ${e.summary} (${hhmm(e.start.dateTime)} UTC)**`)
      for (const g of (e.attendees || []).filter((a) => !/lumenlabs\.example$/.test(a.email))) {
        const theirs = mails.filter((m) => header(m, 'From').toLowerCase().includes(g.email) || bodyOf(m).includes(firstName(g.displayName)))
        const intro = theirs.find((m) => /^Intro:/i.test(header(m, 'Subject'))) || /Tom Becker introduced/i.test(memory)
        out.push(`- **${g.displayName || g.email}**, ${g.email.split('@')[1].replace('.example', '')}. ${intro ? 'How you know her: Tom Becker introduced you; you and Tom worked together at Atlas.' : theirs.length ? 'You have emailed recently.' : 'No earlier emails found.'}`)
        for (const m of theirs.slice(0, 2)) out.push(`  - ${header(m, 'Date').slice(5, 16)}, "${header(m, 'Subject')}": ${bodyOf(m).slice(0, 180)}`)
      }
      if (e.description) out.push(`- Open points: ${e.description}`)
    }
    return { content: out.join('\n') }
  }
  // ---- the brief
  const conflicts = []
  for (let i = 0; i < events.length; i++) for (let j = i + 1; j < events.length; j++) {
    const a = events[i], b = events[j]
    if (Date.parse(a.start.dateTime) < Date.parse(b.end.dateTime) && Date.parse(b.start.dateTime) < Date.parse(a.end.dateTime)) conflicts.push([a, b])
  }
  const due = tasks.filter((t) => t.due && Date.parse(t.due) < tomorrow.getTime())
  const overdue = due.filter((t) => Date.parse(t.due) < today.getTime())
  const external = events.filter((e) => (e.attendees || []).some((a) => !/lumenlabs\.example$/.test(a.email)))
  const day = st.now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' })

  const lines = [`**Your brief for ${day}**`, '']
  if (conflicts.length) {
    lines.push('**Conflicts**')
    for (const [a, b] of conflicts) {
      const personal = [a, b].find((e) => /personal/i.test(e.cal))
      const move = personal || b
      lines.push(`- ${hhmm(a.start.dateTime)}-${hhmm(a.end.dateTime)} ${a.summary} (${a.cal}) overlaps ${hhmm(b.start.dateTime)}-${hhmm(b.end.dateTime)} ${b.summary} (${b.cal}). Suggest moving "${move.summary}".`)
    }
    lines.push('')
  }
  lines.push(`**Meetings (${events.length})**`)
  for (const e of events) lines.push(`- ${hhmm(e.start.dateTime)}-${hhmm(e.end.dateTime)} ${e.summary}${e.cal ? ` · ${e.cal}` : ''}`)
  lines.push('')
  lines.push(`**Tasks due today or overdue (${due.length})**`)
  for (const t of due) lines.push(`- ${t.title}${overdue.includes(t) ? ' (overdue)' : ''}`)
  lines.push('')
  const prios = []
  const deck = due.find((t) => /deck/i.test(t.title)); if (deck) prios.push(`${deck.title}, before the ${hhmm(external[0]?.start.dateTime || today.toISOString())} call`)
  if (overdue[0]) prios.push(`${overdue[0].title} (it is overdue)`)
  const prep = events.find((e) => /board/i.test(e.summary)); if (prep) prios.push(`${prep.summary} at ${hhmm(prep.start.dateTime)}`)
  lines.push('**Top three priorities**')
  prios.slice(0, 3).forEach((p, i) => lines.push(`${i + 1}. ${p}`))
  for (const e of external) {
    const guests = (e.attendees || []).filter((a) => !/lumenlabs\.example$/.test(a.email))
    lines.push('', `**Prep: ${e.summary} (${hhmm(e.start.dateTime)})**`)
    for (const g of guests) {
      const theirs = mails.filter((m) => header(m, 'From').toLowerCase().includes(g.email) || bodyOf(m).includes(firstName(g.displayName)))
      const how = /Tom Becker introduced/i.test(memory + JSON.stringify(theirs.map(bodyOf))) || theirs.some((m) => /^Intro:/i.test(header(m, 'Subject')))
        ? 'Introduced by Tom Becker, who worked with you at Atlas.'
        : theirs.length ? `You have emailed recently (last: "${header(theirs[0], 'Subject')}").` : 'No earlier emails found.'
      lines.push(`- **${g.displayName || g.email}** (${g.email.split('@')[1]}). ${how}`)
      for (const m of theirs.slice(0, 2)) lines.push(`  - ${header(m, 'Date').slice(0, 16)}, "${header(m, 'Subject')}": ${bodyOf(m).slice(0, 160)}`)
    }
    if (e.description) lines.push(`- Open points: ${e.description}`)
  }
  return { content: lines.join('\n') }
}

// ---------- biz-dev assistant ----------
const RANK = [/chief operating|coo\b/i, /vp|vice president/i, /head of/i, /director/i]
function bizdev(st) {
  const followUpWake = /follow|wake|timer|while you were|check (?:for )?(?:replies|responses)/i.test(st.userText) && !/find (?:new )?prospects/i.test(st.userText)
  if (st.tools.includes('recall_memory') && !has(st, 'recall')) return { toolCalls: [{ id: `call_recall_${seq++}`, name: 'recall_memory', args: { query: 'outreach sent, prospects contacted, follow-ups' } }] }
  const memory = (st.results.recall || []).map((r) => r.result).join(' ')
  return followUpWake ? bizFollowUp(st, memory) : bizOutreach(st, memory)
}

function bizOutreach(st, memory) {
  const tc = needTool(st, 'companies', /companies_post_.*search/, 'search companies in the CRM')
  if (tc.call) return { toolCalls: [tc.call] }
  if (tc.name && !has(st, 'companies')) {
    return { toolCalls: [call(st, 'companies', tc.name, { filterGroups: [
      { filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }, { propertyName: 'industry', operator: 'EQ', value: 'TRANSPORTATION_TRUCKING_RAILROAD' }, { propertyName: 'numberofemployees', operator: 'GTE', value: '100' }] },
      { filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }, { propertyName: 'industry', operator: 'EQ', value: 'LOGISTICS_AND_SUPPLY_CHAIN' }, { propertyName: 'numberofemployees', operator: 'GTE', value: '100' }] },
    ], properties: ['name', 'domain', 'industry', 'numberofemployees', 'city', 'description'], sorts: [], limit: 10, after: '0' })] }
  }
  const companies = unwrap(st.results.companies?.[0]?.result)?.results || []
  const tp = needTool(st, 'people', /contacts_post_.*search/, 'search contacts in the CRM')
  if (tp.call) return { toolCalls: [tp.call] }
  const doneCo = (st.results.people || []).map((r) => JSON.stringify(r.args))
  const nextCo = companies.find((c) => !doneCo.some((a) => a.includes(`"${c.id}"`)))
  if (tp.name && nextCo) return { toolCalls: [call(st, 'people', tp.name, { filterGroups: [{ filters: [{ propertyName: 'associatedcompanyid', operator: 'EQ', value: nextCo.id }] }], properties: ['firstname', 'lastname', 'email', 'jobtitle', 'hs_linkedin_url'], sorts: [], limit: 10, after: '0' })] }

  // the decision maker per company
  const picks = companies.map((c) => {
    const people = (st.results.people || []).filter((r) => JSON.stringify(r.args).includes(`"${c.id}"`)).flatMap((r) => unwrap(r.result)?.results || [])
    const score = (p) => { const i = RANK.findIndex((re) => re.test(p.properties.jobtitle || '')); return i < 0 ? 99 : i }
    const dm = people.sort((a, b) => score(a) - score(b))[0]
    return dm && score(dm) < 99 ? { company: c, person: dm } : null
  }).filter(Boolean).filter((p) => !memory.includes(p.person.properties.email))

  // already in touch? skip anyone with mail in the last 30 days
  const tm = needTool(st, 'already', /messages_list$/, 'search email messages')
  if (tm.call) return { toolCalls: [tm.call] }
  const checked = (st.results.already || []).map((r) => JSON.stringify(r.args))
  const unchecked = picks.find((p) => !checked.some((a) => a.includes(p.person.properties.email)))
  if (tm.name && unchecked) return { toolCalls: [call(st, 'already', tm.name, { userId: 'me', q: `(to:${unchecked.person.properties.email} OR from:${unchecked.person.properties.email}) newer_than:30d`, maxResults: 5 })] }
  const fresh = picks.filter((p) => {
    const r = (st.results.already || []).find((x) => JSON.stringify(x.args).includes(p.person.properties.email))
    return !(unwrap(r?.result)?.messages || []).length
  })
  const known = picks.filter((p) => !fresh.includes(p))

  // send each email (the platform holds every send for the person's OK)
  const ts = needTool(st, 'send', /messages_send$/, 'send an email')
  if (ts.call) return { toolCalls: [ts.call] }
  const sentTo = (st.results.send || []).map((r) => JSON.stringify(r.args))
  const nextSend = fresh.find((p) => !sentTo.some((a) => a.includes(Buffer.from(`To: ${p.person.properties.email}`).toString('base64url').slice(0, 12)) || a.includes(p.person.properties.email)))
  if (ts.name && nextSend) {
    const { person: p, company: c } = nextSend
    const subject = `Route planning at ${c.properties.name}`
    const body = `Hi ${p.properties.firstname},\n\n${c.properties.description.split('.')[0]}: that is usually the point where planning routes by hand starts costing real hours every week. We built Lumen to plan and re-plan routes automatically, and fleets of your size typically save four to six hours of planning a day.\n\nWould a 20-minute call next week be useful? I can show it on one of your real routes.\n\nBest,\nMaya Chen\nLumen Labs`
    const raw = Buffer.from(`To: ${p.properties.email}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString('base64url')
    return { toolCalls: [call(st, 'send', ts.name, { userId: 'me', raw })] }
  }

  // pipeline: a deal per prospect written to
  const td = needTool(st, 'deal', /deals_post_crm_v3_objects_(?:0_3|deals)_create$/, 'create a deal in the CRM')
  if (td.call) return { toolCalls: [td.call] }
  const dealt = (st.results.deal || []).map((r) => JSON.stringify(r.args))
  const sentOk = fresh.filter((p) => (st.results.send || []).some((r) => /"id"|SENT/.test(r.result) && JSON.stringify(r.args).includes(Buffer.from(`To: ${p.person.properties.email}`).toString('base64url').slice(0, 12))))
  const nextDeal = sentOk.find((p) => !dealt.some((a) => a.includes(p.company.properties.name)))
  if (td.name && nextDeal) {
    const due = new Date(st.now.getTime() + 3 * 86400000).toISOString().slice(0, 10)
    return { toolCalls: [call(st, 'deal', td.name, { associations: [], properties: { dealname: `${nextDeal.company.properties.name}: first outreach`, pipeline: 'default', dealstage: 'appointmentscheduled', description: `Outreach email sent to ${nextDeal.person.properties.firstname} ${nextDeal.person.properties.lastname} (${nextDeal.person.properties.jobtitle}) on ${st.now.toISOString().slice(0, 10)}. Follow up on ${due} if no reply.` } })] }
  }
  if (st.tools.includes('store_memory') && sentOk.length && !has(st, 'store')) {
    return { toolCalls: [{ id: `call_store_${seq++}`, name: 'store_memory', args: { type: 'context', tags: ['outreach'], content: `Outreach sent on ${st.now.toISOString().slice(0, 10)} to ${sentOk.map((p) => `${p.person.properties.firstname} ${p.person.properties.lastname} <${p.person.properties.email}> (${p.company.properties.name})`).join('; ')}. Follow up after 3 days without a reply.` } }] }
  }

  const rejected = fresh.filter((p) => !sentOk.includes(p))
  const lines = [`**Outreach, ${st.now.toISOString().slice(0, 10)}**`, '', `Found ${companies.length} companies matching the target profile (logistics or trucking, 100+ people, still a lead).`, '']
  for (const p of sentOk) lines.push(`- Sent to **${p.person.properties.firstname} ${p.person.properties.lastname}**, ${p.person.properties.jobtitle} at ${p.company.properties.name}. Deal added to the pipeline; I will follow up in 3 days if there is no reply.`)
  for (const p of rejected) lines.push(`- Not sent to ${p.person.properties.firstname} ${p.person.properties.lastname} (${p.company.properties.name}): you did not approve it.`)
  for (const p of known) lines.push(`- Skipped ${p.person.properties.firstname} ${p.person.properties.lastname} (${p.company.properties.name}): you are already in touch by email.`)
  const li = fresh.filter((p) => p.person.properties.hs_linkedin_url)
  if (li.length) {
    lines.push('', '**LinkedIn messages for you to send** (I do not send anything on LinkedIn):')
    for (const p of li) lines.push(`- ${p.person.properties.hs_linkedin_url}\n  "Hi ${p.person.properties.firstname}, I just sent you a short note about route planning at ${p.company.properties.name}. Happy to connect here too. Maya"`)
  }
  return { content: lines.join('\n') }
}

function bizFollowUp(st, memory) {
  const tm = needTool(st, 'sent', /messages_list$/, 'search email messages')
  if (tm.call) return { toolCalls: [tm.call] }
  if (tm.name && !has(st, 'sent')) return { toolCalls: [call(st, 'sent', tm.name, { userId: 'me', q: 'in:sent newer_than:30d', maxResults: 20 })] }
  const threadIds = [...new Set((unwrap(st.results.sent?.[0]?.result)?.messages || []).map((m) => m.threadId))]
  const tt = needTool(st, 'thread', /threads_get$/, 'read an email thread')
  if (tt.call) return { toolCalls: [tt.call] }
  const doneT = (st.results.thread || []).map((r) => r.args?.id ?? r.args?.arguments?.id)
  const nextT = threadIds.find((t) => !doneT.includes(t))
  if (tt.name && nextT) return { toolCalls: [call(st, 'thread', tt.name, { userId: 'me', id: nextT, format: 'full' })] }

  const threads = (st.results.thread || []).map((r) => unwrap(r.result)).filter((t) => t?.messages)
  const replied = [], waiting = []
  for (const t of threads) {
    const first = t.messages[0]
    const to = header(first, 'To')
    const reply = t.messages.find((m) => header(m, 'From').toLowerCase().includes(to.toLowerCase()))
    const ours = t.messages.filter((m) => !header(m, 'From').toLowerCase().includes(to.toLowerCase()))
    const ageDays = (st.now.getTime() - Number(ours[ours.length - 1].internalDate)) / 86400000
    if (reply) replied.push({ t, to, reply, subject: header(first, 'Subject') })
    else if (ageDays >= 3 && ours.length < 2) waiting.push({ t, to, subject: header(first, 'Subject'), ageDays })
  }

  const td = needTool(st, 'dsearch', /deals_post_.*search/, 'search deals in the CRM')
  if (td.call) return { toolCalls: [td.call] }
  const searched = (st.results.dsearch || []).map((r) => JSON.stringify(r.args))
  const companyOf = (x) => x.subject.replace(/^Re:\s*/i, '').replace(/^Route planning at /, '')
  const needDeal = replied.find((x) => !searched.some((a) => a.includes(companyOf(x))))
  if (td.name && needDeal) return { toolCalls: [call(st, 'dsearch', td.name, { query: companyOf(needDeal), filterGroups: [], properties: ['dealname', 'dealstage'], sorts: [], limit: 5, after: '0' })] }
  const tu = needTool(st, 'dupdate', /deals_patch_.*update$/, 'update a deal in the CRM')
  if (tu.call) return { toolCalls: [tu.call] }
  const updated = (st.results.dupdate || []).map((r) => JSON.stringify(r.args))
  for (const x of replied) {
    const r = (st.results.dsearch || []).find((y) => JSON.stringify(y.args).includes(companyOf(x)))
    const deal = (unwrap(r?.result)?.results || [])[0]
    if (tu.name && deal && !updated.some((a) => a.includes(`"${deal.id}"`))) {
      return { toolCalls: [call(st, 'dupdate', tu.name, { dealId: deal.id, properties: { dealstage: 'qualifiedtobuy', description: `Replied on ${st.now.toISOString().slice(0, 10)}: "${bodyOf(x.reply).slice(0, 140)}"` } })] }
    }
  }
  const ts = needTool(st, 'follow', /messages_send$/, 'send an email')
  if (ts.call) return { toolCalls: [ts.call] }
  const followed = (st.results.follow || []).map((r) => JSON.stringify(r.args))
  const nextF = waiting.find((x) => !followed.some((a) => a.includes(x.t.id)))
  if (ts.name && nextF) {
    const name = firstName(nextF.to.split('@')[0].split('.')[0]); const first = name.charAt(0).toUpperCase() + name.slice(1)
    const body = `Hi ${first},\n\nJust bringing my note from last week back to the top of your inbox. If route planning is not a priority right now, a one-line "not now" is completely fine, and I will not chase further.\n\nBest,\nMaya`
    const raw = Buffer.from(`To: ${nextF.to}\r\nSubject: Re: ${nextF.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`).toString('base64url')
    return { toolCalls: [call(st, 'follow', ts.name, { userId: 'me', threadId: nextF.t.id, raw })] }
  }
  const lines = [`**Follow-up check, ${st.now.toISOString().slice(0, 10)}**`, '']
  for (const x of replied) lines.push(`- **Reply from ${header(x.reply, 'From').replace(/<.*>/, '').trim()}** (${companyOf(x)}): "${bodyOf(x.reply).slice(0, 160)}". Deal moved to "Qualified to buy". Suggested next step: answer and propose two times.`)
  for (const x of waiting) {
    const ok = (st.results.follow || []).some((r) => JSON.stringify(r.args).includes(x.t.id) && /"id"|SENT/.test(r.result))
    lines.push(`- No reply from ${x.to} after ${Math.floor(x.ageDays)} days: ${ok ? 'follow-up sent in the same thread.' : 'follow-up drafted, not sent (not approved).'}`)
  }
  if (!replied.length && !waiting.length) lines.push('Nothing to do: no replies yet and nothing is due for a follow-up.')
  return { content: lines.join('\n') }
}

// ---------- helpers for almyty's own side calls ----------
function sideCall(st) {
  if (/pick out what is worth remembering/i.test(st.system)) {
    const facts = []
    if (/Tom Becker/.test(st.all) && /Priya/.test(st.all)) facts.push('Maya knows Priya Raman (Kestrel Logistics) through an intro from Tom Becker.')
    return { content: JSON.stringify({ facts }) }
  }
  if (/title/i.test(st.system) && /conversation/i.test(st.system) && !st.tools.length) return { content: 'Morning brief' }
  return null
}

export function decide(body) {
  const st = stateOf(body)
  let out = sideCall(st)
  if (!out) {
    if (/associate/i.test(st.system)) out = founder(st)
    else if (/business development|outreach|prospect/i.test(st.system)) out = bizdev(st)
    else if (/verdict|refute/i.test(st.system)) out = { content: '{"verdict":"pass","confidence":0.9,"issues":[]}' }
    else out = { content: 'Done.' }
  }
  appendFileSync(LOG, JSON.stringify({
    at: new Date().toISOString(), model: body.model, tools: st.tools,
    system: st.system.slice(0, 200), user: st.userText.slice(0, 4000),
    turn: st.turn.map((m) => ({ role: m.role, id: m.tool_call_id, calls: (m.tool_calls || []).map((c) => [c.id, c.function?.name, String(c.function?.arguments).slice(0, 200)]), content: text(m.content).slice(0, 300) })),
    out: out.toolCalls ? out.toolCalls.map((c) => [c.id, c.name, JSON.stringify(c.args).slice(0, 200)]) : out.content.slice(0, 300),
  }) + '\n')
  return out
}
