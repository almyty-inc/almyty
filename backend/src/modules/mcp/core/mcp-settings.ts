/**
 * Every MCP tunable in one place, read from the environment with a default.
 *
 * Owner rule: limits, TTLs and the accepted-versions list are
 * configuration, not constants scattered through the handlers. Each value
 * is read when asked for, so a test can set the variable and see it
 * applied without rebuilding a module, and a misspelt or out-of-range
 * value falls back to its default rather than to zero.
 *
 *   MCP_PROTOCOL_VERSIONS            comma list of versions answered
 *                                    (default: every version in versions.ts)
 *   MCP_ALLOWED_ORIGINS              extra browser origins allowed to call MCP
 *   MCP_TOOLS_LIST_CACHE_SECONDS     tools/list cache TTL (default 60)
 *   MCP_EMIT_OUTPUT_SCHEMA           declare tool outputSchema (default true)
 *   MCP_CIMD_ENABLED                 accept Client ID Metadata Documents (default true)
 *   MCP_CIMD_FETCH_TIMEOUT_MS        total deadline per metadata fetch (default 5000)
 *   MCP_CIMD_MAX_BYTES               metadata document size cap (default 65536)
 *   MCP_CIMD_CACHE_MIN_SECONDS       cache floor (default 300)
 *   MCP_CIMD_CACHE_MAX_SECONDS       cache ceiling (default 86400)
 *   MCP_CIMD_FETCHES_PER_HOST        metadata fetches per host per window (default 30)
 *   MCP_CIMD_FETCH_WINDOW_SECONDS    the window for that limit (default 60)
 *   MCP_OAUTH_INFER_APPLICATION_TYPE treat a DCR request without
 *                                    application_type whose redirect URIs are
 *                                    all loopback as native (default true)
 */
import { KNOWN_PROTOCOL_VERSIONS, ProtocolVersion, isKnownVersion } from './versions';

type Env = Record<string, string | undefined>;

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}

function boolSetting(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function listSetting(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface McpProtocolSettings {
  /** Versions answered, newest first. Never empty. */
  supportedVersions: ProtocolVersion[];
  /** Browser origins allowed in addition to the dashboard's own. */
  extraAllowedOrigins: string[];
  toolsListCacheSeconds: number;
  emitOutputSchema: boolean;
}

export function mcpProtocolSettings(env: Env = process.env): McpProtocolSettings {
  const configured = listSetting(env, 'MCP_PROTOCOL_VERSIONS').filter(isKnownVersion);
  // An empty or entirely unknown list would make every request a 400;
  // fall back to everything this code speaks instead.
  const supportedVersions = (configured.length ? configured : [...KNOWN_PROTOCOL_VERSIONS])
    .sort()
    .reverse() as ProtocolVersion[];
  return {
    supportedVersions: [...new Set(supportedVersions)],
    extraAllowedOrigins: listSetting(env, 'MCP_ALLOWED_ORIGINS'),
    toolsListCacheSeconds: intSetting(env, 'MCP_TOOLS_LIST_CACHE_SECONDS', 60, 0, 86_400),
    emitOutputSchema: boolSetting(env, 'MCP_EMIT_OUTPUT_SCHEMA', true),
  };
}

export interface CimdSettings {
  enabled: boolean;
  fetchTimeoutMs: number;
  maxBytes: number;
  cacheMinSeconds: number;
  cacheMaxSeconds: number;
  fetchesPerHost: number;
  fetchWindowSeconds: number;
}

export function cimdSettings(env: Env = process.env): CimdSettings {
  const cacheMinSeconds = intSetting(env, 'MCP_CIMD_CACHE_MIN_SECONDS', 300, 0, 7 * 86_400);
  const cacheMaxSeconds = intSetting(env, 'MCP_CIMD_CACHE_MAX_SECONDS', 86_400, 1, 30 * 86_400);
  return {
    enabled: boolSetting(env, 'MCP_CIMD_ENABLED', true),
    fetchTimeoutMs: intSetting(env, 'MCP_CIMD_FETCH_TIMEOUT_MS', 5_000, 100, 60_000),
    maxBytes: intSetting(env, 'MCP_CIMD_MAX_BYTES', 65_536, 1_024, 1_048_576),
    cacheMinSeconds: Math.min(cacheMinSeconds, cacheMaxSeconds),
    cacheMaxSeconds,
    fetchesPerHost: intSetting(env, 'MCP_CIMD_FETCHES_PER_HOST', 30, 1, 10_000),
    fetchWindowSeconds: intSetting(env, 'MCP_CIMD_FETCH_WINDOW_SECONDS', 60, 1, 86_400),
  };
}

export function inferApplicationType(env: Env = process.env): boolean {
  return boolSetting(env, 'MCP_OAUTH_INFER_APPLICATION_TYPE', true);
}
