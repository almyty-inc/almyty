// Larkspur Home: the data and finance example guides, walked as Ines
// Duarte (head of finance and operations, made up) against the larkspur
// fake (Stripe, Xero, BigQuery, Slack and the scripted models).
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Family } from '../../engine/load.ts'
import type { Macro } from '../../engine/macros.ts'
import type { Step } from '../../engine/schema.ts'
import { escapeHtml } from '../../engine/render.ts'
import { request } from '../../engine/http.ts'
import { guides, waitForPost, SLACK_SIGNING_SECRET } from './guides.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

const str = (a: Record<string, unknown>, key: string): string => {
  const v = a[key]
  if (typeof v !== 'string' || !v) throw new Error(`needs ${key}`)
  return v
}
const opt = (a: Record<string, unknown>, key: string): string | undefined => (typeof a[key] === 'string' ? (a[key] as string) : undefined)
const shot = (id: string | undefined): Step[] => (id ? [{ shot: id }] : [])

const macros: Record<string, Macro> = {
  /** Connect an API from the link to its public description, at the fake's address: { link, name, address, linkShot? }. */
  connectApi: (a) => [
    { goto: '/apis/new/openapi' },
    { fill: { label: 'Link to the description' }, value: str(a, 'link') },
    ...shot(opt(a, 'linkShot')),
    { click: { role: 'button', name: 'Advanced' } },
    { fill: { label: 'Name', exact: true }, value: str(a, 'name') },
    // The local stand-in, not the real service. Stripe's description is large: reading it takes a while.
    { fill: { label: 'Address', exact: true }, value: str(a, 'address') },
    { click: { role: 'button', name: 'Connect API' } },
    { waitForUrl: /\/setup/, timeout: 180000 },
    { waitFor: { text: /Found \d+ operation/ }, timeout: 300000 },
  ],

  /** Connect a model provider: { name, provider, key, shot? } (the key goes to the fake vendor). */
  connectProvider: (a) => [
    { goto: '/models/providers/new' },
    { fill: { label: 'Name', exact: true }, value: str(a, 'name') },
    { click: { role: 'combobox', name: 'Provider' } },
    { fill: { placeholder: 'Search providers' }, value: str(a, 'provider') },
    { click: { role: 'option', name: str(a, 'provider'), exact: true } },
    { fill: { label: /API key/ }, value: str(a, 'key') },
    ...shot(opt(a, 'shot')),
    { click: { role: 'button', name: 'Save', exact: true } },
    { waitForUrl: /\/models\/providers\/[0-9a-f-]{36}/, timeout: 60000 },
  ],

  /** On an API's setup page, a sign-in with the provider: { clientId, secret, scope, shot }; then a pasted token: { name, token }. */
  oauthSignIn: (a) => [
    { click: { role: 'button', name: 'Create one here' } },
    { fill: { label: 'Client ID' }, value: str(a, 'clientId') },
    { fill: { label: 'Client secret' }, value: str(a, 'secret') },
    { waitFor: { testid: 'api-oauth-redirect' }, timeout: 10000 },
    { setChecks: { role: 'checkbox', within: { testid: 'api-oauth-scopes' } }, on: a.scope as string | RegExp },
    { scrollTo: { role: 'checkbox', name: a.scope as string | RegExp, exact: typeof a.scope === 'string' ? true : undefined, within: { testid: 'api-oauth-scopes' } }, block: 'center' },
    { scrollTo: { testid: 'api-oauth-redirect' }, offset: 120 },
    { shot: str(a, 'shot') },
    { use: 'pasteToken', with: { name: str(a, 'name'), token: str(a, 'token') } },
    { use: 'saveSignIn' },
  ],

  /** A Try it question on the agent's page, framed on Try it: { agent, message, answer, shot? }. */
  ask: (a) => [
    { goto: `/agents/${str(a, 'agent')}` },
    { fill: { placeholder: 'Type a message to test this agent...' }, value: str(a, 'message') },
    { press: { placeholder: 'Type a message to test this agent...' }, key: 'Enter' },
    { waitFor: { role: 'status', hasText: a.answer as string | RegExp }, timeout: 180000 },
    { scrollTo: { text: 'Try it', exact: true }, offset: 90 },
    ...shot(opt(a, 'shot')),
  ],

  /** The latest run, opened on the Runs tab: { agent, shot }. */
  latestRun: (a) => [
    { goto: `/agents/${str(a, 'agent')}` },
    { click: { role: 'tab', name: 'Runs' } },
    { click: { role: 'button', within: { role: 'table' }, nth: 0 } },
    { shot: str(a, 'shot') },
  ],

  /**
   * A Slack channel for the agent with the workspace's bot token, published:
   * { agent, as, shot? }. The first one saves the token; later ones pick it.
   */
  slackChannel: (a) => [
    { goto: `/agents/${str(a, 'agent')}/channels/new` },
    { click: { role: 'button', name: /^Slack/ } },
    { click: { role: 'button', name: /^Advanced/ } },
    {
      if: { sql: `SELECT count(*) FROM credentials WHERE name = 'Slack bot (Larkspur)'`, is: '0' },
      then: [
        { click: { role: 'button', name: 'Create one here', nth: 'last' } },
        { click: { role: 'button', name: 'More options' } },
        { click: { role: 'radio', name: 'Bot token' } },
        { fill: { role: 'textbox', name: 'Name', exact: true, nth: 'last' }, value: 'Slack bot (Larkspur)' },
        { fill: { role: 'textbox', name: 'Bot user OAuth token' }, value: 'xoxb-local-test-0000000000-333333333' },
        { fill: { role: 'textbox', name: 'Signing secret' }, value: SLACK_SIGNING_SECRET },
        { click: { role: 'button', name: 'Save', exact: true, nth: 'first' } },
      ],
      else: [{ select: { role: 'combobox', hasText: 'Pick a credential', nth: 'last' }, option: /Slack bot \(Larkspur\)/ }],
    },
    { if: { enabled: { role: 'button', name: 'Save', exact: true, nth: 'last' } }, then: [{ click: { role: 'button', name: 'Save', exact: true, nth: 'last' } }] },
    { click: { role: 'button', name: 'Publish', exact: true } },
    { waitFor: { role: 'button', name: 'Unpublish' }, timeout: 20000 },
    { scrollTop: true },
    ...shot(opt(a, 'shot')),
    { remember: str(a, 'as'), fromUrl: /channels\/([0-9a-f-]{36})/ },
  ],

  /**
   * The agent's schedule, posted to a Slack channel: { agent, channel, message,
   * days?, time?, every? (minutes, instead of days and time), shot? }.
   */
  schedule: (a) => [
    { goto: `/agents/${str(a, 'agent')}/schedule` },
    ...(a.every
      ? [
        { select: { label: 'Repeat', exact: true }, option: 'Every few minutes or hours' },
        { fill: { role: 'spinbutton', name: 'Every' }, value: String(a.every) },
        { select: { role: 'combobox', name: 'Unit' }, option: 'minutes' },
      ] as Step[]
      : [
        { select: { label: 'Repeat', exact: true }, option: 'At a time of day' },
        { select: { label: 'Days', exact: true }, option: str(a, 'days') },
        { fill: { label: 'Time', exact: true }, value: str(a, 'time') },
        { select: { label: 'Time zone', exact: true }, option: /Europe\/Amsterdam/ },
      ] as Step[]),
    { select: { label: 'Where', exact: true }, option: /Slack/ },
    { select: { label: 'Slack channel', exact: true }, option: new RegExp(str(a, 'channel')) },
    { fill: { role: 'textbox', name: 'Message' }, value: str(a, 'message') },
    ...(opt(a, 'shot') ? [{ scrollTo: { label: 'Days', exact: true }, offset: 60 } as Step, { shot: str(a, 'shot') } as Step] : []),
    { click: { role: 'button', name: 'Save schedule' } },
  ],

  /**
   * A schedule's real run, posted to Slack: every minute until it posts, then
   * back to its real time: { agent, channel, message, match, days, time, as }.
   */
  scheduledPost: (a) => [
    { http: { method: 'POST', url: '{{stack.upstream}}/_admin/reset' } },
    { use: 'schedule', with: { agent: a.agent, channel: a.channel, message: a.message, every: 1 } },
    ...waitForPost(str(a, 'as'), a.match as RegExp, `the scheduled post in #${str(a, 'channel')}`, 300000),
    { use: 'schedule', with: { agent: a.agent, channel: a.channel, message: a.message, days: a.days, time: a.time } },
  ],

  /** A budget on /analytics/budgets: { scope?, agent?, limit, period?, behavior?, shot?, edit? }. */
  budget: (a) => [
    ...(a.edit ? [] : [{ goto: '/analytics/budgets/new' } as Step]),
    ...(a.edit ? [] : [{ select: { label: 'Applies to' }, option: a.agent ? 'A single agent' : 'The whole organization' } as Step]),
    ...(a.agent ? [// The label carries a required mark: Agent *.
      { select: { label: /^Agent\b/ }, option: str(a, 'agent') } as Step] : []),
    { fill: { label: /Limit \(USD\)/ }, value: str(a, 'limit') },
    ...(a.period ? [{ select: { label: 'Period' }, option: str(a, 'period') } as Step] : []),
    ...(a.behavior ? [{ select: { label: 'When the limit is reached' }, option: str(a, 'behavior') } as Step] : []),
    { fill: { label: /Warn at/ }, value: '80' },
    ...(opt(a, 'shot') ? [{ scrollTop: true } as Step, { shot: str(a, 'shot') } as Step] : []),
    { click: { role: 'button', name: a.edit ? 'Save budget' : 'Create budget' } },
  ],
}

