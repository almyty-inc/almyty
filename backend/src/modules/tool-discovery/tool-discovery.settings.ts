/**
 * Tool discovery tunables (docs/design/code-mode.md, part B), read from the
 * environment with a default, each time they are asked for (so a spec can
 * set one and see it applied). A misspelt or out-of-range value falls back
 * to its default.
 *
 *   TOOL_SEARCH_DEFAULT_LIMIT       results when search_tools names no limit (default 10)
 *   TOOL_SEARCH_MAX_LIMIT           most results one search returns (default 50)
 *   TOOL_SEARCH_RRF_K               reciprocal-rank-fusion constant: higher flattens
 *                                   the difference between ranks (default 60)
 *   TOOL_SEARCH_VECTOR_CANDIDATES   nearest tools the vector half ranks (default 100)
 *   TOOL_SEARCH_FALLBACK_VECTOR_WEIGHT  weight of the vector half when no embedding provider
 *                                   is connected and the hash fallback embedded (0..1, default 0.25)
 *   TOOL_EMBEDDINGS_ENABLED         compute tool embeddings at all (default true); off,
 *                                   search ranks by keywords alone
 */
type Env = Record<string, string | undefined>;

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function floatSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function boolSetting(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export interface ToolDiscoverySettings {
  defaultLimit: number;
  maxLimit: number;
  rrfK: number;
  vectorCandidates: number;
  /** Weight of the vector half when only the hash fallback embedded (0..1). */
  fallbackVectorWeight: number;
  embeddingsEnabled: boolean;
}

export function toolDiscoverySettings(env: Env = process.env): ToolDiscoverySettings {
  const maxLimit = intSetting(env, 'TOOL_SEARCH_MAX_LIMIT', 50, 1, 500);
  return {
    defaultLimit: Math.min(intSetting(env, 'TOOL_SEARCH_DEFAULT_LIMIT', 10, 1, 500), maxLimit),
    maxLimit,
    rrfK: intSetting(env, 'TOOL_SEARCH_RRF_K', 60, 1, 1_000),
    vectorCandidates: intSetting(env, 'TOOL_SEARCH_VECTOR_CANDIDATES', 100, 1, 5_000),
    fallbackVectorWeight: floatSetting(env, 'TOOL_SEARCH_FALLBACK_VECTOR_WEIGHT', 0.25, 0, 1),
    embeddingsEnabled: boolSetting(env, 'TOOL_EMBEDDINGS_ENABLED', true),
  };
}
