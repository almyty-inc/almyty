/**
 * The MCP protocol core: one JSON-RPC dispatcher for every MCP surface.
 *
 * docs/design/mcp-2026-07-28.md, "Architecture: one protocol core". A
 * surface only answers "list tools", "call a tool", and so on, and never
 * sees a protocol version; this module owns the envelope, the method table,
 * version negotiation and the per-version shaping of results (versions.ts).
 *
 * Two eras are served side by side, chosen per request by the HTTP binding
 * (mcp-http-binding.ts):
 *  - legacy (2024-11-05 .. 2025-11-25): `initialize` negotiates, later
 *    requests name their version in a header;
 *  - modern (2026-07-28): every request carries its version, capabilities
 *    and client in `_meta`; results carry `resultType` and the server's
 *    identity; there is no handshake, no ping, no logging/setLevel, and
 *    `server/discover` says what the server speaks.
 *
 * HTTP concerns (Origin, headers, status codes, streams) are the binding's.
 * This module is transport-free so the legacy SSE transport and in-process
 * callers share it.
 */
import { JsonRpcErrorCode, JsonRpcResponse, McpCapabilities } from '../types/mcp.types';
import { normalizeInputSchema, normalizeJsonSchema, normalizeOutputSchema } from './json-schema-2020';
import { mcpProtocolSettings } from './mcp-settings';
import {
  ProtocolVersion,
  VERSION_WITHOUT_HEADER,
  featuresOf,
  negotiateVersion,
} from './versions';

/**
 * How the version of one request was decided:
 *  - `modern`: the request carried `_meta["io.modelcontextprotocol/protocolVersion"]`;
 *  - `legacy`: an `initialize`, or a request naming its version in the
 *    `MCP-Protocol-Version` header (2025-06-18 .. 2025-11-25 clients);
 *  - `assumed`: no header, so 2025-03-26 per the spec.
 */
export type McpEra = 'modern' | 'legacy' | 'assumed';

/** W3C trace context a modern request carried in `_meta`. */
export interface McpTraceContext {
  traceparent: string;
  tracestate?: string;
  baggage?: string;
}

export interface McpCallContext {
  version: ProtocolVersion;
  era: McpEra;
  /** Modern requests: what the client declared for this request. */
  clientCapabilities?: Record<string, unknown>;
  clientInfo?: { name?: string; version?: string };
  trace?: McpTraceContext;
  /** Modern tools/call: the request's Mcp-Param-* headers, lower-cased names to raw values. */
  paramHeaders?: Record<string, string>;
}

/** What a caller that knows nothing about the transport gets: the spec's no-header default. */
export const DEFAULT_CALL_CONTEXT: McpCallContext = { version: VERSION_WITHOUT_HEADER, era: 'assumed' };

export interface McpServerInfo {
  name: string;
  version: string;
  title?: string;
}

