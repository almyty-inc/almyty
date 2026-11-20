/**
 * What a run was asked, as one line of text for a list.
 *
 * A run's input is stored as an object, almost always `{ message: "..." }`.
 * Lists used to print it as JSON, so people read `{"message":"Sites: ...`
 * where they expected the question they typed.
 */
export function runInputPreview(input: unknown, max = 120): string {
  const text = inputText(input)
  if (!text) return '--'
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function inputText(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  if (typeof input !== 'object') return String(input)
  const obj = input as Record<string, unknown>
  for (const key of ['message', 'prompt', 'query', 'question', 'text', 'input']) {
    const value = obj[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  // Several named fields: "city: Berlin · days: 3", never braces and quotes.
  const parts = Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  return parts.join(' · ')
}
