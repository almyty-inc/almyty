/**
 * The keyword half of search_tools and the fusion of both halves
 * (docs/design/code-mode.md, part B). Pure: given the candidate tools (the
 * caller's scope, decided before anything is ranked) and a query.
 *
 * Keyword scoring matches the query's words against the tool's name, its
 * operation id and API name, its tags and its description, a match in the
 * name counting most. The vector half ranks by embedding similarity
 * (tool-embedding.service.ts). The two rankings are merged by reciprocal
 * rank fusion, score = sum over rankings of 1 / (k + rank), which needs no
 * calibration between keyword scores and cosine distances.
 */

/** What a tool is searched by. Every field is the tool's own: nothing from outside the scope. */
export interface SearchableTool {
  id: string;
  name: string;
  description?: string | null;
  parameters?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
  configuration?: Record<string, any> | null;
  operation?: { operationId?: string | null; name?: string | null; tags?: string[] | null } | null;
  api?: { name?: string | null } | null;
}

/** Words too common to tell tools apart ("which pets are sold" searches for pets and sold). */
const STOPWORDS = new Set(
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

/** Parameter names and their string enum values (`status: available | pending | sold`). */
function parameterText(parameters: Record<string, any> | null | undefined): string {
  const properties = parameters?.properties;
  if (!properties || typeof properties !== 'object') return '';
  const parts: string[] = [];
  for (const [key, schema] of Object.entries(properties).slice(0, 50)) {
    parts.push(key);
    const values = (schema as any)?.enum ?? (schema as any)?.items?.enum;
    if (Array.isArray(values)) parts.push(...values.filter((v: unknown) => typeof v === 'string').slice(0, 20));
  }
  return parts.join(' ');
}

/** The text a tool is found by; also what its embedding is computed from. */
export function searchText(tool: SearchableTool): { name: string; identifiers: string; tags: string; description: string; params: string } {
  const meta = tool.metadata ?? {};
  const op = tool.operation ?? meta.sourceOperation ?? {};
  // The operation id and its summary (both name the operation) and the API.
  const operationName = [op.operationId, op.name].filter((v) => typeof v === 'string' && v).join(' ');
  const apiName = tool.api?.name ?? meta.sourceApi?.name ?? '';
  const tags = [...(Array.isArray(op.tags) ? op.tags : []), ...(Array.isArray(meta.tags) ? meta.tags : [])].filter((t) => typeof t === 'string');
  // A generated tool's name starts with its API's (petstore_find_pets): that
  // prefix is in every tool of the API, and would match "pets" in all of them.
  const apiPrefix = words(apiName).join('_');
  const name = tool.name ?? '';
  const ownName = apiPrefix && name.toLowerCase().startsWith(`${apiPrefix}_`) ? name.slice(apiPrefix.length + 1) : name;
  return {
    name: ownName,
    identifiers: [operationName, apiName].filter(Boolean).join(' '),
    tags: tags.join(' '),
    description: tool.description ?? '',
    params: parameterText(tool.parameters),
  };
}
const FIELD_WEIGHT = { name: 4, identifiers: 2, tags: 2, description: 1, params: 1 } as const;

/**
 * A tool's keyword score for a query: per query word, the best-weighted
 * field it appears in (whole word, or as a prefix of a word, e.g. "pet"
 * finds "pets"; anywhere inside the field at half weight), plus a bonus
 * when the whole query appears in the name. Zero means nothing matched.
 */
export function keywordScore(tool: SearchableTool, query: string): number {
  // A query of one-letter words still finds by substring, as tools/search always did.
  const raw = String(query ?? '').trim().toLowerCase();
  const terms = queryTerms(query);
  if (!terms.length && raw) terms.push(raw);
  if (!terms.length) return 0;
  const text = searchText(tool);
  const keys = Object.keys(FIELD_WEIGHT) as Array<keyof typeof FIELD_WEIGHT>;
  const fields = Object.fromEntries(keys.map((key) => [key, words(text[key])])) as Record<keyof typeof FIELD_WEIGHT, string[]>;
  const lowered = Object.fromEntries(keys.map((key) => [key, text[key].toLowerCase()])) as Record<keyof typeof FIELD_WEIGHT, string>;
  let score = 0;
  for (const term of terms) {
    let best = 0;
    for (const key of keys) {
      // A whole word or a word's start counts fully; anywhere inside a field, half.
      if (fields[key].some((w) => w === term || (term.length >= 3 && w.startsWith(term)))) best = Math.max(best, FIELD_WEIGHT[key]);
      else if (lowered[key].includes(term)) best = Math.max(best, FIELD_WEIGHT[key] / 2);
    }
    score += best;
  }
  if (score > 0 && words(text.name).join(' ').includes(terms.join(' '))) score += 1;
  return score;
}

/**
 * Reciprocal rank fusion of several rankings (each a list of ids, best
 * first), each optionally weighted: score = sum of weight / (k + rank).
 */
export function reciprocalRankFusion(rankings: string[][], k: number, weights: number[] = []): Map<string, number> {
  const scores = new Map<string, number>();
  rankings.forEach((ranking, r) => {
    const weight = weights[r] ?? 1;
    ranking.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + index + 1));
    });
  });
  return scores;
}
