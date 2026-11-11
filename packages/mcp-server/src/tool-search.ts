/**
 * Keyword search over a gateway's tools, for `almyty_search`.
 *
 * The same rules as the keyword half of the backend's code-mode
 * `search_tools` (backend/src/modules/tool-discovery/tool-search.ts): the
 * query is split into words (camelCase, snake_case, kebab-case and
 * punctuation all split), stopwords are dropped, and each remaining word
 * scores the best-weighted field it appears in. A match in the name counts
 * most, then the title (the operation's summary), then the description. A
 * whole word or a word's start counts fully ("pet" finds "pets"); a match
 * anywhere inside a field, half. The whole query appearing in the name earns
 * a bonus. So "get an issue" searches for "issue" and finds `get_issue`.
 *
 * Copied rather than imported: this package is published on its own and
 * cannot depend on backend source. A test checks the stopwords and the word
 * splitting stay the same as the backend's.
 */

export interface SearchableToolSummary {
  name: string;
  title?: string;
  description?: string;
}

/** Words too common to tell tools apart ("which pets are sold" searches for pets and sold). */
export const STOPWORDS = new Set(
  'a an and are as at be by can do does for from get has have how i in is it its me my of on or our please show that the their them there these this to was we what when where which who will with you your'.split(' '),
);

/** Lower-cased words, splitting camelCase, snake_case, kebab-case and punctuation. */
export function words(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);
}

/** The words of a query worth searching for: no stopwords, each once. */
export function queryTerms(query: string | null | undefined): string[] {
  return [...new Set(words(query).filter((w) => !STOPWORDS.has(w)))];
}

const FIELD_WEIGHT = { name: 4, title: 2, description: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;
const FIELDS = Object.keys(FIELD_WEIGHT) as Field[];

/** A tool's score for a query; zero means nothing matched. */
export function keywordScore(tool: SearchableToolSummary, query: string): number {
  // A query of only stopwords or one-letter words ("get") still finds by substring.
  const raw = String(query ?? '').trim().toLowerCase();
  const terms = queryTerms(query);
  if (!terms.length && raw) terms.push(raw);
  if (!terms.length) return 0;
  const text: Record<Field, string> = { name: tool.name ?? '', title: tool.title ?? '', description: tool.description ?? '' };
  const split = Object.fromEntries(FIELDS.map((f) => [f, words(text[f])])) as Record<Field, string[]>;
  const lowered = Object.fromEntries(FIELDS.map((f) => [f, text[f].toLowerCase()])) as Record<Field, string>;
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of FIELDS) {
      if (split[field].some((w) => w === term || (term.length >= 3 && w.startsWith(term)))) best = Math.max(best, FIELD_WEIGHT[field]);
      else if (lowered[field].includes(term)) best = Math.max(best, FIELD_WEIGHT[field] / 2);
    }
    score += best;
  }
  if (score > 0 && split.name.join(' ').includes(terms.join(' '))) score += 1;
  return score;
}

/** The tools that match a query, best first (ties by name). An empty query lists every tool as given. */
export function searchTools<T extends SearchableToolSummary>(tools: T[], query: string): T[] {
  if (!String(query ?? '').trim()) return tools;
  return tools
    .map((tool) => ({ tool, score: keywordScore(tool, query) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : a.tool.name > b.tool.name ? 1 : 0))
    .map((r) => r.tool);
}
