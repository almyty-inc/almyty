// Lumen: the tutorials Maya Chen walks (the founder's associate, the biz-dev
// assistant, new customer onboarding, and a push wake), on the lumen
// profile, and the personal-assistant tutorial Elena Park walks, on the
// elena profile. Both talk to fakes/services/lumen.ts.
import type { Family } from '../../engine/load.ts'
import type { Locator, Step } from '../../engine/schema.ts'
import type { Run } from '../../engine/run.ts'
import { request } from '../../engine/http.ts'
import { locate } from '../../engine/locate.ts'
import { escapeHtml, page } from '../../engine/render.ts'
import { assign } from '../../engine/template.ts'
import { tutorials } from './tutorials.ts'
import { personal } from './personal.ts'

const str = (a: Record<string, unknown>, key: string): string => {
  const v = a[key]
  if (typeof v !== 'string' || !v) throw new Error(`needs ${key}`)
  return v
}
const state = async (run: Run): Promise<any> => request(run.env, { url: `${run.env.upstream}/_admin/state` })

// Telegram numbers its updates and repeats a number only on a retry, which almyty drops; each run continues the count.
let updateId = Math.floor(Date.now() / 1000)

/** The day after today, as an airline writes it: Thursday 5 November. */
export const tomorrow = (now = Date.now()) => new Date(now + 86400000).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