export interface McpToolResult {
  content: any[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

/** The Tasks extension's identifier (modelcontextprotocol/ext-tasks, 2026-07-28). */
export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/**
 * A tools/call answer other than a finished result (2026-07-28): a task
 * handle (Tasks extension, `resultType: "task"`) or a request for input
 * (multi round-trip requests, `resultType: "input_required"`). The core
 * passes it through unshaped, and only to a modern request that may get it:
 * a task only when the request declared the extension, an input request only
 * of a kind the client declared.
 */
export interface McpPolymorphicResult {
  resultType: 'task' | 'input_required';
  [key: string]: unknown;
}

/** The Tasks extension's methods, for a surface that serves tasks. */
export interface McpTaskHandlers {
  get(params: { taskId: string }, ctx: McpCallContext): Promise<Record<string, unknown>>;
  update(params: { taskId: string; inputResponses?: unknown }, ctx: McpCallContext): Promise<Record<string, unknown>>;
  cancel(params: { taskId: string }, ctx: McpCallContext): Promise<Record<string, unknown>>;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whether this modern request declared the Tasks extension. */
export function declaresTasks(ctx?: McpCallContext): boolean {
  if (!ctx || ctx.era !== 'modern') return false;
  const extensions = ctx.clientCapabilities?.extensions;
  return plainObject(extensions) && plainObject(extensions[TASKS_EXTENSION]);
}

/**
 * Whether this modern request declared form elicitation: `elicitation: {}`
 * means form (the spec's "form only, implicit"), and an explicit `form` key
 * says so too. URL-only elicitation cannot carry our forms.
 */
export function declaresElicitation(ctx?: McpCallContext): boolean {
  if (!ctx || ctx.era !== 'modern') return false;
  const elicitation = ctx.clientCapabilities?.elicitation;
  if (!plainObject(elicitation)) return false;
  const keys = Object.keys(elicitation);
  return keys.length === 0 || plainObject(elicitation.form);
}

/** The -32021 a request gets for a method or answer it did not declare support for. */
export function missingCapability(required: Record<string, unknown>, message = 'Missing required client capability'): McpProtocolError {
  return mcpError(JsonRpcErrorCode.MISSING_REQUIRED_CLIENT_CAPABILITY, message, { requiredCapabilities: required });
}

/**
 * One MCP server as the core sees it. Only `listTools` and `callTool` are
 * required; every other method has the answer an empty server gives.
 * Errors are thrown as `{ code, message, data? }`.
 */
export interface McpSurface {
  serverInfo(): McpServerInfo | Promise<McpServerInfo>;
  capabilities(): McpCapabilities;
  instructions?(): string | undefined;
  listTools(params: any): Promise<{ tools: any[]; nextCursor?: string }>;
  callTool(params: any, ctx?: McpCallContext): Promise<McpToolResult | McpPolymorphicResult>;
  listResources?(params: any): Promise<any>;
  readResource?(params: any): Promise<any>;
  listResourceTemplates?(params: any): Promise<any>;
  listPrompts?(params: any): Promise<any>;
  getPrompt?(params: any): Promise<any>;
  complete?(params: any): Promise<any>;
  /** Methods outside the spec this surface keeps for its legacy clients (owner decision 16). */
  extraMethods?: Record<string, (params: any) => Promise<any>>;
  /** Serves the Tasks extension (tasks/get, tasks/update, tasks/cancel) and advertises it. */
  tasks?: McpTaskHandlers;
  /**
   * The channel a change to this surface's tool set is published on, or
   * null when its tool set never changes (management) or has no channel.
   * A surface with one advertises `tools.listChanged` to modern clients and
   * serves `toolsListChanged` on `subscriptions/listen`.
   */
  toolsChangedChannel?(): string | null;
  /** Called once per successful `initialize`, with its params. */
  onInitialize?(params: any, negotiated: ProtocolVersion): void | Promise<void>;
  /** Called after every answered request (not notifications), with whether it succeeded. */
  onOutcome?(success: boolean): void | Promise<void>;
}

export interface McpProtocolError {
  code: number;
  message: string;
  data?: unknown;
}

export function mcpError(code: number, message: string, data?: unknown): McpProtocolError {
  const error: McpProtocolError = { code, message };
  if (data !== undefined) error.data = data;
  return error;
}

function isProtocolError(value: unknown): value is McpProtocolError {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as any).code === 'number' &&
    typeof (value as any).message === 'string'
  );
}

/** Client-to-server notifications the core accepts and does nothing with. */
const IGNORED_NOTIFICATIONS = new Set([
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'notifications/roots/list_changed',
]);

/** The methods a modern (2026-07-28) request may name. Anything else is -32601 (HTTP 404). */
export const MODERN_METHODS: ReadonlySet<string> = new Set([
  'server/discover',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'prompts/list',
  'prompts/get',
  'completion/complete',
  'subscriptions/listen',
  // Tasks extension: answered only for a surface that serves tasks, and
  // only to a request that declared the extension (else -32021).
  'tasks/get',
  'tasks/update',
  'tasks/cancel',
]);

/** Results that carry caching hints in 2026-07-28 ("Caching", Cacheable Results). */
const CACHEABLE_METHODS: ReadonlySet<string> = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/templates/list',
  'resources/read',
]);

export const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo';

/** The single error a refused batch is answered with. */
export function batchRefusal(version: ProtocolVersion): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: null as any,
    error: {
      code: JsonRpcErrorCode.INVALID_REQUEST,
      message: `Invalid Request: JSON-RPC batches are not supported in protocol version ${version}`,
    },
  };
}

export function isBatchAllowed(version: ProtocolVersion): boolean {
  return featuresOf(version).batch;
}

