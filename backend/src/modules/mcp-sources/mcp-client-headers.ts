/**
 * The request headers an MCP 2026-07-28 client sends over Streamable HTTP
 * ("Standard Request Headers", "Custom Headers from Tool Parameters"):
 * `Mcp-Method`, `Mcp-Name`, and an `Mcp-Param-{Name}` for every tool
 * parameter whose schema carries `x-mcp-header`.
 *
 * A client MUST mirror those parameters, and MUST reject (leave out of its
 * tools/list) a tool whose `x-mcp-header` annotations break the rules:
 * empty or not an HTTP token, not unique case-insensitively, on a parameter
 * that is not an integer, string or boolean, or on a property that is not
 * reachable from the schema root through `properties` keys alone.
 */

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SENTINEL = /^=\?base64\?.*\?=$/;
const PRIMITIVE = new Set(['integer', 'string', 'boolean']);

/**
 * A header value as the spec encodes it: plain visible ASCII as is;
 * anything else (non-ASCII, control characters, leading or trailing
 * whitespace, or something that looks like the sentinel) as
 * `=?base64?{base64 of UTF-8}?=`.
 */
export function encodeMcpHeaderValue(value: string): string {
  const plain = value === '' || (/^[\x21-\x7e](?:[\x20-\x7e\t]*[\x21-\x7e])?$/.test(value) && !SENTINEL.test(value));
  return plain ? value : `=?base64?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

interface HeaderParam {
  path: string[];
  name: string;
  type: string;
}

/**
 * The `x-mcp-header` parameters of an input schema, or why the tool
 * definition is invalid. Every annotation anywhere in the schema is looked
 * at, so one under `items`, `oneOf`, `$defs` or a `$ref` target is found
 * and refused rather than silently skipped.
 */
export function mcpHeaderAnnotations(inputSchema: unknown): { params: HeaderParam[] } | { invalid: string } {
  const params: HeaderParam[] = [];
  const problems: string[] = [];
  const walk = (node: unknown, path: string[] | null, depth: number): void => {
    if (depth > 32 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, null, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    if ('x-mcp-header' in record) {
      const name = record['x-mcp-header'];
      const where = path ? path.join('.') || '(root)' : 'a non-property position';
      if (!path || path.length === 0) problems.push(`x-mcp-header at ${where} is not on a statically reachable property`);
      else if (typeof name !== 'string' || !name || !TOKEN.test(name)) problems.push(`x-mcp-header at ${where} is not a valid header name`);
      else if (typeof record.type !== 'string' || !PRIMITIVE.has(record.type)) {
        problems.push(`x-mcp-header at ${where} is on a ${String(record.type ?? 'untyped')} parameter (only integer, string, boolean)`);
      } else params.push({ path, name, type: record.type });
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
          walk(sub, path ? [...path, prop] : null, depth + 1);
        }
      } else if (key !== 'x-mcp-header') {
        // Any other keyword (items, oneOf, $defs, if/then/else, ...) leaves
        // the statically reachable chain.
        walk(value, null, depth + 1);
      }
    }
  };
  walk(inputSchema, [], 0);
  const seen = new Set<string>();
  for (const param of params) {
    const lower = param.name.toLowerCase();
    if (seen.has(lower)) problems.push(`x-mcp-header '${param.name}' is used twice`);
    seen.add(lower);
  }
  return problems.length ? { invalid: problems[0] } : { params };
}

function valueAt(args: unknown, path: string[]): unknown {
  let node: any = args;
  for (const key of path) {
    if (!node || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
}

/**
 * The `Mcp-Param-*` headers a tools/call carries: the value at each
 * annotated property's path, converted (integer to decimal, boolean to
 * true/false) and encoded; no header when the argument is absent.
 */
export function mcpParamHeaders(inputSchema: unknown, args: unknown): Record<string, string> {
  const found = mcpHeaderAnnotations(inputSchema);
  if ('invalid' in found) return {};
  const headers: Record<string, string> = {};
  for (const param of found.params) {
    const value = valueAt(args, param.path);
    if (value === undefined || value === null) continue;
    let text: string;
    if (typeof value === 'boolean') text = value ? 'true' : 'false';
    else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) continue;
      text = String(value);
    } else if (typeof value === 'string') text = value;
    else continue;
    headers[`Mcp-Param-${param.name}`] = encodeMcpHeaderValue(text);
  }
  return headers;
}
