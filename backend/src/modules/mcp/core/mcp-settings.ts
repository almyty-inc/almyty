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
 *   MCP_RESULT_TTL_MS                ttlMs on cacheable 2026-07-28 results (default 60000)
 *   MCP_LISTEN_KEEPALIVE_MS          keep-alive on subscriptions/listen streams (default 15000)
 *   MCP_LISTEN_MAX_SECONDS           longest a listen stream stays open (default 3600)
 *   MCP_TASK_POLL_INTERVAL_MS        pollIntervalMs on an agent run served as a task (default 2000)
 *   MCP_INVOKE_WAIT_MS               how long invoke_agent waits for a run that may ask
 *                                    a question, without tasks (default 25000; 0 = never)
 *   MCP_HELD_CALL_WAIT_MS            how long a just-approved held call is waited for
 *                                    before the caller is told to come back (default 5000)
 *   MCP_REQUEST_STATE_TTL_SECONDS    how long an input_required requestState stays valid
 *                                    (default 900)
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
 *   MCP_LEGACY_SSE_*                 deprecation headers on the legacy HTTP+SSE
 *                                    routes (legacySseSettings, below)
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
  /** ttlMs on cacheable 2026-07-28 results (discover, lists, resources/read). */
  resultTtlMs: number;
  /** SSE keep-alive comment cadence on a subscriptions/listen stream. */
  listenKeepaliveMs: number;
  /** A listen stream is closed gracefully after this long; the client re-listens. */
  listenMaxSeconds: number;
  /** pollIntervalMs on an agent run served as a task (Tasks extension). */
  taskPollIntervalMs: number;
  /** invoke_agent without tasks: how long it waits for a run before answering with the run id. 0 = never. */
  invokeWaitMs: number;
  /** A held call approved through input_required: how long its result is waited for. */
  heldCallWaitMs: number;
  /** Lifetime of a sealed requestState handed out with input_required. */
  requestStateTtlSeconds: number;
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
    resultTtlMs: intSetting(env, 'MCP_RESULT_TTL_MS', 60_000, 0, 86_400_000),
    listenKeepaliveMs: intSetting(env, 'MCP_LISTEN_KEEPALIVE_MS', 15_000, 1_000, 300_000),
    listenMaxSeconds: intSetting(env, 'MCP_LISTEN_MAX_SECONDS', 3_600, 10, 86_400),
    taskPollIntervalMs: intSetting(env, 'MCP_TASK_POLL_INTERVAL_MS', 2_000, 100, 600_000),
    invokeWaitMs: intSetting(env, 'MCP_INVOKE_WAIT_MS', 25_000, 0, 120_000),
    heldCallWaitMs: intSetting(env, 'MCP_HELD_CALL_WAIT_MS', 5_000, 0, 60_000),
    requestStateTtlSeconds: intSetting(env, 'MCP_REQUEST_STATE_TTL_SECONDS', 900, 30, 86_400),
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

/**
 * The legacy HTTP+SSE transport (2024-11-05; `GET /mcp/sse`,
 * `POST /mcp/sse/:connectionId/message`, `GET /mcp/servers/:serverId/sse`)
 * is deprecated in MCP 2026-07-28 (SEP-2596). It is still served; its
 * responses say so with RFC 9745 headers:
 *
 *   MCP_LEGACY_SSE_DEPRECATION_HEADERS  send them (default true)
 *   MCP_LEGACY_SSE_DEPRECATED_AT        the date it was deprecated, ISO 8601
 *                                       (default 2026-07-28)
 *   MCP_LEGACY_SSE_DOCS_URL             where the Link header points
 *                                       (default the MCP gateway docs)
 */
export interface LegacySseSettings {
  deprecationHeaders: boolean;
  /** Seconds since the epoch, for the `Deprecation: @<seconds>` header. */
  deprecatedAt: number;
  docsUrl: string;
}

const LEGACY_SSE_DEPRECATED_AT = '2026-07-28T00:00:00Z';
const LEGACY_SSE_DOCS_URL = 'https://docs.almyty.com/gateways/mcp#legacy-sse-transport';

export function legacySseSettings(env: Env = process.env): LegacySseSettings {
  const raw = env.MCP_LEGACY_SSE_DEPRECATED_AT?.trim();
  const parsed = raw ? Date.parse(raw) : NaN;
  const at = Number.isFinite(parsed) ? parsed : Date.parse(LEGACY_SSE_DEPRECATED_AT);
  const docs = env.MCP_LEGACY_SSE_DOCS_URL?.trim();
  return {
    deprecationHeaders: boolSetting(env, 'MCP_LEGACY_SSE_DEPRECATION_HEADERS', true),
    deprecatedAt: Math.floor(at / 1000),
    // Only an http(s) URL goes into a header; anything else falls back.
    docsUrl: docs && /^https?:\/\/[^\s<>"]+$/.test(docs) ? docs : LEGACY_SSE_DOCS_URL,
  };
}
