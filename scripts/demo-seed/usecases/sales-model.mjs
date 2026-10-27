// A scripted stand-in for an OpenAI-compatible chat model, for the support
// and sales example guides (sales-guides.mjs). Like usecases/model.mjs it is
// not clever: per use case it follows a fixed plan of tool calls, reads what
// the tools really returned, and writes its answer from that data, so a run
// shows whether the platform plumbing (tools, keys, memory, channels,
// schedules) works end to end.
//
// Each tool call id carries the plan step it belongs to (call_<step>_n).
import { appendFileSync } from 'node:fs'

const LOG = process.env.USECASE_MODEL_LOG || '/tmp/almyty-demo/sales-model.log'
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
    if ('results' in x || 'files' in x || 'type' in x && ('data' in x && x.type === 'list' || x.type === 'ticket') || 'id' in x && 'properties' in x) break
    const next = x.data ?? x.result ?? x.output ?? x.body ?? x.response
    if (next === undefined) break
    x = parse(next)
  }
  return x
}
const plain = (html) => String(html || '').replace(/<li>/g, '\n- ').replace(/<\/(p|ol|ul)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()

function stateOf(body) {
  const msgs = body.messages || []
  const system = text(msgs.find((m) => m.role === 'system')?.content)
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
function resolve(st, re, searchStep) {
  const direct = st.tools.find((n) => re.test(n))
  if (direct) return direct
  for (const r of st.results[searchStep] || []) {
    const hit = (String(r.result).match(/[a-z0-9]+(?:_[a-z0-9]+)+/g) || []).find((n) => re.test(n))
    if (hit) return hit
  }
  return null
}
const has = (st, step) => !!st.results[step]
function needTool(st, step, re, query) {
  const name = resolve(st, re, `s-${step}`)
  if (name) return { name }
  if (!st.tools.includes('search_tools') || has(st, `s-${step}`)) return { missing: true }
  return { call: { id: `call_s-${step}_${Date.now() % 1e6}${seq++}`, name: 'search_tools', args: { query } } }
}
const argOf = (r, k) => r.args?.[k] ?? r.args?.arguments?.[k]

// ---------- answer questions from the help center ----------
const STOP = /^(the|and|can|could|for|you|your|our|does|do|with|how|what|there|any|is|are|a|an|to|of|in|on|we|i|it|they|them|their|asked|prospect|customer|customers|call|a|hi|hey|please|parcelwise|docs)$/
function docs(st) {
  const asked = parse(st.userText)
  const question = String(asked?.message ?? st.userText).replace(/^[A-Z][\w .'-]{0,40}:\s/, '').replace(/<@[A-Z0-9]+>/g, '').replace(/\s+/g, ' ').trim()
  const phrase = question.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.test(w)).join(' ')
  const ts = needTool(st, 'search', /search_articles$/, 'search help center articles')
  if (ts.call) return { toolCalls: [ts.call] }
  if (ts.name && !has(st, 'search')) return { toolCalls: [call(st, 'search', ts.name, { phrase, state: 'published' })] }
  const noAccess = String(st.results.search?.[0]?.result || '').match(/I don't have access to [^.]+\./)
  if (noAccess) return { content: `${noAccess[0]} Ask whoever manages me to give me access, then ask again.` }
  const found = unwrap(st.results.search?.[0]?.result)?.data?.articles || []
  if (found.length) {
    const a = found[0]
    const body = plain(a.body)
    const steps = body.split('\n').filter((l) => l.startsWith('- '))
    const paras = body.split('\n').filter((l) => l && !l.startsWith('- '))
    const yes = /^(can|does|do|is|are)\b/i.test(question) ? 'Yes. ' : ''
    const lines = [`${yes}${a.description}`, '']
    if (steps.length) { lines.push(...steps.map((s, i) => `${i + 1}. ${s.slice(2)}`), '') }
    const tail = paras.slice(1).join(' ')
    if (tail) lines.push(tail, '')
    lines.push(`Source: [${a.title}](${a.url})`)
    return { content: lines.join('\n') }
  }
  // not in the help center: a ticket for the docs team, never a guess
  const tt = needTool(st, 'types', /list_ticket_types$/, 'list ticket types')
  if (tt.call) return { toolCalls: [tt.call] }
  if (tt.name && !has(st, 'types')) return { toolCalls: [call(st, 'types', tt.name, {})] }
  const type = (unwrap(st.results.types?.[0]?.result)?.data || []).find((t) => /docs gap/i.test(t.name))
  const tc = needTool(st, 'ticket', /create_ticket$/, 'create a ticket')
  if (tc.call) return { toolCalls: [tc.call] }
  if (tc.name && type && !has(st, 'ticket')) {
    return { toolCalls: [call(st, 'ticket', tc.name, { ticket_type_id: type.id, contacts: [{ email: 'docs@parcelwise.example' }], ticket_attributes: { _default_title_: `Docs gap: ${question.slice(0, 80)}`, _default_description_: `Asked in Slack: "${question}". The help center has no article that answers it (searched for "${phrase}").` } })] }
  }
  const t = unwrap(st.results.ticket?.[0]?.result)
  return { content: `I could not find this in the help center, so I will not guess.${t?.ticket_id ? ` I opened ticket #${t.ticket_id} ("Docs gap") for the docs team, and they will answer you here.` : ''}` }
}

// ---------- score and route new leads ----------
const ONLINE_RETAIL = /RETAIL|CONSUMER_GOODS|SPORTING_GOODS|APPAREL|FOOD_BEVERAGES|FOOD_PRODUCTION/
const EMEA = /germany|united kingdom|france|netherlands|spain|italy|austria|switzerland|belgium|poland|sweden|denmark|ireland/i
function leads(st) {
  const tc = needTool(st, 'contacts', /contacts_post_.*search/, 'search contacts')
  if (tc.call) return { toolCalls: [tc.call] }
  if (tc.name && !has(st, 'contacts')) {
    return { toolCalls: [call(st, 'contacts', tc.name, { filterGroups: [{ filters: [{ propertyName: 'lifecyclestage', operator: 'EQ', value: 'lead' }, { propertyName: 'fit_score', operator: 'NOT_HAS_PROPERTY' }] }], properties: ['firstname', 'lastname', 'email', 'jobtitle', 'company', 'associatedcompanyid', 'message', 'createdate'], sorts: [{ propertyName: 'createdate', direction: 'ASCENDING' }], limit: 20, after: '0' })] }
  }
  const people = unwrap(st.results.contacts?.[0]?.result)?.results || []
  if (!people.length) return { content: 'No new leads to score.' }
  const tg = needTool(st, 'company', /companies_get_crm_v3_objects_companies_company_id/, 'get a company by id')
  if (tg.call) return { toolCalls: [tg.call] }
  const doneCo = (st.results.company || []).map((r) => String(argOf(r, 'companyId')))
  const nextCo = [...new Set(people.map((p) => p.properties.associatedcompanyid).filter(Boolean))].find((id) => !doneCo.includes(String(id)))
  if (tg.name && nextCo) return { toolCalls: [call(st, 'company', tg.name, { companyId: nextCo, properties: ['name', 'domain', 'industry', 'numberofemployees', 'country', 'city', 'description'] })] }
  const to = needTool(st, 'owners', /owners_get|get_crm_v3_owners$/, 'list CRM owners')
  if (to.call) return { toolCalls: [to.call] }
  if (to.name && !has(st, 'owners')) return { toolCalls: [call(st, 'owners', to.name, { limit: 100 })] }
  const owners = unwrap(st.results.owners?.[0]?.result)?.results || []
  const companyOf = (id) => (st.results.company || []).map((r) => unwrap(r.result)).find((c) => String(c?.id) === String(id))?.properties || {}
  const scored = people.map((p) => {
    const c = companyOf(p.properties.associatedcompanyid)
    const n = Number(c.numberofemployees || 0)
    const why = []; let score = 0
    if (ONLINE_RETAIL.test(c.industry || '')) { score += 30; why.push('online shop') } else why.push(`not an online shop (${String(c.industry || 'unknown industry').toLowerCase().replace(/_/g, ' ')})`)
    if (n >= 50 && n <= 500) { score += 25; why.push(`${n} people`) } else if (n >= 20) { score += 15; why.push(`${n} people`) } else why.push(`only ${n || 'unknown'} people`)
    if (/order|ship|return|label|carrier|dhl|ups|dpd/i.test(p.properties.message || '')) { score += 20; why.push('asked about shipping or returns') }
    if (/founder|head of|director|\bvp\b|vice president/i.test(p.properties.jobtitle || '')) { score += 15; why.push(`${p.properties.jobtitle} decides`) }
    const region = EMEA.test(c.country || '') ? 'Sales EMEA' : 'Sales Americas'
    const owner = owners.find((o) => (o.teams || []).some((t) => t.name === region))
    return { p, c, score, reason: why.join(', '), hot: score >= 70, owner }
  })
  const tu = needTool(st, 'update', /contacts_patch_.*update$/, 'update a contact')
  if (tu.call) return { toolCalls: [tu.call] }
  const done = (st.results.update || []).map((r) => String(argOf(r, 'contactId')))
  const next = scored.find((s) => !done.includes(String(s.p.id)))
  if (tu.name && next) {
    const props = { fit_score: String(next.score), fit_reason: next.reason, hs_lead_status: next.hot ? 'OPEN' : 'UNQUALIFIED' }
    if (next.hot && next.owner) props.hubspot_owner_id = next.owner.id
    return { toolCalls: [call(st, 'update', tu.name, { contactId: next.p.id, properties: props })] }
  }
  const hot = scored.filter((s) => s.hot)
  const lines = [`**${hot.length} hot lead${hot.length === 1 ? '' : 's'}** out of ${scored.length} new`, '']
  for (const s of hot) {
    lines.push(`- **${s.p.properties.firstname} ${s.p.properties.lastname}**, ${s.p.properties.jobtitle} at ${s.c.name} (${s.c.city}, ${s.c.numberofemployees} people). Fit ${s.score}/100. Owner: **${s.owner ? `${s.owner.firstName} ${s.owner.lastName}` : 'nobody yet'}**.`)
    if (s.p.properties.message) lines.push(`  They wrote: "${s.p.properties.message}"`)
  }
  const cold = scored.filter((s) => !s.hot)
  if (cold.length) {
    lines.push('', '**Not a fit**')
    for (const s of cold) lines.push(`- ${s.p.properties.firstname} ${s.p.properties.lastname} (${s.c.name || s.p.properties.company}): fit ${s.score}/100, ${s.reason}. Marked Unqualified.`)
  }
  lines.push('', 'Fit score, reason and lead status are saved on each contact in HubSpot.')
  return { content: lines.join('\n') }
}

// ---------- call notes to the CRM ----------
const STAGES = { appointmentscheduled: 'Appointment scheduled', qualifiedtobuy: 'Qualified to buy', presentationscheduled: 'Presentation scheduled', decisionmakerboughtin: 'Decision maker bought-in', contractsent: 'Contract sent', closedwon: 'Closed won', closedlost: 'Closed lost' }
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
function callNotes(st) {
  const notes = st.userText
  const company = (notes.match(/\(([^)]+)\)/) || notes.match(/with ([A-Z][\w&. ]+?)[,.:]/) || [])[1] || ''
  const td = needTool(st, 'deal', /0_3_search|deals_post_.*search/, 'search deals')
  if (td.call) return { toolCalls: [td.call] }
  if (td.name && !has(st, 'deal')) return { toolCalls: [call(st, 'deal', td.name, { query: company, filterGroups: [], properties: ['dealname', 'dealstage', 'closedate', 'amount', 'hubspot_owner_id', 'hs_next_step'], sorts: [], limit: 5, after: '0' })] }
  const deal = (unwrap(st.results.deal?.[0]?.result)?.results || [])[0]
  if (!deal) return { content: `I could not find a deal for "${company}" in HubSpot, so I changed nothing. Which deal should these notes go on?` }
  const now = new Date()
  const endOf = notes.match(/end of (\w+)/i)
  let close = deal.properties.closedate
  if (endOf && MONTHS.includes(endOf[1].toLowerCase())) { const mi = MONTHS.indexOf(endOf[1].toLowerCase()); let y = now.getUTCFullYear(); if (mi < now.getUTCMonth()) y++; close = new Date(Date.UTC(y, mi + 1, 0)).toISOString().slice(0, 10) }
  const demo = (notes.match(/demo[^.\n]*/i) || [''])[0].trim()
  const seats = (notes.match(/(\d+)\s+(?:seats|users)/i) || [])[1]
  const nextStep = [demo && demo.charAt(0).toUpperCase() + demo.slice(1), seats && `send pricing for ${seats} seats`].filter(Boolean).join('; ')
  const tu = needTool(st, 'dupdate', /0_3_.*update$|deals_patch_.*update$/, 'update a deal')
  if (tu.call) return { toolCalls: [tu.call] }
  if (tu.name && !has(st, 'dupdate')) return { toolCalls: [call(st, 'dupdate', tu.name, { dealId: deal.id, properties: { dealstage: 'presentationscheduled', closedate: close, hs_next_step: nextStep } })] }
  const bullets = notes.split(/\n|(?<=\.)\s+/).map((s) => s.trim()).filter((s) => s.length > 12 && !/^call with/i.test(s))
  const tn = needTool(st, 'note', /notes_post_.*create$/, 'create a note')
  if (tn.call) return { toolCalls: [tn.call] }
  if (tn.name && !has(st, 'note')) return { toolCalls: [call(st, 'note', tn.name, { properties: { hs_timestamp: now.toISOString(), hs_note_body: `<p><b>Call notes</b></p><ul>${bullets.map((b) => `<li>${b}</li>`).join('')}</ul>` }, associations: [{ to: { id: deal.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 214 }] }] })] }
  const due = new Date(now.getTime() + 86400000); due.setUTCHours(9, 0, 0, 0)
  const subject = `Send ${company} pricing${seats ? ` for ${seats} seats` : ''}`
  const tt = needTool(st, 'task', /tasks_post_.*create$/, 'create a task')
  if (tt.call) return { toolCalls: [tt.call] }
  if (tt.name && !has(st, 'task')) return { toolCalls: [call(st, 'task', tt.name, { properties: { hs_timestamp: due.toISOString(), hs_task_subject: subject, hs_task_body: 'From the call notes. Include the DHL return labels add-on.', hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hubspot_owner_id: deal.properties.hubspot_owner_id }, associations: [{ to: { id: deal.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 216 }] }] })] }
  const person = (notes.match(/call with ([A-Z]\w+)/i) || [])[1] || 'there'
  const demoDay = (demo.match(/on (\w+ \d+ \w+|\w+day[^;,.]*)/i) || [])[1]
  return { content: [
    `**Updated in HubSpot: ${deal.properties.dealname}**`,
    `- Stage: ${STAGES[deal.properties.dealstage] || deal.properties.dealstage} → **Presentation scheduled**`,
    `- Close date: ${deal.properties.closedate} → **${close}**`,
    `- Next step: ${nextStep}`,
    `- Note added with ${bullets.length} points from the call`,
    `- Task for tomorrow 09:00: "${subject}"`,
    '',
    '**Follow-up email for you to send**',
    '',
    `Subject: Pricing and next steps`,
    '',
    `Hi ${person},`,
    '',
    `Thanks for the time today. As promised, I will send pricing${seats ? ` for ${seats} seats` : ''} with the DHL return labels add-on by tomorrow.${demoDay ? ` I have also put the demo with Jonas in for ${demoDay}; I will send an invitation.` : ''}`,
    '',
    'If anything else comes up before then, just reply here.',
    '',
    'Best,',
    'Daniel',
  ].join('\n') }
}

// ---------- an assistant that remembers ----------
function remember(st) {
  const tr = st.tools.includes('recall_memory')
  const subject = (st.userText.match(/Kestrel Coffee Co\.|[A-Z][a-z]+ [A-Z][a-z]+ Co\./) || ['Kestrel Coffee Co.'])[0]
  if (tr && !has(st, 'recall')) return { toolCalls: [{ id: `call_recall_${seq++}`, name: 'recall_memory', args: { query: subject } }] }
  const memory = (st.results.recall || []).map((r) => r.result).join(' ')
  if (/^notes?\b|^from (today|our)|check-in/i.test(st.userText)) {
    const facts = [
      [/financial year starts in (\w+)/i, (m) => `${subject}: their financial year starts in ${m[1]}; next year's budget is decided in ${st.userText.match(/decided in (\w+)/i)?.[1] || 'spring'}.`, ['kestrel-coffee', 'budget']],
      [/(\w+ \w+) \(([^)]+)\) signs off/i, (m) => `${subject}: ${m[1]} (${m[2]}) signs off on renewals. She prefers short emails with no attachments.`, ['kestrel-coffee', 'people']],
      [/want(?:s)? the ([\w ]+?) before ([\w ]+?)[.]/i, (m) => `${subject}: they want the ${m[1]} before ${m[2]}.`, ['kestrel-coffee', 'product']],
    ].map(([re, f, tags]) => { const m = st.userText.match(re); return m ? { content: f(m), tags } : null }).filter(Boolean)
    const stored = (st.results.store || []).length
    if (st.tools.includes('store_memory') && stored < facts.length) return { toolCalls: [{ id: `call_store_${seq++}`, name: 'store_memory', args: { type: 'fact', tags: facts[stored].tags, content: facts[stored].content } }] }
    return { content: ['Noted. I will remember for next time:', ...facts.map((f) => `- ${f.content.replace(`${subject}: `, '')}`)].join('\n') }
  }
  // a later conversation: use what it remembers
  const fy = memory.match(/financial year starts in (\w+)[^.]*decided in (\w+)/i)
  const who = memory.match(/(\w+) (\w+) \(([^)]+)\) signs off/i)
  const want = memory.match(/want the ([\w ]+?) before ([\w ]+?)\./i)
  if (!who) return { content: `I do not have notes on ${subject} yet. Tell me who signs off on their renewal and anything I should know, and I will remember it.` }
  return { content: [
    `Here is a short draft for ${who[1]}, with no attachments, as she prefers:`,
    '',
    `**Subject:** Your Parcelwise renewal`,
    '',
    `Hi ${who[1]},`,
    '',
    `Your Parcelwise plan renews this summer.${fy ? ` Since your budget for next year is set in ${fy[2]}, could we take 20 minutes in April to agree the renewal?` : ''}${want ? ` I will also bring the timeline for the ${want[1]}, which is on track for ${want[2]}.` : ''}`,
    '',
    'Best,',
    'Daniel',
    '',
    `What I used from earlier notes: ${[fy && `their financial year starts in ${fy[1]}`, `${who[1]} ${who[2]} signs off on renewals and likes short emails`, want && `they want the ${want[1]} before ${want[2]}`].filter(Boolean).join('; ')}.`,
  ].join('\n') }
}