// ---------- the Slack page ----------
const slackHtml = (text: unknown) => escapeHtml(text)
  .replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>')
  .replace(/```([\s\S]+?)```/g, '<pre>$1</pre>')
  .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1<b>$2</b>')
const PAGE = (title: string, body: string, note: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:860px;margin:32px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px;border-bottom:1px solid #f4f4f5;display:flex;gap:12px}
.av{width:36px;height:36px;border-radius:6px;flex:none;color:#fff;font-weight:600;display:flex;align-items:center;justify-content:center;font-size:14px}
.who{font-weight:600;font-size:15px;margin-bottom:4px}.who span{font-size:10px;background:#e4e4e7;border-radius:3px;padding:1px 4px;margin-left:4px;color:#52525b;font-weight:500}
.reply{margin-left:48px;border-left:2px solid #e4e4e7}.thread{font-size:12px;color:#71717a;padding:6px 24px 0 72px}
.text{white-space:pre-wrap;font-size:15px;line-height:1.5}a{color:#1264a3}.mention{background:#e8f5fa;color:#1264a3;border-radius:3px;padding:0 2px}
code,pre{font-family:Menlo,Consolas,monospace;font-size:12.5px;background:#f6f6f7;border:1px solid #e4e4e7;border-radius:4px}code{padding:0 3px;color:#c01343}pre{padding:8px 10px;margin:6px 0;white-space:pre-wrap}
  .file{margin-top:8px;display:inline-flex;gap:10px;align-items:center;border:1px solid #e4e4e7;border-radius:8px;padding:8px 12px;font-size:14px}.file span{font-size:11px;color:#fff;background:#e5484d;border-radius:3px;padding:1px 5px}
.note{max-width:860px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>${body}<div class="note">${escapeHtml(note)}</div></body></html>`
const msg = (who: string, color: string, text: string, { app = false, reply = false } = {}) => `<div class="msg${reply ? ' reply' : ''}"><div class="av" style="background:${color}">${escapeHtml(who[0])}</div><div><div class="who">${escapeHtml(who)}${app ? ' <span>APP</span>' : ''}</div><div class="text">${text}</div></div></div>`
const SLACK_NOTE = 'The message exactly as almyty posted it to Slack, shown the way Slack formats it (local demo; Slack itself was not used).'

export const larkspur: Family = {
  name: 'larkspur',
  walks: guides,
  macros,
  templates: {
    /**
     * What an agent posted to one Slack channel: { channel, agent, text }, and for a
     * thread the message it answers: { from, question, file? } (the agent is @-mentioned).
     */
    larkspurSlack: (d) => {
      const answer = String(d.text ?? '')
      const channel = `<div class="chan"># ${escapeHtml(d.channel)}</div>`
      if (!d.from) return PAGE('Slack messages', `<div class="wrap">${channel}${msg(String(d.agent), '#0891b2', slackHtml(answer), { app: true })}</div>`, SLACK_NOTE)
      const file = d.file ? `<div class="file"><b>${escapeHtml(d.file)}</b><span>PDF</span></div>` : ''
      return PAGE('Slack thread', `<div class="wrap">${channel}
${msg(String(d.from), '#7c3aed', `<span class="mention">@${escapeHtml(d.agent)}</span> ${escapeHtml(d.question)}${file}`)}
<div class="thread">1 reply</div>
${msg(String(d.agent), '#0891b2', slackHtml(answer), { app: true, reply: true })}</div>`, SLACK_NOTE)
    },
  },
  actions: {
    /**
     * Someone @-mentions the bot in a Slack channel, signed as Slack signs it:
     * { slug, gateway, text, channel, user, files? }.
     */
    slackMention: async (run, a) => {
      const ts = String(Math.floor(Date.now() / 1000))
      const body = JSON.stringify({
        token: 'x', team_id: 'T0LARKSPUR', api_app_id: 'A0APP', type: 'event_callback', event_id: `Ev${Date.now()}`, event_time: Number(ts),
        event: { type: 'app_mention', channel: a.channel ?? 'C0ASKDATA', user: a.user ?? 'U0FENNA', text: str(a, 'text'), ts: `${ts}.000100`, event_ts: `${ts}.000100`, ...(a.files ? { files: a.files } : {}) },
      })
      const sig = 'v0=' + createHmac('sha256', SLACK_SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')
      return request(run.env, {
        method: 'POST', url: `/${str(a, 'slug')}/channels/${str(a, 'gateway')}`, body, auth: false,
        headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
      })
    },
    /**
     * The Northgate draft (contract.html) printed to PDF, handed to the fake,
     * which serves it as the file shared in Slack: answers { path, size }.
     */
    contractPdf: async (run) => {
      const path = join(run.out, 'northgate-fulfilment-agreement.pdf')
      const page = await run.session!.context.newPage()
      try {
        await page.goto(`file://${join(HERE, 'contract.html')}`)
        await page.pdf({ path, format: 'A4', margin: { top: '22mm', bottom: '22mm', left: '22mm', right: '22mm' } })
      } finally { await page.close() }
      const bytes = readFileSync(path)
      await request(run.env, { method: 'POST', url: `${run.env.upstream}/_admin/contract`, body: { base64: bytes.toString('base64') } })
      return { path, size: bytes.length }
    },
  },
}