export const lumen: Family = {
  name: 'lumen',
  walks: [...tutorials, personal],
  macros: {
    /** The agent's schedule: { agent, time, to, message, shot? }, delivered by email. */
    schedule: (a) => [
      { goto: `/agents/${str(a, 'agent')}/schedule` },
      { fill: { role: 'textbox', name: 'Time' }, value: str(a, 'time') },
      { select: { role: 'combobox', name: 'Where' }, option: /Email/ },
      { if: { visible: { role: 'textbox', name: /address|Email/i } }, then: [{ fill: { role: 'textbox', name: /address|Email/i }, value: str(a, 'to') }] },
      { fill: { role: 'textbox', name: 'Message' }, value: str(a, 'message') },
      ...(typeof a.shot === 'string' ? [{ shot: a.shot } as Step] : []),
      { click: { role: 'button', name: 'Save schedule' } },
    ],

    /** Wake the agent now and wait until that run ends or waits for approval: { agent, what }; remembers run.status and run.id. */
    wake: (a) => {
      const agent = str(a, 'agent')
      const last = (col: string) => `SELECT ${col} FROM agent_runs WHERE "agentId" = '${agent}' ORDER BY "createdAt" DESC LIMIT 1`
      return [
        { sql: `SELECT count(*) FROM agent_runs WHERE "agentId" = '${agent}'`, save: 'runsBefore' },
        { goto: `/agents/${agent}` },
        { click: { role: 'button', name: 'Wake now' } },
        {
          until: { sql: `SELECT count(*) > {{runsBefore}} AND (${last('status')}) IN ('completed', 'failed', 'cancelled', 'timeout', 'waiting_approval') FROM agent_runs WHERE "agentId" = '${agent}'`, is: 't' },
          timeout: 600000, every: 3000, what: str(a, 'what'),
        },
        { sql: last('status'), save: 'run.status' },
        { sql: last('id'), save: 'run.id' },
      ]
    },

    /**
     * Approve what the agent asks for while it works: { agent, note? }. Each
     * approval lets the run go on to its next one, so this waits until a
     * request is there or the agent's runs have stopped, and stops when
     * nothing waits and nothing runs.
     */
    approveWhileItWorks: (a) => {
      const agent = str(a, 'agent')
      const pending = `(SELECT count(*) FROM approval_requests WHERE "organizationId" = '{{org.id}}' AND status = 'pending')`
      const working = `EXISTS (SELECT 1 FROM agent_runs WHERE "agentId" = '${agent}' AND status IN ('pending', 'running', 'waiting_approval'))`
      const note = typeof a.note === 'string' ? a.note : undefined
      return [{
        repeat: [
          { until: { sql: `SELECT ${pending} > 0 OR NOT ${working}`, is: 't' }, timeout: 180000, every: 2000, what: 'the next approval or the end of the run' },
          { if: { sql: `SELECT ${pending} > 0`, is: 't' }, then: [
            { goto: '/approvals' },
            { click: { role: 'button', name: 'Approve', exact: true } },
            ...(note ? [{ fill: { role: 'textbox', name: 'Note (optional)' }, value: note } as Step] : []),
            { click: { role: 'button', name: 'Approve', within: { role: 'form', name: 'Approve this action' } } },
            { waitFor: { role: 'form', name: 'Approve this action' }, state: 'hidden' },
          ] },
        ],
        while: { sql: `SELECT ${pending} > 0 OR ${working}`, is: 't' },
        max: 12,
      }]
    },
  },
  actions: {
    /** Stop when the stand-in already holds messages: an earlier run would show in these pictures. */
    freshUpstream: async (run) => {
      const s = await state(run)
      if (s.outbox.length + s.sent.length) throw new Error(`${run.env.upstream} already holds messages from an earlier run: restart the stack (stack.sh down, then up)`)
    },
    /** Scroll every scrolled box inside an element back to its top: { within } (a locator). */
    scrollBoxTop: async (run, a) => {
      await locate(run.session!.page, a.within as Locator).evaluate((root) => {
        for (const e of [root, ...root.querySelectorAll('*')]) if (e.scrollHeight > e.clientHeight && e.scrollTop) e.scrollTop = 0
      })
    },
    /** The secret token almyty registered the Telegram webhook with, from the stand-in's outbox. */
    telegramSecret: async (run) => {
      const reg = (await state(run)).outbox.filter((o: any) => /\/setWebhook/.test(o.url)).pop()
      if (!reg) throw new Error('almyty has not registered a Telegram webhook')
      const secret = new URL(`http://x${reg.url.slice(reg.url.indexOf('/setWebhook'))}`).searchParams.get('secret_token')
      if (!secret) throw new Error(`no secret_token in ${reg.url}`)
      return secret
    },
    /** A Telegram message from the person, posted to the channel as Telegram posts it: { slug, channel, secret, chat, text }. */
    telegramSay: async (run, a) => {
      const chat = Number(a.chat)
      const text = str(a, 'text')
      const id = ++updateId
      const update = { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), text, chat: { id: chat, type: 'private', first_name: 'Elena' }, from: { id: chat, is_bot: false, first_name: 'Elena', last_name: 'Park', language_code: 'en' } } }
      await request(run.env, { method: 'POST', url: `/${str(a, 'slug')}/channels/${str(a, 'channel')}`, body: update, auth: false, headers: { 'x-telegram-bot-api-secret-token': str(a, 'secret') } })
      const chatLog = Array.isArray(run.vars.chat) ? run.vars.chat : []
      assign(run.vars, 'chat', [...chatLog, { who: 'me', text, at: new Date().toISOString() }])
    },
    /** The Telegram chat since `from`: what the person said and what the bot sent, in order: { chat, from }. */
    telegramChat: async (run, a) => {
      const bot = (await state(run)).outbox
        .filter((o: any) => /api\.telegram\.org\/bot[^/]+\/sendMessage/.test(o.url) && String(o.body?.chat_id) === String(a.chat))
        .map((o: any) => ({ who: 'bot', text: o.body.text, at: o.at }))
      const from = typeof a.from === 'string' ? a.from : ''
      const mine = (Array.isArray(run.vars.chat) ? run.vars.chat : []) as { who: string; text: string; at: string }[]
      return [...mine, ...bot].filter((m) => !from || m.at >= from).sort((x, y) => x.at.localeCompare(y.at))
    },
    /** The airline's email about tomorrow's flight lands in Elena's inbox. */
    flightMail: async (run) => request(run.env, { method: 'POST', url: `${run.env.upstream}/_admin/mail`, body: {
      from: 'Atlantica Airways <noreply@atlantica-air.example>',
      subject: 'Schedule change: your flight AT 552 to Berlin',
      body: `Dear Elena Park,\n\nYour flight AT 552 from Lisbon (LIS) to Berlin (BER) on ${tomorrow()} has a new schedule.\n\nNew departure 07:10, new arrival 09:20 (was 06:00 and 08:10).\n\nYour seat 14A and booking QX7P2L stay the same. You do not need to do anything.\n\nAtlantica Airways`,
    } }),
  },
  templates: {
    /** { subject, from, to, body, note }: an email as the agent sent it through the Gmail API. */
    gmail: (d) => page(String(d.subject ?? ''), `<div class="wrap"><div class="head"><div class="subj">${escapeHtml(d.subject)}</div>
<div class="meta">From: Maya Chen &lt;${escapeHtml(d.from)}&gt;<br>To: ${escapeHtml(d.to)}</div></div><div class="body" style="white-space:pre-wrap">${escapeHtml(d.body)}</div></div>`, String(d.note ?? '')),
    /** { name, stage, description, note }: a CRM deal as the agent left it. */
    deal: (d) => page(String(d.name ?? ''), `<div class="wrap"><div class="head"><div class="subj">${escapeHtml(d.name)}</div>
<div class="meta">Stage: ${escapeHtml(d.stage)}</div></div><div class="body" style="white-space:pre-wrap">${escapeHtml(d.description)}</div></div>`, String(d.note ?? '')),
    /** { title, messages: [{ who: 'me' | 'bot', text, at }] }: a Telegram chat as Telegram's desktop app lays it out, her bubbles right, the bot's left. */
    telegram: (d) => {
      const time = (iso: string) => new Date(iso).toISOString().slice(11, 16)
      const bubble = (m: any) => `<div class="row ${m.who}"><div class="b"><div class="t">${escapeHtml(m.text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</div><div class="tm">${time(m.at)}</div></div></div>`
      return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(d.title)}</title>
<style>body{margin:0;background:#e7ebf0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#000}
.wrap{max-width:760px;margin:24px auto;background:#a7c4a0 linear-gradient(160deg,#c9dcb8,#9fbf9a);border-radius:12px;overflow:hidden;border:1px solid #cfd6dd}
.head{background:#fff;padding:12px 18px;border-bottom:1px solid #dfe3e8}.name{font-weight:600;font-size:16px}.sub{font-size:13px;color:#8a96a3}
.chat{padding:16px 14px}.row{display:flex;margin:6px 0}.row.me{justify-content:flex-end}
.b{max-width:78%;padding:7px 11px 5px;border-radius:12px;box-shadow:0 1px 1px #0002;background:#fff}.row.me .b{background:#e1fec6}
.t{white-space:pre-wrap;font-size:15px;line-height:1.4}.tm{text-align:right;font-size:11px;color:#6d8a6b;margin-top:2px}
.note{max-width:760px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>
<div class="wrap"><div class="head"><div class="name">Elena's assistant</div><div class="sub">bot</div></div><div class="chat">${(d.messages as unknown[]).map(bubble).join('')}</div></div>
<div class="note">The messages exactly as almyty sent them to Telegram, and Elena's as Telegram delivered them, laid out the way Telegram shows a chat (local demo; Telegram itself was not used).</div></body></html>`
    },
  },
}
