// Actions: the few things a walk does that are not a click or a call, as
// typed functions a step names ({ action: 'slackEvent', with: {...} }).
// Shared ones live here; a family adds its own next to its walks.
import { createHmac } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Action } from './run.ts'
import { request } from './http.ts'

const need = (args: Record<string, unknown>, key: string): string => {
  const v = args[key]
  if (typeof v !== 'string' || !v) throw new Error(`needs ${key}`)
  return v
}

export const ACTIONS: Record<string, Action> = {
  /** Write a file a later step uploads (an API description as a customer downloads it): { name, json | text }; answers its path. */
  writeFile: async (run, a) => {
    const dir = join(run.out, 'files')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, need(a, 'name'))
    writeFileSync(file, typeof a.text === 'string' ? a.text : JSON.stringify(a.json))
    return file
  },

  /**
   * A Slack event, signed as Slack signs it, posted to a channel's own address:
   * { slug, gateway, secret, text, user?, channel?, thread? }.
   */
  slackEvent: async (run, a) => {
    const ts = String(Math.floor(Date.now() / 1000))
    const event: Record<string, unknown> = {
      type: 'message', channel_type: a.channelType ?? 'im', channel: a.channel ?? 'D0MAYA', user: a.user ?? 'U0MAYA',
      text: need(a, 'text'), ts: `${ts}.000100`, event_ts: `${ts}.000100`,
      ...(a.thread ? { thread_ts: a.thread } : {}),
    }
    const body = JSON.stringify({ token: 'x', team_id: a.team ?? 'T0LUMEN', api_app_id: 'A0APP', type: 'event_callback', event_id: `Ev${Date.now()}`, event_time: Number(ts), event })
    const sig = 'v0=' + createHmac('sha256', need(a, 'secret')).update(`v0:${ts}:${body}`).digest('hex')
    return request(run.env, {
      method: 'POST', url: `/${need(a, 'slug')}/channels/${need(a, 'gateway')}`, body, auth: false,
      headers: { 'content-type': 'application/json', 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
    })
  },
}
