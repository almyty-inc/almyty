// Pages for what a fake received (an email, Slack messages), shown the way
// the real service shows them, so a walk can take a screenshot of it.
// Walk families add their own templates next to their walks.

export type Template = (data: Record<string, unknown>) => string

export const escapeHtml = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Slack mrkdwn as Slack shows it: *bold*, <url|text>, bullets as written. */
export const slackHtml = (text: unknown) => escapeHtml(text)
  .replace(/&lt;(https?:\/\/[^|&]+)\|([^&]+?)&gt;/g, '<a href="$1">$2</a>')
  .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,:;!?]|$)/gm, '$1<b>$2</b>')

/** The tutorials' page: a white card on grey, a note under it. */
export const page = (title: string, body: string, note: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#18181b}
.wrap{max-width:860px;margin:32px auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;overflow:hidden}
.head{padding:20px 28px;border-bottom:1px solid #e4e4e7}.subj{font-size:22px;font-weight:600;margin-bottom:10px}
.meta{font-size:14px;color:#52525b;line-height:1.6}.body{padding:24px 28px;font-size:15px;line-height:1.55}
.chan{padding:14px 24px;border-bottom:1px solid #e4e4e7;font-weight:600}.msg{padding:14px 24px;border-bottom:1px solid #f4f4f5}
.who{font-weight:600;font-size:15px;margin-bottom:4px}.who span{font-size:10px;background:#e4e4e7;border-radius:3px;padding:1px 4px;margin-left:4px;color:#52525b}
.text{white-space:pre-wrap;font-size:15px;line-height:1.5}a{color:#1264a3}
.note{max-width:860px;margin:0 auto 24px;font-size:12px;color:#71717a}</style></head><body>${body}<div class="note">${escapeHtml(note)}</div></body></html>`

const str = (v: unknown) => (v === undefined || v === null ? '' : String(v))

export const TEMPLATES: Record<string, Template> = {
  /** { subject, from, to, html, note }: an email as the provider was handed it. */
  email: (d) => page(str(d.subject), `<div class="wrap"><div class="head"><div class="subj">${escapeHtml(d.subject)}</div>
<div class="meta">From: ${escapeHtml(d.from)}<br>To: ${escapeHtml(([] as unknown[]).concat(d.to ?? []).join(', '))}</div></div><div class="body">${str(d.html)}</div></div>`, str(d.note)),
  /** { channel, who, messages: string[], note }: messages a bot posted to one Slack channel. */
  slack: (d) => page('Slack messages', `<div class="wrap"><div class="chan">${escapeHtml(d.channel)}</div>${(d.messages as unknown[]).map((t) => `<div class="msg"><div class="who">${escapeHtml(d.who)} <span>APP</span></div><div class="text">${slackHtml(t)}</div></div>`).join('')}</div>`, str(d.note)),
}

export function renderPage(templates: Record<string, Template>, name: string, data: Record<string, unknown>): string {
  const t = templates[name]
  if (!t) throw new Error(`no page template called ${name}`)
  return t(data)
}
