/**
 * Model search: the one rule every model list filters by (the Models page
 * and the model picker used by agents).
 *
 * The query is matched against the model's id and display name. The
 * provider's name and type count only when no model id or name matches at
 * all: typing "openai" still lists OpenAI's models, but "gpt-4o" lists only
 * the gpt-4o models, even under a provider someone named "OpenAI · GPT-4o".
 *
 * Separators are ignored on both sides, so "gpt4o", "gpt 4o" and "gpt-4o"
 * are the same query. Hits are ranked: exact id or name, then prefix, then
 * substring; the input order is kept within a rank.
 */

export interface ModelSearchFields {
  /** The vendor's model id, e.g. "gpt-4o-mini". */
  id: string
  /** The display name, when it differs from the id. */
  name?: string | null
  /** The connected provider's name, as the user chose it. */
  providerName?: string | null
  /** The provider type, e.g. "openai". */
  providerType?: string | null
}

export const MODEL_RANK = { exact: 0, prefix: 1, substring: 2, provider: 3 } as const

/** Lowercase, with every separator (space, dash, dot, slash, colon...) removed. */
export function normalizeModelSearch(text: string | null | undefined): string {
  return (text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function rankText(text: string | null | undefined, q: string): number | null {
  const t = normalizeModelSearch(text)
  if (!t) return null
  if (t === q) return MODEL_RANK.exact
  if (t.startsWith(q)) return MODEL_RANK.prefix
  if (t.includes(q)) return MODEL_RANK.substring
  return null
}

function rankModel(f: ModelSearchFields, q: string): number | null {
  const ranks = [rankText(f.id, q), rankText(f.name, q)].filter((r): r is number => r !== null)
  return ranks.length > 0 ? Math.min(...ranks) : null
}

function matchesProvider(f: ModelSearchFields, q: string): boolean {
  return rankText(f.providerName, q) !== null || rankText(f.providerType, q) !== null
}

/** Whether any of `texts` contains `query`, separators ignored. An empty query matches. */
export function textMatchesSearch(query: string, ...texts: Array<string | null | undefined>): boolean {
  const q = normalizeModelSearch(query)
  return !q || texts.some((t) => rankText(t, q) !== null)
}

/**
 * A scorer for `items` under `query`: the rank of an item (lower is better),
 * or null when it does not match. Whether provider names count is decided
 * over the whole list, so pass every model the screen could show.
 */
export function modelSearchScorer<T>(items: readonly T[], query: string, fields: (item: T) => ModelSearchFields): (item: T) => number | null {
  const q = normalizeModelSearch(query)
  if (!q) return () => MODEL_RANK.exact
  const byModel = items.some((item) => rankModel(fields(item), q) !== null)
  if (byModel) return (item) => rankModel(fields(item), q)
  return (item) => (matchesProvider(fields(item), q) ? MODEL_RANK.provider : null)
}

/** Filter by a scorer and sort stably by its rank. */
export function rankBy<T>(items: readonly T[], score: (item: T) => number | null): T[] {
  return items
    .map((item, index) => ({ item, index, rank: score(item) }))
    .filter((e): e is { item: T; index: number; rank: number } => e.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((e) => e.item)
}
