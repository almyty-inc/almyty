// Parcelwise: the support and sales example guides (docs-site/content/examples),
// walked as Sofia Marques against the Parcelwise stand-in (fakes/services/parcelwise.ts).
import { createHmac } from 'node:crypto'
import type { Family } from '../../engine/load.ts'
import type { Locator, Step } from '../../engine/schema.ts'
import type { Macro } from '../../engine/macros.ts'
import { escapeHtml, slackHtml } from '../../engine/render.ts'
import { request } from '../../engine/http.ts'
import { locate } from '../../engine/locate.ts'
import { guides } from './guides.ts'

// The signing secret the walks give the Slack bot, so the events they send verify.
const SLACK_SIGNING_SECRET = 'local-test-signing-secret-parcelwise-01'

const str = (a: Record<string, unknown>, key: string): string => {
  const v = a[key]
  if (typeof v !== 'string' || !v) throw new Error(`needs ${key}`)
  return v
}
const shot = (id: unknown): Step[] => (typeof id === 'string' ? [{ shot: id }] : [])

const macros: Record<string, Macro> = {
  /** Open the agent and ask it something in Try it: { agent, message, answer, shot? }. */
  parcelwiseAsk: (a) => [
    { goto: `/agents/${str(a, 'agent')}` },
    { use: 'tryIt', with: { message: a.message, answer: a.answer, ...(a.shot ? { shot: a.shot } : {}) } },
  ],

  /** The agent's latest run, opened on its Runs tab: { agent, shot }. */
  parcelwiseRunSteps: (a) => [
    { goto: `/agents/${str(a, 'agent')}` },
    { click: { role: 'tab', name: 'Runs' } },
    { click: { role: 'button', within: { role: 'table' }, nth: 0 } },
    { waitFor: { testid: 'run-step-0' }, timeout: 20000 },
    ...shot(a.shot),
  ],

  /**
   * A Slack channel on the agent, published: { agent, create, keysShot?, liveShot?, as }.
   * The first makes the bot credential; later ones pick it.
   */
  parcelwiseSlack: (a) => [
    { goto: `/agents/${str(a, 'agent')}/channels/new` },
    { click: { role: 'button', name: /^Slack/ } },
    { click: { role: 'button', name: /^Advanced/ } },
    ...(a.create ? [
      { click: { role: 'button', name: 'Create one here', nth: 'last' } },
      { click: { role: 'button', name: 'More options' } },
      { click: { role: 'radio', name: 'Bot token' } },
      { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'Slack bot (Parcelwise)' },
      { fill: { role: 'textbox', name: 'Bot user OAuth token' }, value: 'xoxb-local-test-0000000000-222222222' },
      { fill: { role: 'textbox', name: 'Signing secret' }, value: SLACK_SIGNING_SECRET },
      { scrollTo: { role: 'textbox', name: 'Bot user OAuth token' }, block: 'nearest' },
      ...shot(a.keysShot),
      { click: { role: 'button', name: 'Save', exact: true } },
      { waitFor: { role: 'textbox', name: 'Bot user OAuth token' }, state: 'hidden', timeout: 15000 },
    ] as Step[] : [
      { select: { role: 'combobox', hasText: 'Pick a credential', nth: 'last' }, option: /Slack bot \(Parcelwise\)/ },
    ] as Step[]),
    { if: { enabled: { role: 'button', name: 'Save', exact: true, nth: 'last' } }, then: [{ click: { role: 'button', name: 'Save', exact: true, nth: 'last' } }] },
    { click: { role: 'button', name: 'Publish', exact: true } },
    { waitFor: { role: 'button', name: 'Unpublish' }, timeout: 20000 },
    { scrollTop: true },
    ...shot(a.liveShot),
    { remember: str(a, 'as'), fromUrl: /channels\/([0-9a-f-]{36})/ },
  ],

  /** Run the agent every few minutes or hours and post to #sales-leads: { agent, every, unit, shot? }. */
  parcelwiseSchedule: (a) => [
    { goto: `/agents/${str(a, 'agent')}/schedule` },
    { select: { role: 'combobox', name: 'Repeat' }, option: /Every few minutes or hours/ },
    { fill: { role: 'spinbutton', name: 'Every' }, value: String(a.every) },
    { select: { role: 'combobox', name: 'Unit' }, option: str(a, 'unit') },
    { select: { role: 'combobox', name: 'Where' }, option: /Slack/ },
    { select: { role: 'combobox', hasText: /slack channel|sales-leads/i, nth: 'last' }, option: /sales-leads/ },
    { fill: { role: 'textbox', name: 'Message' }, value: 'Score the new leads.' },
    ...(a.shot ? [{ scrollTo: { text: 'Every', exact: true }, offset: 150 } as Step, ...shot(a.shot)] : []),
    { click: { role: 'button', name: 'Save schedule' } },
    { waitForUrl: /\/agents\/[0-9a-f-]{36}$/, timeout: 20000 },
  ],
}

