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
import { updateRequestContext } from '../../../common/request-context';
import { JsonRpcErrorCode, JsonRpcResponse } from '../types/mcp.types';
import { McpCallContext, McpTraceContext, batchRefusal, isBatchAllowed } from './mcp-protocol-core';
import { mcpProtocolSettings } from './mcp-settings';
import { ProtocolVersion, VERSION_WITHOUT_HEADER, isKnownVersion, isModernVersion, negotiateVersion } from './versions';

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

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_CLIENT = 'io.modelcontextprotocol/clientInfo';

/** The methods whose `Mcp-Name` header mirrors a body field (2026-07-28, "Standard Request Headers"). */
const NAME_FIELD: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

function refusal(status: number, id: unknown, code: number, message: string, data?: unknown): { refusal: McpHttpRefusal } {
  return {
    refusal: {
      status,
      body: {
        jsonrpc: '2.0',
        id: (typeof id === 'string' || typeof id === 'number' ? id : null) as any,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
      },
    },
  };
}

function unsupportedVersion(id: unknown, requested: string): { refusal: McpHttpRefusal } {
  return refusal(400, id, JsonRpcErrorCode.UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', {
    supported: mcpProtocolSettings().supportedVersions,
    requested: requested.slice(0, 32),
  });
}

function headerMismatch(id: unknown, message: string): { refusal: McpHttpRefusal } {
  return refusal(400, id, JsonRpcErrorCode.HEADER_MISMATCH, `Header mismatch: ${message}`);
}

const SENTINEL = /^=\?base64\?(.*)\?=$/;

/**
 * Decode a header value that may use the Base64 sentinel
 * (`=?base64?...?=`, 2026-07-28 "Value Encoding"). Returns null for a value
 * no conforming client sends: bad Base64, or a plain value outside the
 * visible-ASCII set.
 */
