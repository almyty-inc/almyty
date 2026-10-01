/**
 * The MCP protocol core: one JSON-RPC dispatcher for every MCP surface.
 *
 * docs/design/mcp-2026-07-28.md, "Architecture: one protocol core". There
 * used to be a dispatcher per surface (McpService for tenant gateways and
 * the gateway-less org endpoint, AlmytyMcpService for the management
 * gateway), each with its own idea of batching, notifications, version
 * negotiation and error codes. Now a surface only answers "list tools",
 * "call a tool", and so on, and never sees a protocol version; this module
 * owns the envelope, the method table, version negotiation and the
 * per-version shaping of results (versions.ts).
 *
 * HTTP concerns (Origin, the MCP-Protocol-Version header, status codes)
 * are the binding's (mcp-http-binding.ts). This module is transport-free
 * so the legacy SSE transport and the in-process callers share it.
 */
import { JsonRpcErrorCode, JsonRpcResponse, McpCapabilities } from '../types/mcp.types';
import { normalizeInputSchema, normalizeOutputSchema } from './json-schema-2020';
import { mcpProtocolSettings } from './mcp-settings';
import {
  ProtocolVersion,
  VERSION_WITHOUT_HEADER,
  featuresOf,
  negotiateVersion,
} from './versions';

/**
 * How the version of one request was decided:
 *  - `legacy`: an `initialize`, or a request carrying the
 *    `MCP-Protocol-Version` header (2025-06-18 and later clients);
 *  - `assumed`: no header, so 2025-03-26 per the spec.
 * (`modern`, the 2026-07-28 per-request `_meta`, arrives with P1.)
 */
export type McpEra = 'legacy' | 'assumed';

export interface McpCallContext {
  version: ProtocolVersion;
  era: McpEra;
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
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
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
  callTool(params: any): Promise<McpToolResult>;
  listResources?(params: any): Promise<any>;
  readResource?(params: any): Promise<any>;
  listResourceTemplates?(params: any): Promise<any>;
  listPrompts?(params: any): Promise<any>;
  getPrompt?(params: any): Promise<any>;
  complete?(params: any): Promise<any>;
  /** Methods outside the spec this surface keeps for its own clients (owner decision 16). */
  extraMethods?: Record<string, (params: any) => Promise<any>>;
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
    const normalized = features.structuredContent ? normalizeOutputSchema(out.outputSchema) : null;
    if (normalized) out.outputSchema = normalized;
    else delete out.outputSchema;
  }
  if (!features.toolTitle) delete out.title;
  if (!features.icons) delete out.icons;
  if (!features.toolAnnotations) delete out.annotations;
  return out;
}

/** Shape a tools/call result for a version. */
export function shapeToolResultForVersion(result: McpToolResult, version: ProtocolVersion): McpToolResult {
  const features = featuresOf(version);
  const out: McpToolResult = { ...result, content: Array.isArray(result.content) ? result.content : [] };
  if (!features.structuredContent) delete out.structuredContent;
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

async function dispatch(method: string, params: any, surface: McpSurface, ctx: McpCallContext): Promise<any> {
  switch (method) {
    case 'initialize': {
      if (!params || typeof params.protocolVersion !== 'string') {
        throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'initialize requires params.protocolVersion');
      }
      const negotiated = negotiateVersion(params.protocolVersion, mcpProtocolSettings().supportedVersions);
      await surface.onInitialize?.(params, negotiated);
      const instructions = surface.instructions?.();
      const info = await surface.serverInfo();
      const serverInfo: McpServerInfo = { name: info.name, version: info.version };
      if (info.title && featuresOf(negotiated).toolTitle) serverInfo.title = info.title;
      return {
        protocolVersion: negotiated,
        capabilities: surface.capabilities(),
        serverInfo,
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
      return shapeToolResultForVersion(await surface.callTool(params), ctx.version);
    }
    case 'resources/list':
      return surface.listResources ? surface.listResources(params) : { resources: [] };
    case 'resources/read':
      if (!surface.readResource) throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Resource not found');
      return surface.readResource(params);
    case 'resources/templates/list':
      return surface.listResourceTemplates ? surface.listResourceTemplates(params) : { resourceTemplates: [] };
    case 'resources/subscribe':
    case 'resources/unsubscribe':
      // No resource ever changes under a subscription here, so there is
      // nothing to deliver; acknowledging is the honest answer.
      return {};
    case 'prompts/list':
      return surface.listPrompts ? surface.listPrompts(params) : { prompts: [] };
    case 'prompts/get':
      if (!surface.getPrompt) throw mcpError(JsonRpcErrorCode.INVALID_PARAMS, 'Prompt not found');
      return surface.getPrompt(params);
    case 'completion/complete':
      return surface.complete ? surface.complete(params) : { completion: { values: [] } };
    case 'logging/setLevel':
      return {};
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

  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw mcpError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid request body');
    }
    if (body.jsonrpc !== '2.0') throw mcpError(JsonRpcErrorCode.INVALID_REQUEST, 'Invalid JSON-RPC version');
    if (!body.method || typeof body.method !== 'string') {
      throw mcpError(JsonRpcErrorCode.INVALID_REQUEST, 'Missing or invalid method');
    }
    if (isNotification && IGNORED_NOTIFICATIONS.has(body.method)) return null;

    const result = await dispatch(body.method, body.params, surface, ctx);
    if (isNotification) return null;
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
