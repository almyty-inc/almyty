import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Plurals English does not form with a trailing s. */
const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
  child: 'children',
  ms: 'ms',
}

function pluralOf(word: string): string {
  // Only the last word of a phrase takes the plural: "short-term note".
  const m = /^(.*?)([A-Za-z]+)$/.exec(word)
  if (!m) return word + 's'
  const [, head, last] = m
  const lower = last.toLowerCase()
  if (IRREGULAR_PLURALS[lower]) return head + IRREGULAR_PLURALS[lower]
  // Acronyms take a bare s: "API" -> "APIs".
  if (last.length > 1 && last === last.toUpperCase()) return word + 's'
  if (/[^aeiou]y$/.test(lower)) return head + last.slice(0, -1) + 'ies'
  if (/(s|x|z|ch|sh)$/.test(lower)) return word + 'es'
  return word + 's'
}

/**
 * The noun alone, singular for exactly one and plural otherwise:
 * pluralize(1, 'policy') -> 'policy', pluralize(2, 'policy') -> 'policies'.
 * Pass `plural` for a form the rules above do not produce.
 */
export function pluralize(n: number, word: string, plural?: string): string {
  return n === 1 ? word : (plural ?? pluralOf(word));
}

/**
 * The count and its noun: pluralized(1, 'member') -> '1 member',
 * pluralized(3, 'member') -> '3 members'. Every "{n} things" in the UI
 * goes through here; plural-copy.test.ts holds the source to that.
 */
export function pluralized(n: number | null | undefined, word: string, plural?: string): string {
  const count = n ?? 0
  return count + ' ' + pluralize(count, word, plural);
}

export function formatDate(date: Date | string): string {
  const d = new Date(date)
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

export function formatDateTime(date: Date | string): string {
  const d = new Date(date)
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount)
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num)
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map(word => word.charAt(0))
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

/**
 * "3h ago", or "in 3h" for a time still to come (an expiry, a next run).
 * A time a few seconds either side of now is "just now", so a clock a
 * little ahead of the server's does not read as the future.
 */
export function formatRelativeTime(date: Date | string): string {
  const d = new Date(date)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const future = diffMs < 0
  const diffSec = Math.floor(Math.abs(diffMs) / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)
  const say = (amount: string) => (future ? `in ${amount}` : `${amount} ago`)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return say(`${diffMin}m`)
  if (diffHr < 24) return say(`${diffHr}h`)
  if (diffDay < 30) return say(`${diffDay}d`)
  return formatDate(date)
}