export function decodeMcpHeaderValue(raw: string): string | null {
  const sentinel = SENTINEL.exec(raw);
  if (sentinel) {
    const encoded = sentinel[1];
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return null;
    const text = bytes.toString('utf8');
    return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
  }
  return /^[\x20-\x7e\t]*$/.test(raw) ? raw : null;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * W3C trace context from a modern request's `_meta` (2026-07-28 Minor 2):
 * kept only when `traceparent` is well formed (W3C Trace Context section 3.2:
 * version not ff, trace and parent ids not all zero). A malformed one is
 * ignored rather than refused: tracing is advisory.
 */
export function traceFromMeta(meta: Record<string, unknown>): McpTraceContext | undefined {
  const traceparent = typeof meta.traceparent === 'string' ? meta.traceparent.trim().toLowerCase() : '';
  const match = TRACEPARENT.exec(traceparent);
  if (!match || match[1] === 'ff' || /^0+$/.test(match[2]) || /^0+$/.test(match[3])) return undefined;
  const trace: McpTraceContext = { traceparent };
  if (typeof meta.tracestate === 'string' && meta.tracestate.length <= 512 && /^[\x20-\x7e]*$/.test(meta.tracestate)) {
    trace.tracestate = meta.tracestate;
  }
  if (typeof meta.baggage === 'string' && meta.baggage.length <= 8192 && /^[\x20-\x7e]*$/.test(meta.baggage)) {
    trace.baggage = meta.baggage;
  }
  return trace;
}

/**
 * A modern (2026-07-28) request: `_meta` carries the version. Validated in
 * the order the spec gives: the version (-32022), the required `_meta`
 * fields (-32602), then the mirrored headers (-32020), each a 400 before
 * anything runs. Header names are case-insensitive, values are compared
 * exactly after trimming the whitespace HTTP allows around them.
 */
function resolveModern(req: { headers?: HeaderBag }, body: any, meta: Record<string, unknown>): McpVersionResolution {
  const id = body.id;
  const version = meta[META_VERSION];

  // The header and the body must name the same version before either is
  // believed: a mismatch is -32020 whatever the version, and only an agreed
  // version that is not served is -32022.
  const headerVersion = header(req.headers, 'mcp-protocol-version')?.trim();
  if (headerVersion === undefined) return headerMismatch(id, 'MCP-Protocol-Version header is required');
  if (headerVersion !== version) {
    return headerMismatch(id, `MCP-Protocol-Version header '${headerVersion.slice(0, 32)}' does not match _meta protocolVersion '${String(version).slice(0, 32)}'`);
  }
  if (typeof version !== 'string' || !isModernVersion(version) || !mcpProtocolSettings().supportedVersions.includes(version as ProtocolVersion)) {
    return unsupportedVersion(id, String(version));
  }
  const capabilities = meta[META_CAPABILITIES];
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return refusal(400, id, JsonRpcErrorCode.INVALID_PARAMS, `Invalid params: _meta["${META_CAPABILITIES}"] is required`);
  }

  // Requests carry Mcp-Method (and Mcp-Name where a body field is mirrored);
  // the spec defines no header requirements for notifications.
  if (body.id !== undefined) {
    const method = header(req.headers, 'mcp-method')?.trim();
    if (method === undefined) return headerMismatch(id, 'Mcp-Method header is required');
    if (method !== body.method) {
      return headerMismatch(id, `Mcp-Method header value '${method.slice(0, 64)}' does not match body value '${String(body.method).slice(0, 64)}'`);
    }
    const field = NAME_FIELD[body.method];
    if (field) {
      const rawName = header(req.headers, 'mcp-name')?.trim();
      if (rawName === undefined) return headerMismatch(id, 'Mcp-Name header is required');
      const name = decodeMcpHeaderValue(rawName);
      if (name === null) return headerMismatch(id, 'Mcp-Name header value is not a valid header value');
      const bodyValue = body.params?.[field];
      if (name !== bodyValue) {
        return headerMismatch(id, `Mcp-Name header value '${name.slice(0, 64)}' does not match body value '${String(bodyValue).slice(0, 64)}'`);
      }
    }
  }

  // Mcp-Param-* headers travel to the tool handler, which knows the tool's
  // schema and so which of them the body mirrors (mcp-param-headers.ts).
  const paramHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith('mcp-param-') && value !== undefined) paramHeaders[lower] = Array.isArray(value) ? value[0] : value;
  }

  const clientInfo = meta[META_CLIENT];
  return {
    ctx: {
      version: version as ProtocolVersion,
      era: 'modern',
      clientCapabilities: capabilities as Record<string, unknown>,
      ...(body.method === 'tools/call' ? { paramHeaders } : {}),
      ...(clientInfo && typeof clientInfo === 'object' ? { clientInfo: clientInfo as { name?: string; version?: string } } : {}),
      ...(traceFromMeta(meta) ? { trace: traceFromMeta(meta) } : {}),
    },
  };
}

/**
 * The protocol version one POST is served at, or the 400 that refuses it
 * (design doc, "Version negotiation: several versions at once"):
 *
 *  1. `_meta` names a version: modern, validated by resolveModern.
 *  2. `initialize`: the legacy handshake, which picks among legacy versions.
 *  3. Otherwise the `MCP-Protocol-Version` header names the legacy version,
 *     and no header means 2025-03-26. A header naming a modern version on a
 *     request without `_meta` is a malformed modern request (-32602).
 *
 * A request that looks modern and legacy at once (an `initialize` carrying
 * `_meta`) is modern: rule 1 wins, and `initialize` is then an unknown
 * method (404).
 */
export function resolveMcpRequestVersion(req: { headers?: HeaderBag }, body: unknown): McpVersionResolution {
  const supported = mcpProtocolSettings().supportedVersions;
  const single = body && typeof body === 'object' && !Array.isArray(body) ? (body as any) : null;

  const meta = single?.params?._meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta) && META_VERSION in meta) {
    return resolveModern(req, single, meta as Record<string, unknown>);
  }

  if (single?.method === 'initialize') {
    return { ctx: { version: negotiateVersion(single.params?.protocolVersion, supported), era: 'legacy' } };
  }

  const requested = header(req.headers, 'mcp-protocol-version')?.trim();
  if (requested === undefined || requested === '') {
    const ctx: McpCallContext = { version: VERSION_WITHOUT_HEADER, era: 'assumed' };
    return Array.isArray(body) && !isBatchAllowed(ctx.version)
      ? { refusal: { status: 400, body: batchRefusal(ctx.version) } }
      : { ctx };
  }
  if (!isKnownVersion(requested) || !supported.includes(requested)) {
    return unsupportedVersion(idOf(body), requested);
  }
  if (Array.isArray(body) && !isBatchAllowed(requested)) {
    return { refusal: { status: 400, body: batchRefusal(requested) } };
  }
  if (isModernVersion(requested)) {
    return refusal(400, idOf(body), JsonRpcErrorCode.INVALID_PARAMS, `Invalid params: _meta["${META_VERSION}"] is required`);
  }
  return { ctx: { version: requested, era: 'legacy' } };
}

