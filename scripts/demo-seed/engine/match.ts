// Matching rows against { field: value } the way conditions and ensure do.
import type { Match } from './schema.ts'

function field(row: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, k) => (cur == null ? undefined : (cur as Record<string, unknown>)[k]), row)
}

export function matches(row: unknown, where: Record<string, Match> = {}): boolean {
  return Object.entries(where).every(([path, want]) => {
    const v = field(row, path)
    if (want instanceof RegExp) return want.test(typeof v === 'string' ? v : JSON.stringify(v ?? ''))
    if (want && typeof want === 'object' && 'contains' in want) return (typeof v === 'string' ? v : JSON.stringify(v ?? '')).includes(want.contains)
    return v === want || String(v) === String(want)
  })
}