// ---------- questions answered from Google Drive ----------
function drive(st) {
  const q = st.userText
  const words = [/discount|% off/i.test(q) && 'discount', ...(q.match(/\b[A-Z][a-z]{4,}\b/g) || []).filter((w) => !/^(Can|What|Which|Where|Does|Business|Growth|Starter|Pricing)$/.test(w))].filter(Boolean)
  const tl = needTool(st, 'list', /drive_files_list$/, 'search files in Google Drive')
  if (tl.call) return { toolCalls: [tl.call] }
  const searched = (st.results.list || []).map((r) => String(argOf(r, 'q')))
  const nextWord = words.find((w) => !searched.some((s) => s.includes(`'${w}'`)))
  if (tl.name && nextWord) return { toolCalls: [call(st, 'list', tl.name, { q: `fullText contains '${nextWord}'`, corpora: 'drive', driveId: '0APwSalesShared', includeItemsFromAllDrives: true, supportsAllDrives: true, fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))', pageSize: 5, orderBy: 'modifiedTime desc' })] }
  const found = []
  for (const r of st.results.list || []) for (const f of unwrap(r.result)?.files || []) if (!found.some((x) => x.id === f.id)) found.push(f)
  const top = found.slice(0, 2)
  const te = needTool(st, 'export', /drive_files_export$/, 'export a Google Doc as text')
  if (te.call) return { toolCalls: [te.call] }
  const read = (st.results.export || []).map((r) => String(argOf(r, 'fileId')))
  const nextFile = top.find((f) => !read.includes(f.id))
  if (te.name && nextFile) return { toolCalls: [call(st, 'export', te.name, { fileId: nextFile.id, mimeType: 'text/plain' })] }
  const docText = (id) => { const r = (st.results.export || []).find((x) => String(argOf(x, 'fileId')) === id); const v = unwrap(r?.result); return typeof v === 'string' ? v : JSON.stringify(v ?? '') }
  if (!top.length) return { content: 'I found nothing about this in the shared drive, so I cannot answer it from your documents.' }
  const pricing = top.find((f) => /pricing/i.test(f.name))
  const t = pricing ? docText(pricing.id) : ''
  const extra = t.match(/up to (\d+)% extra on annual ([\w ]+?) plans with (\d+) or more seats/i)
  const approver = t.match(/approval from ([\w ]+?) \(/i)
  const annual = t.match(/Annual plans: (\d+)% off/i)
  const seats = Number((q.match(/(\d+) seats/i) || [])[1] || 0)
  const asked = Number((q.match(/(\d+)%/) || [])[1] || 0)
  const other = top.find((f) => f !== pricing)
  const otherText = other ? docText(other.id) : ''
  const lines = []
  if (extra) {
    const ok = seats >= Number(extra[3]) && asked <= Number(extra[1])
    lines.push(ok ? `**Yes**, you can approve that yourself.` : `**Not on your own.** ${seats && seats < Number(extra[3]) ? `${seats} seats is below the ${extra[3]}-seat minimum for an extra discount` : `${asked}% is more than the ${extra[1]}% you may give`}, so it needs approval from ${approver ? approver[1] : 'the Head of Sales'}.`)
    lines.push('', `- The pricing document says account executives may give up to ${extra[1]}% extra on annual ${extra[2]} plans with ${extra[3]} or more seats; anything above that needs ${approver ? approver[1] : 'approval'}.`)
    if (annual) lines.push(`- Annual plans already get ${annual[1]}% off the monthly price, before any extra discount.`)
  }
  if (other && /proposed discount: (\d+)%/i.test(otherText)) lines.push(`- The current draft, "${other.name}", proposes ${otherText.match(/proposed discount: (\d+)%/i)[1]}%${otherText.match(/(\d+) seats/) ? ` for ${otherText.match(/(\d+) seats/)[1]} seats` : ''}.`)
  lines.push('', 'Sources: ' + top.map((f) => `[${f.name}](${f.webViewLink})`).join(', '))
  return { content: lines.join('\n') }
}

function sideCall(st) {
  if (/pick out what is worth remembering|extract.*facts/i.test(st.system)) return { content: JSON.stringify({ facts: [] }) }
  if (/title/i.test(st.system) && /conversation/i.test(st.system) && !st.tools.length) return { content: 'Conversation' }
  if (/verdict|refute/i.test(st.system)) return { content: '{"verdict":"pass","confidence":0.9,"issues":[]}' }
  return null
}

export function decide(body) {
  const st = stateOf(body)
  let out = sideCall(st)
  if (!out) {
    if (/help center/i.test(st.system)) out = docs(st)
    else if (/score|new leads/i.test(st.system)) out = leads(st)
    else if (/call notes/i.test(st.system)) out = callNotes(st)
    else if (/shared drive|google drive/i.test(st.system)) out = drive(st)
    else if (/account notes|remember/i.test(st.system)) out = remember(st)
    else out = { content: 'Done.' }
  }
  try {
    appendFileSync(LOG, JSON.stringify({
      at: new Date().toISOString(), tools: st.tools, system: st.system.slice(0, 160), user: st.userText.slice(0, 600),
      out: out.toolCalls ? out.toolCalls.map((c) => [c.id, c.name, JSON.stringify(c.args).slice(0, 300)]) : out.content.slice(0, 300),
    }) + '\n')
  } catch {}
  return out
}
