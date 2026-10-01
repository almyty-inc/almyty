/**
 * `Mcp-Param-{Name}` headers (MCP 2026-07-28, "Custom Headers from Tool
 * Parameters"): a tool parameter whose schema carries `x-mcp-header` is
 * mirrored by the client into an HTTP header, and a server that processes the
 * body MUST check the two agree (-32020 HeaderMismatch, HTTP 400).
 *
 * almyty does not add `x-mcp-header` to the tools it generates (design doc,
 * decision 15), but a tool's author may write one into its input schema, and
 * then the header is validated as the spec requires.
 */
import { decodeMcpHeaderValue } from './mcp-http-binding';

export interface McpHeaderParam {
  /** The property path from the schema root, `properties` keys only. */
  path: string[];
  /** The `{Name}` of `Mcp-Param-{Name}`. */
  name: string;
  type: string | undefined;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * The parameters a schema mirrors into headers: those reachable from the root
 * through `properties` alone (the spec's "statically reachable"), with a
 * valid header token as their `x-mcp-header`.
 */
export function mcpHeaderParams(schema: unknown, path: string[] = [], depth = 0): McpHeaderParam[] {
  if (!schema || typeof schema !== 'object' || depth > 16) return [];
  const properties = (schema as any).properties;
  if (!properties || typeof properties !== 'object') return [];
  const out: McpHeaderParam[] = [];
  for (const [key, sub] of Object.entries(properties as Record<string, any>)) {
    if (!sub || typeof sub !== 'object') continue;
    const name = sub['x-mcp-header'];
    if (typeof name === 'string' && TOKEN.test(name)) {
      out.push({ path: [...path, key], name, type: typeof sub.type === 'string' ? sub.type : undefined });
    }
    out.push(...mcpHeaderParams(sub, [...path, key], depth + 1));
  }
  return out;
}

function valueAt(args: unknown, path: string[]): unknown {
  let node: any = args;
  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

function sameValue(headerValue: string, bodyValue: unknown, type: string | undefined): boolean {
  if (typeof bodyValue === 'boolean') return headerValue === String(bodyValue);
  if (typeof bodyValue === 'number' || type === 'integer' || type === 'number') {
    // Compared numerically: `42.0` and `42` are the same value.
    return headerValue.trim() !== '' && Number(headerValue) === Number(bodyValue);
  }
  return headerValue === bodyValue;
}

/**
 * Why the `Mcp-Param-*` headers of a tools/call disagree with its arguments,
 * or null when they agree. `headers` maps lower-cased header names to values.
 */
export function mcpParamHeaderMismatch(
  schema: unknown,
  args: unknown,
  headers: Record<string, string>,
): string | null {
  for (const param of mcpHeaderParams(schema)) {
    const headerName = `mcp-param-${param.name.toLowerCase()}`;
    const raw = headers[headerName];
    const decoded = raw === undefined ? undefined : decodeMcpHeaderValue(raw.trim());
    if (decoded === null) return `Mcp-Param-${param.name} header value contains invalid characters`;
    const bodyValue = valueAt(args, param.path);
    if (bodyValue === undefined || bodyValue === null) continue;
    if (decoded === undefined) return `Mcp-Param-${param.name} header is required when '${param.path.join('.')}' is set`;
    if (!sameValue(decoded, bodyValue, param.type)) {
      return `Mcp-Param-${param.name} header value does not match body value '${String(bodyValue).slice(0, 64)}'`;
    }
  }
  return null;
}