// ---------- Slack, the way Slack shows it ----------
const PAGE = (title: string, body: string, note: unknown) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:860px;margin:32px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px;border-bottom:1px solid #f4f4f5;display:flex;gap:12px}
.av{width:36px;height:36px;border-radius:6px;flex:none;color:#fff;font-weight:600;display:flex;align-items:center;justify-content:center;font-size:14px}
.who{font-weight:600;font-size:15px;margin-bottom:4px}.who span{font-size:10px;background:#e4e4e7;border-radius:3px;padding:1px 4px;margin-left:4px;color:#52525b;font-weight:500}
.reply{margin-left:48px;border-left:2px solid #e4e4e7}.thread{font-size:12px;color:#71717a;padding:6px 24px 0 72px}
.text{white-space:pre-wrap;font-size:15px;line-height:1.5}a{color:#1264a3}.mention{background:#e8f5fa;color:#1264a3;border-radius:3px;padding:0 2px}
.note{max-width:860px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>${body}<div class="note">${escapeHtml(note)}</div></body></html>`
const msg = (who: unknown, color: unknown, text: string, { app = false, reply = false } = {}) => `<div class="msg${reply ? ' reply' : ''}"><div class="av" style="background:${color}">${escapeHtml(String(who)[0])}</div><div><div class="who">${escapeHtml(who)}${app ? ' <span>APP</span>' : ''}</div><div class="text">${text}</div></div></div>`

export const parcelwise: Family = {
  name: 'parcelwise',
  walks: guides,
  macros,
  actions: {
    /** An @mention of the bot in a Slack channel, signed as Slack signs it: { slug, gateway, text, channel?, user? }. */
    parcelwiseSlackMention: async (run, a) => {
      const ts = String(Math.floor(Date.now() / 1000))
      const body = JSON.stringify({
        token: 'x', team_id: 'T0PARCEL', api_app_id: 'A0APP', type: 'event_callback', event_id: `Ev${Date.now()}`, event_time: Number(ts),
        event: { type: 'app_mention', channel: a.channel ?? 'C0ASKPRODUCT', user: a.user ?? 'U0TOM', text: str(a, 'text'), ts: `${ts}.000100`, event_ts: `${ts}.000100` },
      })
      const sig = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')
      return request(run.env, {
        method: 'POST', url: `/${str(a, 'slug')}/channels/${str(a, 'gateway')}`, body, auth: false,
        headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
      })
    },
    /** Scroll every scrolled box inside an element back to its top (a list that ticking boxes scrolled): { within }. */
    parcelwiseScrollInsideToTop: async (run, a) => {
      if (!run.session) throw new Error('needs a browser')
      await locate(run.session.page, a.within as Locator).evaluate((root) => {
        for (const e of [root, ...Array.from(root.querySelectorAll('*'))]) if (e.scrollTop) e.scrollTop = 0
      })
    },
  },
  templates: {
    /** { channel, asker, askerColor, mention, question, bot, botColor, answer, note }: a question in a channel and the bot's reply in its thread. */
    parcelwiseSlackThread: (d) => PAGE('Slack thread', `<div class="wrap"><div class="chan">${escapeHtml(d.channel)}</div>
${msg(d.asker, d.askerColor, `<span class="mention">${escapeHtml(d.mention)}</span> ${escapeHtml(d.question)}`)}
<div class="thread">1 reply</div>
${msg(d.bot, d.botColor, slackHtml(d.answer), { app: true, reply: true })}</div>`, d.note),
    /** { channel, bot, botColor, post, note }: one message the bot posted to a channel. */
    parcelwiseSlackPost: (d) => PAGE('Slack messages', `<div class="wrap"><div class="chan">${escapeHtml(d.channel)}</div>${msg(d.bot, d.botColor, slackHtml(d.post), { app: true })}</div>`, d.note),
  },
}