/** Shape one tools/list entry for a version: normalise schemas, drop fields it does not define. */
export function shapeToolForVersion(tool: any, version: ProtocolVersion): any {
  const features = featuresOf(version);
  const out: any = { ...tool, inputSchema: normalizeInputSchema(tool.inputSchema) };
  if (out.outputSchema !== undefined) {
    const normalized = !features.structuredContent
      ? null
      : features.structuredAnyJson
        ? normalizeJsonSchema(out.outputSchema)
        : normalizeOutputSchema(out.outputSchema);
    if (normalized && typeof normalized === 'object') out.outputSchema = normalized;
    else delete out.outputSchema;
  }
  if (!features.toolTitle) delete out.title;
  if (!features.icons) delete out.icons;
  if (!features.toolAnnotations) delete out.annotations;
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Shape a tools/call result for a version. */
export function shapeToolResultForVersion(result: McpToolResult, version: ProtocolVersion): McpToolResult {
  const features = featuresOf(version);
  const out: McpToolResult = { ...result, content: Array.isArray(result.content) ? result.content : [] };
  // structuredContent is an object up to 2025-11-25, any JSON value from
  // 2026-07-28 on, and absent before 2025-06-18.
  if (
    !features.structuredContent ||
    out.structuredContent === undefined ||
    (!features.structuredAnyJson && !isPlainObject(out.structuredContent))
  ) {
    delete out.structuredContent;
  }
  if (!features.resourceLinks) {
    // A resource link is a 2025-06-18 block. Older clients get the same
    // pointer as text rather than a block type they do not know.
    out.content = out.content.map((block: any) =>
      block?.type === 'resource_link'
        ? { type: 'text', text: `${block.name ?? 'Resource'}: ${block.uri}` }
        : block,
    );
  }
  if (out.isError === undefined) delete out.isError;
  return out;
}

/**
 * The capabilities a version is told about. Modern clients learn of tool
 * list changes through subscriptions/listen when the surface has a change
 * channel; logging is not advertised to them (2026-07-28 Deprecated 1: no
 * logging/setLevel). Legacy clients keep `listChanged: false`: telling them
 * needs a server stream, which needs sessions (owner decision 13). A surface
 * that serves tasks says so in `extensions` (modern only).
 */
export function capabilitiesForVersion(surface: McpSurface, version: ProtocolVersion): McpCapabilities {
  const base = surface.capabilities();
  if (!featuresOf(version).modern) return base;
  const out: McpCapabilities = { ...base };
  delete out.logging;
  if (out.tools) out.tools = { ...out.tools, listChanged: !!surface.toolsChangedChannel?.() };
  if (surface.tasks) out.extensions = { ...(out.extensions ?? {}), [TASKS_EXTENSION]: {} };
  return out;
}

function isPolymorphic(result: unknown): result is McpPolymorphicResult {
  return plainObject(result) && (result.resultType === 'task' || result.resultType === 'input_required');
}

/**
 * An input request a client did not declare support for must never be sent
 * (MRTR, server requirement 6). A surface checks before it asks; this is the
 * backstop, so a bug is an internal error rather than a protocol violation.
 */
function assertDeclaredInputRequests(inputRequests: unknown, ctx: McpCallContext): void {
  if (!plainObject(inputRequests)) return;
  for (const request of Object.values(inputRequests)) {
    const method = plainObject(request) ? request.method : undefined;
    if (method === 'elicitation/create' && declaresElicitation(ctx)) continue;
    throw mcpError(JsonRpcErrorCode.INTERNAL_ERROR, `An input request (${String(method)}) the client did not declare`);
  }
}

/** A task or input request, passed through only to a request that may get it. */
function checkedPolymorphic(result: McpPolymorphicResult, ctx: McpCallContext): McpPolymorphicResult {
  if (ctx.era !== 'modern') {
    throw mcpError(JsonRpcErrorCode.INTERNAL_ERROR, `A ${result.resultType} result for a ${ctx.version} request`);
  }
  if (result.resultType === 'task' && !declaresTasks(ctx)) {
    throw mcpError(JsonRpcErrorCode.INTERNAL_ERROR, 'A task for a request that did not declare the Tasks extension');
  }
  if (result.resultType === 'input_required') {
    if (!plainObject(result.inputRequests) && typeof result.requestState !== 'string') {
      throw mcpError(JsonRpcErrorCode.INTERNAL_ERROR, 'An input_required result with neither inputRequests nor requestState');
    }
    assertDeclaredInputRequests(result.inputRequests, ctx);
  }
  return result;
}

async function serverInfoFor(surface: McpSurface, version: ProtocolVersion): Promise<McpServerInfo> {
  const info = await surface.serverInfo();
  const out: McpServerInfo = { name: info.name, version: info.version };
  if (info.title && featuresOf(version).toolTitle) out.title = info.title;
  return out;
}

async function dispatch(method: string, params: any, surface: McpSurface, ctx: McpCallContext): Promise<any> {
  const modern = featuresOf(ctx.version).modern;
  if (modern && !MODERN_METHODS.has(method)) {
    throw mcpError(JsonRpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
  switch (method) {
    case 'initialize': {
      if (!params || typeof params.protocolVersion !== 'string') {
        throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'initialize requires params.protocolVersion');
      }
      const negotiated = negotiateVersion(params.protocolVersion, mcpProtocolSettings().supportedVersions);
      await surface.onInitialize?.(params, negotiated);
      const instructions = surface.instructions?.();
      return {
        protocolVersion: negotiated,
        capabilities: capabilitiesForVersion(surface, negotiated),
        serverInfo: await serverInfoFor(surface, negotiated),
        ...(instructions ? { instructions } : {}),
      };
    }
    case 'server/discover': {
      const instructions = surface.instructions?.();
      return {
        supportedVersions: mcpProtocolSettings().supportedVersions,
        capabilities: capabilitiesForVersion(surface, ctx.version),
        ...(instructions ? { instructions } : {}),
      };
    }
    case 'ping':
      return {};
    case 'tools/list': {
      const listed = await surface.listTools(params);
      return { ...listed, tools: (listed.tools ?? []).map((t) => shapeToolForVersion(t, ctx.version)) };
    }
    case 'tools/call': {
      if (!params || typeof params.name !== 'string' || !params.name) {
        throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Tool name is required');
      }
      const result = await surface.callTool(params, ctx);
      if (isPolymorphic(result)) return checkedPolymorphic(result, ctx);
      return shapeToolResultForVersion(result as McpToolResult, ctx.version);
    }
    case 'tasks/get':
    case 'tasks/update':
    case 'tasks/cancel': {
      // Only a modern request reaches here (the legacy era never had these
      // methods in this form); a surface without tasks does not know them.
      if (!modern || !surface.tasks) throw mcpError(JsonRpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
      if (!declaresTasks(ctx)) throw missingCapability({ extensions: { [TASKS_EXTENSION]: {} } });
      if (!params || typeof params.taskId !== 'string' || !params.taskId) {
        throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'taskId is required');
      }
      if (method === 'tasks/get') {
        const task = await surface.tasks.get(params, ctx);
        // A finished task carries the CallToolResult the call would have
        // returned, shaped like any other and marked `resultType: "complete"`
        // as a 2026-07-28 tools/call result is (the ext-tasks client
        // refuses one without it).
        if (task.status === 'completed' && plainObject(task.result)) {
          const result = shapeToolResultForVersion(task.result as unknown as McpToolResult, ctx.version);
          return { ...task, result: { ...result, resultType: 'complete' } };
        }
        if (task.status === 'input_required') assertDeclaredInputRequests(task.inputRequests, ctx);
        return task;
      }
      if (method === 'tasks/update') {
        if (!plainObject(params.inputResponses)) {
          throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'inputResponses must be an object');
        }
        return surface.tasks.update(params, ctx);
      }
      return surface.tasks.cancel(params, ctx);
    }
    case 'resources/list':
      return surface.listResources ? surface.listResources(params) : { resources: [] };
    case 'resources/read':
      if (!surface.readResource) {
        throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Resource not found', { uri: params?.uri });
      }
      return surface.readResource(params);
    case 'resources/templates/list':
      return surface.listResourceTemplates ? surface.listResourceTemplates(params) : { resourceTemplates: [] };
    case 'resources/subscribe':
    case 'resources/unsubscribe':
      // Legacy only. No resource ever changes under a subscription here, so
      // there is nothing to deliver; acknowledging is the honest answer.
      return {};
    case 'prompts/list':
      return surface.listPrompts ? surface.listPrompts(params) : { prompts: [] };
    case 'prompts/get':
      if (!surface.getPrompt) throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Prompt not found', { name: params?.name });
      return surface.getPrompt(params);
    case 'completion/complete':
      return surface.complete ? surface.complete(params) : { completion: { values: [] } };
    case 'logging/setLevel':
      return {};
    case 'subscriptions/listen':
      // A stream, not a result: the HTTP binding serves it before the core
      // is reached. Arriving here means a transport that cannot stream.
      throw mcpError(JsonRpcErrorCode.METHOD_NOT_FOUND, 'subscriptions/listen needs a streaming transport');
    default: {
      const extra = surface.extraMethods?.[method];
      if (extra) return extra(params);
      // A client that wrongly sends one of these with an id still gets a
      // well-formed answer rather than a hang.
      if (IGNORED_NOTIFICATIONS.has(method)) return {};
      throw mcpError(JsonRpcErrorCode.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }
}

/**
 * Modern results: `resultType`, the server's identity in `_meta`, and on
 * cacheable results `ttlMs` (MCP_RESULT_TTL_MS) and `cacheScope`. The scope
 * is always "private": every listing here depends on who asks (team and
 * private tools, gateway auth), so no cache may share one across callers.
 */
async function decorateModernResult(
  method: string,
  result: any,
  surface: McpSurface,
  ctx: McpCallContext,
): Promise<any> {
  const out: any = isPlainObject(result) ? { ...result } : {};
  out.resultType = out.resultType ?? 'complete';
  out._meta = {
    ...(isPlainObject(out._meta) ? out._meta : {}),
    [SERVER_INFO_META]: await serverInfoFor(surface, ctx.version),
  };
  if (CACHEABLE_METHODS.has(method) && out.resultType === 'complete') {
    out.ttlMs = mcpProtocolSettings().resultTtlMs;
    out.cacheScope = 'private';
  }
  return out;
}

/** One JSON-RPC message. Returns null when nothing may be sent back (a notification). */
export async function handleSingleMessage(
  body: any,
  surface: McpSurface,
  ctx: McpCallContext = DEFAULT_CALL_CONTEXT,
): Promise<JsonRpcResponse | null> {
  // JSON-RPC 2.0 section 4.1: any message without an `id` is a notification
  // and MUST NOT be answered, not even with an error.
  const isNotification = !!body && typeof body === 'object' && !Array.isArray(body) && body.id === undefined;
  const id = body && typeof body === 'object' && !Array.isArray(body) ? (body.id ?? null) : null;
  const modern = featuresOf(ctx.version).modern;

  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw mcpError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid request body');
    }
    if (body.jsonrpc !== '2.0') throw mcpError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC version');
    if (!body.method || typeof body.method !== 'string') {
      throw mcpError(JsonRpcErrorCode.INVALID_REQUEST, 'Missing or invalid method');
    }
    // Modern clients send no notifications over HTTP; any that arrive are
    // accepted and dropped like the legacy ones.
    if (isNotification && (modern || IGNORED_NOTIFICATIONS.has(body.method))) return null;

    let result = await dispatch(body.method, body.params, surface, ctx);
    if (isNotification) return null;
    if (modern) result = await decorateModernResult(body.method, result, surface, ctx);
    await surface.onOutcome?.(true);
    return { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (isNotification) return null;
    await surface.onOutcome?.(false);
    if (isProtocolError(error)) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: error.code,
          message: error.message,
          ...(error.data !== undefined ? { data: error.data } : {}),
        },
      };
    }
    return {
      jsonrpc: '2.0',
      id,
      error: { code: JsonRpcErrorCode.INTERNAL_ERROR, message: 'Internal server error' },
    };
  }
}

/**
 * A POSTed MCP message: one JSON-RPC message, or (2025-03-26 and older
 * only) an array batching several. Returns null when nothing is to be
 * sent back; the HTTP binding turns that into 202 Accepted.
 */
export async function handleMessage(
  message: any,
  surface: McpSurface,
  ctx: McpCallContext = DEFAULT_CALL_CONTEXT,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (!Array.isArray(message)) return handleSingleMessage(message, surface, ctx);

  // 2025-06-18 removed batching (changelog Major 1).
  if (!isBatchAllowed(ctx.version)) return batchRefusal(ctx.version);

  // JSON-RPC 2.0 section 6: an empty array is an Invalid Request, answered
  // with a single (non-array) error.
  if (message.length === 0) {
    return {
      jsonrpc: '2.0',
      id: null as any,
      error: { code: JsonRpcErrorCode.INVALID_REQUEST, message: 'Invalid Request: empty batch' },
    };
  }

  const responses: JsonRpcResponse[] = [];
  for (const member of message) {
    const response = await handleSingleMessage(member, surface, ctx);
    if (response !== null) responses.push(response);
  }
  return responses.length > 0 ? responses : null;
}
