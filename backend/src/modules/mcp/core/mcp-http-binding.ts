/**
 * The HTTP half of the MCP core: what a Streamable HTTP POST has to pass
 * before any JSON-RPC is dispatched, and what is recorded about it.
 *
 *  - Origin (2025-11-25 transports, "Security Warning"; 403 since
 *    2025-11-25 changelog Minor 3): no `Origin` passes (a server-to-server
 *    client, curl, the stdio proxy); a present one must be the dashboard,
 *    this API's own origin, or an origin listed in MCP_ALLOWED_ORIGINS.
 *    Anything else is refused with 403 and an id-less JSON-RPC error. The
 *    request's own Host header is NOT an allowed origin: under DNS rebinding
 *    the attacker controls the Host and the Origin alike.
 *  - Protocol version (2025-06-18 transports, "Protocol Version Header"):
 *    `initialize` negotiates; every other request names its version in
 *    `MCP-Protocol-Version`; no header means 2025-03-26; a header naming a
 *    version this server does not answer is a 400.
 *  - Batches: refused with 400 from 2025-06-18 on.
 *
 * The functions are pure over `req` so the unified gateway endpoint and the
 * gateway-less `POST /mcp` apply exactly the same rules.
 */
import { dashboardAllowedOrigins } from '../../../common/security/allowed-origins';
import { setProtocolContext } from '../../../common/interceptors/protocol-context';
import { JsonRpcErrorCode, JsonRpcResponse } from '../types/mcp.types';
import { McpCallContext, batchRefusal, isBatchAllowed } from './mcp-protocol-core';
import { mcpProtocolSettings } from './mcp-settings';
import { VERSION_WITHOUT_HEADER, isKnownVersion, negotiateVersion } from './versions';

export interface McpHttpRefusal {
  status: number;
  body: JsonRpcResponse;
}

type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag | undefined, name: string): string | undefined {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** Every origin an MCP request may carry, from the environment. */
export function mcpAllowedOrigins(env: Record<string, string | undefined> = process.env): Set<string> {
  const origins = dashboardAllowedOrigins((name) => env[name], env.NODE_ENV);
  for (const name of ['BASE_URL', 'API_BASE_URL', 'API_URL']) {
    const own = originOf(env[name]);
    if (own) origins.add(own);
  }
  for (const extra of mcpProtocolSettings(env).extraAllowedOrigins) {
    const origin = originOf(extra);
    if (origin) origins.add(origin);
  }
  if (env.NODE_ENV !== 'production') {
    // MCP Inspector's browser UI, for local debugging.
    origins.add('http://localhost:6274');
    origins.add('http://127.0.0.1:6274');
  }
  return origins;
}

function idOf(body: unknown): string | number | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const id = (body as any).id;
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}

/** 403 for an `Origin` this server does not serve, else null. */
export function mcpOriginRefusal(
  req: { headers?: HeaderBag },
  allowed: ReadonlySet<string> = mcpAllowedOrigins(),
): McpHttpRefusal | null {
  const raw = header(req.headers, 'origin');
  if (raw === undefined) return null;
  const origin = originOf(raw);
  if (origin && allowed.has(origin)) return null;
  return {
    status: 403,
    body: {
      jsonrpc: '2.0',
      id: null as any,
      error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: 'Forbidden: Origin not allowed' },
    },
  };
}

export type McpVersionResolution = { ctx: McpCallContext } | { refusal: McpHttpRefusal };

/** The protocol version one POST is served at, or the 400 that refuses it. */
export function resolveMcpRequestVersion(req: { headers?: HeaderBag }, body: unknown): McpVersionResolution {
  const supported = mcpProtocolSettings().supportedVersions;

  if (body && typeof body === 'object' && !Array.isArray(body) && (body as any).method === 'initialize') {
    return { ctx: { version: negotiateVersion((body as any).params?.protocolVersion, supported), era: 'legacy' } };
  }

  const requested = header(req.headers, 'mcp-protocol-version')?.trim();
  if (requested === undefined || requested === '') {
    const ctx: McpCallContext = { version: VERSION_WITHOUT_HEADER, era: 'assumed' };
    return Array.isArray(body) && !isBatchAllowed(ctx.version)
      ? { refusal: { status: 400, body: batchRefusal(ctx.version) } }
      : { ctx };
  }
  if (!isKnownVersion(requested) || !supported.includes(requested)) {
    return {
      refusal: {
        status: 400,
        body: {
          jsonrpc: '2.0',
          id: idOf(body) as any,
          error: {
            code: JsonRpcErrorCode.INVALID_REQUEST,
            message: `Unsupported protocol version: ${requested.slice(0, 32)}`,
            data: { supported, requested: requested.slice(0, 32) },
          },
        },
      },
    };
  }
  if (Array.isArray(body) && !isBatchAllowed(requested)) {
    return { refusal: { status: 400, body: batchRefusal(requested) } };
  }
  return { ctx: { version: requested, era: 'legacy' } };
}

export interface McpRequestRecord {
  protocolVersion: string;
  era: string;
  method: string;
  clientName: string;
  clientVersion: string | null;
  outcome?: 'ok' | 'error' | 'tool_error' | 'refused' | 'notification';
}

function methodOf(body: unknown): string {
  if (Array.isArray(body)) return 'batch';
  const method = body && typeof body === 'object' ? (body as any).method : undefined;
  return typeof method === 'string' ? method.slice(0, 64) : 'invalid';
}

/**
 * Put the protocol version and client of this request on the request log
 * row and the usage metric (design doc, "Request log": from day one).
 * clientInfo arrives only on `initialize` before 2026-07-28; every other
 * legacy request is logged as `unknown`, and the request log row keeps
 * the User-Agent next to it.
 */
export function recordMcpRequest(req: unknown, ctx: McpCallContext | null, body: unknown, outcome?: McpRequestRecord['outcome']): void {
  const clientInfo =
    body && typeof body === 'object' && !Array.isArray(body) && (body as any).method === 'initialize'
      ? (body as any).params?.clientInfo
      : undefined;
  const record: McpRequestRecord = {
    protocolVersion: ctx?.version ?? 'refused',
    era: ctx?.era ?? 'refused',
    method: methodOf(body),
    clientName: typeof clientInfo?.name === 'string' ? clientInfo.name.slice(0, 128) : 'unknown',
    clientVersion: typeof clientInfo?.version === 'string' ? clientInfo.version.slice(0, 64) : null,
    ...(outcome ? { outcome } : {}),
  };
  setProtocolContext(req, { mcp: record });
}

/** How a JSON-RPC answer went, for the request log. */
export function mcpOutcomeOf(result: JsonRpcResponse | JsonRpcResponse[] | null): McpRequestRecord['outcome'] {
  if (result === null) return 'notification';
  const all = Array.isArray(result) ? result : [result];
  if (all.some((r) => r.error)) return 'error';
  if (all.some((r) => r.result?.isError === true)) return 'tool_error';
  return 'ok';
}