/**
 * Put what the client told us about this request into its scope before
 * anything runs: the trace context, so the tool execution rows and audit rows
 * written while it runs carry the client's trace (design doc, decision 10).
 */
export function enterMcpRequest(ctx: McpCallContext): void {
  if (ctx.trace) updateRequestContext({ trace: ctx.trace });
}

/**
 * The HTTP status of an answer: 202 for no answer (notifications only),
 * otherwise 200, except for a modern request an unknown method (404 with
 * -32601, which is how a dual-era client tells a modern server from a
 * legacy one) and header or capability errors (400).
 */
export function mcpHttpStatusOf(ctx: McpCallContext, result: JsonRpcResponse | JsonRpcResponse[] | null): number {
  if (result === null) return 202;
  if (ctx.era === 'modern' && !Array.isArray(result) && result.error) {
    if (result.error.code === JsonRpcErrorCode.METHOD_NOT_FOUND) return 404;
    // Header and capability errors are 400 on HTTP, wherever they are found.
    if (
      result.error.code === JsonRpcErrorCode.HEADER_MISMATCH ||
      result.error.code === JsonRpcErrorCode.MISSING_REQUIRED_CLIENT_CAPABILITY ||
      result.error.code === JsonRpcErrorCode.UNSUPPORTED_PROTOCOL_VERSION
    ) {
      return 400;
    }
  }
  return 200;
}

export interface McpRequestRecord {
  protocolVersion: string;
  era: string;
  method: string;
  clientName: string;
  clientVersion: string | null;
  trace?: McpTraceContext;
  outcome?: 'ok' | 'error' | 'tool_error' | 'refused' | 'notification';
}

function methodOf(body: unknown): string {
  if (Array.isArray(body)) return 'batch';
  const method = body && typeof body === 'object' ? (body as any).method : undefined;
  return typeof method === 'string' ? method.slice(0, 64) : 'invalid';
}

/**
 * Put the protocol version and client of this request on the request log
 * row and the usage metric (design doc, "Request log": from day one), and
 * its trace context on the request scope so audit rows written while it runs
 * carry it (decision 10). A modern request names its client in `_meta`; a
 * legacy one only on `initialize`, so every later legacy request is logged
 * as `unknown` and the request log row keeps the User-Agent next to it.
 */
export function recordMcpRequest(req: unknown, ctx: McpCallContext | null, body: unknown, outcome?: McpRequestRecord['outcome']): void {
  const clientInfo =
    ctx?.clientInfo ??
    (body && typeof body === 'object' && !Array.isArray(body) && (body as any).method === 'initialize'
      ? (body as any).params?.clientInfo
      : undefined);
  const record: McpRequestRecord = {
    protocolVersion: ctx?.version ?? 'refused',
    era: ctx?.era ?? 'refused',
    method: methodOf(body),
    clientName: typeof clientInfo?.name === 'string' ? clientInfo.name.slice(0, 128) : 'unknown',
    clientVersion: typeof clientInfo?.version === 'string' ? clientInfo.version.slice(0, 64) : null,
    ...(ctx?.trace ? { trace: ctx.trace } : {}),
    ...(outcome ? { outcome } : {}),
  };
  setProtocolContext(req, { mcp: record });
  if (ctx?.trace) updateRequestContext({ trace: ctx.trace });
}

/** How a JSON-RPC answer went, for the request log. */
export function mcpOutcomeOf(result: JsonRpcResponse | JsonRpcResponse[] | null): McpRequestRecord['outcome'] {
  if (result === null) return 'notification';
  const all = Array.isArray(result) ? result : [result];
  if (all.some((r) => r.error)) return 'error';
  if (all.some((r) => r.result?.isError === true)) return 'tool_error';
  return 'ok';
}
