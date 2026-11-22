/**
 * A memory's text, the way a person reads it.
 *
 * Saved conversations embed the run's input as JSON:
 * `Task: {"message":"Sites: ..."}` or `Person: {"message":"..."}`. Shown
 * as-is that reads like a log line, so each line that is a label and a
 * JSON object carrying a message shows the message instead. Older saves
 * cut the JSON at 500 characters, so a cut object still gives its message.
 * Only the display changes; the stored memory is untouched.
 */

/** The keys a run's input carries its words under, most likely first. */
const WORD_KEYS = ['message', 'text', 'prompt', 'query', 'input'] as const

function wordsOfObject(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  for (const key of WORD_KEYS) {
    if (typeof obj[key] === 'string') return obj[key] as string
  }
  return null
}

/** The message of a JSON object, whole or cut short; null when it is not one. */
function wordsOfJson(raw: string): string | null {
  const text = raw.trim()
  if (!text.startsWith('{')) return null
  try {
    return wordsOfObject(JSON.parse(text))
  } catch {
    // Cut short: take the message string as far as it goes.
    const cut = text.match(/^\{\s*"(message|text|prompt|query|input)"\s*:\s*"((?:[^"\\]|\\.)*)/)
    if (!cut) return null
    const body = cut[2].replace(/\\u[0-9a-fA-F]{0,3}$|\\$/, '')
    try {
      return `${JSON.parse(`"${body}"`)}…`
    } catch {
      return null
    }
  }
}

/** `content` with every embedded `{"message": ...}` shown as its message. */
export function memoryText(content: string | null | undefined): string {
  if (!content) return ''
  const whole = wordsOfJson(content)
  if (whole !== null) return whole
  return content
    .split('\n')
    .map((line) => {
      const labelled = line.match(/^(\s*[A-Za-z][\w ]{0,30}:\s*)(\{.*)$/)
      if (!labelled) return line
      const words = wordsOfJson(labelled[2])
      return words === null ? line : `${labelled[1]}${words}`
    })
    .join('\n')
}

/**
 * One line of a memory for a list row: its text without the markdown
 * marks (`**`, `#`, list bullets, link targets), on one line.
 */
export function memoryPreview(content: string | null | undefined): string {
  return memoryText(content)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s.,;:!?)]|$)/g, '$1$2')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
