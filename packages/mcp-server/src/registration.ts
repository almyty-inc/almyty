/**
 * A gateway tool as this server registers it in full mode: everything the
 * gateway says about the tool, not only its parameters.
 *
 * The 1.x SDK wanted a Zod shape, so the JSON Schema a gateway returns was
 * rebuilt as one (top-level properties only), and the tool's title, output
 * schema and annotations were dropped on the way. The 2.x SDK takes the JSON
 * Schema itself (`fromJsonSchema`), so the registration now carries:
 *
 *  - `inputSchema`: the gateway's schema, unchanged (nested objects, enums,
 *    formats and `x-mcp-header` included);
 *  - `outputSchema`: when the gateway declares an object-shaped one, so a
 *    client gets the structured result it promises;
 *  - `title`, `annotations` (read-only, destructive, idempotent, open-world
 *    hints) and `icons`, as the gateway lists them.
 *
 * A tool whose schema is not valid JSON Schema is not registered: it could
 * not be called correctly, and the SDK would refuse it anyway.
 */
import { fromJsonSchema } from '@modelcontextprotocol/server';
import type { McpToolDefinition, UpstreamToolResult } from './proxy.js';

type SchemaFactory = (schema: any) => unknown;

const HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** An object-typed JSON Schema, which is all MCP allows for a tool's input and output. */
function isObjectSchema(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  return value.type === undefined || value.type === 'object';
}

/** The tool annotations MCP defines, each kept only with the type it must have. */
export function cleanAnnotations(value: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const hint of HINTS) {
    if (typeof value[hint] === 'boolean') out[hint] = value[hint];
  }
  if (typeof value.title === 'string' && value.title) out.title = value.title;
  return Object.keys(out).length ? out : undefined;
}

/** Icons with an https (or data:) source; anything else is left out. */
export function cleanIcons(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const icons = value.filter(
    (icon): icon is Record<string, unknown> =>
      isPlainObject(icon) && typeof icon.src === 'string' && /^(https:|data:)/.test(icon.src),
  );
  return icons.length ? icons : undefined;
}

export interface GatewayToolConfig {
  title?: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  icons?: Array<Record<string, unknown>>;
}

/**
 * The registration config for one gateway tool. Throws when the gateway's
 * schema is not valid JSON Schema; the caller skips that tool and says why.
 */
export function gatewayToolConfig(tool: McpToolDefinition, fromJson: SchemaFactory = fromJsonSchema): GatewayToolConfig {
  const input = isObjectSchema(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} };
  const config: GatewayToolConfig = {
    description: tool.description || `Tool: ${tool.name}`,
    inputSchema: fromJson({ type: 'object', ...input }),
  };
  if (typeof tool.title === 'string' && tool.title) config.title = tool.title;
  if (isObjectSchema(tool.outputSchema)) config.outputSchema = fromJson({ type: 'object', ...tool.outputSchema });
  const annotations = cleanAnnotations(tool.annotations);
  if (annotations) config.annotations = annotations;
  const icons = cleanIcons(tool.icons);
  if (icons) config.icons = icons;
  return config;
}

/**
 * The result a full-mode tool hands back: the gateway's own, so structured
 * content reaches the client next to the text, as its output schema says.
 */
export function passThroughResult(result: UpstreamToolResult) {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError ? { isError: true as const } : {}),
  };
}
