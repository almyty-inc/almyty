/**
 * Tunables of the MCP OAuth client (sign-in to a remote MCP server for an
 * MCP source), read from the environment with a default. Out-of-range or
 * misspelt values fall back to the default, never to zero.
 *
 *   MCP_CLIENT_OAUTH_FETCH_TIMEOUT_MS      deadline per discovery, registration
 *                                          or token request (default 10000)
 *   MCP_CLIENT_OAUTH_MAX_BYTES             largest metadata or token response
 *                                          read (default 65536)
 *   MCP_CLIENT_OAUTH_REFRESH_SKEW_SECONDS  refresh a token this long before it
 *                                          expires (default 60)
 *   MCP_CLIENT_CIMD_ENABLED                serve the almyty client metadata
 *                                          document and use it as client id
 *                                          where a server accepts one (default true)
 *   MCP_CLIENT_CIMD_MAX_AGE_SECONDS        how long servers may cache that document
 *                                          (default 3600)
 *   MCP_CLIENT_NAME                        the name a server's consent page
 *                                          shows for almyty (default "almyty")
 *   MCP_ALLOW_PRIVATE_URLS                 (shared with the MCP connection probe)
 *                                          allow private and loopback addresses
 */
type Env = Record<string, string | undefined>;

function intSetting(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function boolSetting(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export interface McpOAuthClientSettings {
  fetchTimeoutMs: number;
  maxBytes: number;
  refreshSkewSeconds: number;
  cimdEnabled: boolean;
  clientName: string;
  /** How long servers may cache the client metadata document. */
  cimdMaxAgeSeconds: number;
  allowPrivateUrls: boolean;
}

export function mcpOAuthClientSettings(env: Env = process.env): McpOAuthClientSettings {
  const name = (env.MCP_CLIENT_NAME ?? '').trim();
  return {
    fetchTimeoutMs: intSetting(env, 'MCP_CLIENT_OAUTH_FETCH_TIMEOUT_MS', 10_000, 500, 120_000),
    maxBytes: intSetting(env, 'MCP_CLIENT_OAUTH_MAX_BYTES', 65_536, 1_024, 1_048_576),
    refreshSkewSeconds: intSetting(env, 'MCP_CLIENT_OAUTH_REFRESH_SKEW_SECONDS', 60, 0, 3_600),
    cimdEnabled: boolSetting(env, 'MCP_CLIENT_CIMD_ENABLED', true),
    clientName: name && name.length <= 100 ? name : 'almyty',
    cimdMaxAgeSeconds: intSetting(env, 'MCP_CLIENT_CIMD_MAX_AGE_SECONDS', 3_600, 0, 604_800),
    allowPrivateUrls: boolSetting(env, 'MCP_ALLOW_PRIVATE_URLS', false),
  };
}
