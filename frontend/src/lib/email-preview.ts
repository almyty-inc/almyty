/**
 * An email a held tool call would send, readable.
 *
 * Gmail's send call (and Gmail drafts) carry the whole message as one
 * base64url string in `raw`, so the approval showed a wall of letters and
 * whoever approved the outreach could not see who it went to or what it
 * said. When an approval's parameters hold such a message, this reads its
 * To, Cc, Subject and text back out. Anything else is left alone.
 */
export interface EmailPreview {
  to: string
  cc?: string
  subject: string
  body: string
}

const MAX_RAW = 512 * 1024

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_\-+/=\s]+$/.test(value)) return null
  try {
    const b64 = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

/** The raw message in a tool call's parameters: `raw`, or `message.raw` (drafts). */
function rawOf(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const p = params as Record<string, any>
  const raw = typeof p.raw === 'string' ? p.raw : typeof p.message?.raw === 'string' ? p.message.raw : null
  return raw && raw.length <= MAX_RAW ? raw : null
}

export function emailPreviewOf(payload: unknown): EmailPreview | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, any>
  const raw = rawOf(p.parameters) ?? rawOf(p.arguments) ?? rawOf(p)
  if (!raw) return null
  const text = decodeBase64Url(raw)
  if (!text) return null
  const split = text.search(/\r?\n\r?\n/)
  const head = split >= 0 ? text.slice(0, split) : text
  const body = split >= 0 ? text.slice(split).replace(/^\r?\n\r?\n/, '') : ''
  const header = (name: string) => {
    const m = head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im'))
    return m ? m[1].trim() : ''
  }
  const to = header('To')
  const subject = header('Subject')
  if (!to && !subject) return null
  const cc = header('Cc')
  return { to, subject, body: body.trim(), ...(cc ? { cc } : {}) }
}
