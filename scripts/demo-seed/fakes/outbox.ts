// Where the API's email, Slack and Telegram calls land (fakes/preload/
// redirect.ts sends them to /_ext/<host>/<path> on the profile's fake).
// Every call is kept, in order, so a walk can show what was "sent"; each
// gets the answer the real service would give.
import { any, json, type Reply, type Req, type Route } from './server.ts'

export interface Sent { at: string; url: string; body: any }

export interface SlackUser { real_name: string; email: string }
export interface OutboxOptions {
  /** The Slack workspace: team name and id. */
  team?: { name: string; id: string }
  /** Slack users by id, for users.info; the first is the default. */
  users?: Record<string, SlackUser>
  /** Channels conversations.list answers. */
  channels?: { id: string; name: string }[]
  /** The channel a post lands in when it names none. */
  defaultChannel?: string
  /** The bot Telegram's getMe describes. */
  telegramBot?: { id: number; first_name: string; username: string }
  /** A file shared in Slack (files.slack.com): what it answers. */
  file?: (req: Req) => Reply
}

export function outbox(o: OutboxOptions = {}): { routes: Route[]; sent: Sent[] } {
  const sent: Sent[] = []
  const users = o.users ?? {}
  const firstUser = Object.keys(users)[0]
  const routes = [any(/^\/_ext\//, (req) => {
    const p = req.path
    sent.push({ at: new Date().toISOString(), url: p.slice(5) + req.url.search, body: p.startsWith('/_ext/files.slack.com/') ? null : req.raw ? req.body : undefined })
    if (p.startsWith('/_ext/files.slack.com/') && o.file) return o.file(req)
    if (p.startsWith('/_ext/api.resend.com')) return json({ id: `local-email-${sent.length}` })
    if (p.startsWith('/_ext/api.telegram.org')) {
      const result = p.endsWith('/getMe') ? { is_bot: true, ...(o.telegramBot ?? { id: 7000001, first_name: 'Assistant', username: 'assistant_bot' }) }
        : p.endsWith('/sendMessage') ? { message_id: sent.length, date: Math.floor(Date.now() / 1000), chat: { id: req.body?.chat_id, type: 'private' }, text: req.body?.text } : true
      return json({ ok: true, result })
    }
    if (p.includes('/users.info') && firstUser) {
      const id = req.query.get('user') || req.body?.user || firstUser
      const x = users[id] ?? users[firstUser]
      const first = x.real_name.split(' ')[0]
      return json({ ok: true, user: { id, name: first.toLowerCase(), real_name: x.real_name, profile: { email: x.email, real_name: x.real_name, display_name: first } } })
    }
    if (p.includes('/conversations.list') && o.channels) return json({ ok: true, channels: o.channels })
    if (p.includes('/auth.test') && o.team) return json({ ok: true, team: o.team.name, team_id: o.team.id, user_id: 'U0BOT', bot_id: 'B0BOT' })
    return json({ ok: true, ts: String(Date.now() / 1000), channel: req.body?.channel || (o.defaultChannel ?? 'C0GENERAL') })
  })]
  return { routes, sent }
}
