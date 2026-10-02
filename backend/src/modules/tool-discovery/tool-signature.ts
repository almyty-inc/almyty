/**
 * How a tool is called from code (docs/design/code-mode.md, part C), and the
 * TypeScript signature get_tool shows for it.
 *
 * One namespace per source: the API's name (`petstore`), an MCP source's name,
 * or `custom` for a hand-made tool without an API. The function is the
 * operation id in camelCase (`findPetsByStatus`), else the tool's name with
 * its API prefix dropped. A name taken twice in one namespace gets a numeric
 * suffix (`getPet2`), in a stable order (tool name, then id), so the same
 * scope always gets the same names. Every identifier is a valid, non-reserved
 * JavaScript identifier (jsIdentifier): names come from imported API
 * documents and are untrusted text.
 *
 * Return types come from the tool's output schema; a tool without one returns
 * `unknown` (code mode's `extract()` is for those).
 */
import { jsDocText, jsIdentifier, jsStringLiteral, tsPropertyKey } from '../../common/security/untrusted-text';

export interface NameableTool {
  id: string;
  name: string;
  description?: string | null;
  parameters?: Record<string, any> | null;
  metadata?: Record<string, any> | null;
  configuration?: Record<string, any> | null;
  examples?: Array<{ input?: Record<string, any> }> | null;
  operation?: { operationId?: string | null; name?: string | null } | null;
  api?: { name?: string | null } | null;
}

export interface CodeName {
  namespace: string;
  fn: string;
}

function camel(text: string): string {
  const parts = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (!parts.length) return '';
  return parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
}

/**
 * Names a script's own globals take (code-sandbox-worker.ts); an API called
 * `tools` or `log` gets an `Api` suffix so it cannot shadow them.
 */
const CODE_GLOBALS = new Set(['tools', 'log', 'extract', 'console', 'ToolError', 'context']);

/** The namespace a tool lives under. */
export function namespaceOf(tool: NameableTool): string {
  const meta = tool.metadata ?? {};
  const source = tool.api?.name ?? meta.sourceApi?.name ?? meta.mcpSource?.name ?? null;
  if (!source) return 'custom';
  const name = jsIdentifier(camel(String(source)), 'custom');
  return CODE_GLOBALS.has(name) ? `${name}Api` : name;
}

/** The function name a tool has in its namespace, before collisions are resolved. */
export function functionNameOf(tool: NameableTool, namespace: string): string {
  const meta = tool.metadata ?? {};
  // The operation id (never its summary, which is prose), then a remote MCP tool's own name.
  const operation = tool.operation?.operationId ?? meta.sourceOperation?.operationId ?? tool.configuration?.mcp?.remoteName ?? null;
  let base = operation ? String(operation) : tool.name;
  if (!operation) {
    // `petstore_find_pets_by_status` under `petstore` is `findPetsByStatus`.
    const prefix = new RegExp(`^${namespace.replace(/[^A-Za-z0-9]/g, '')}[_\\-.]+`, 'i');
    base = base.replace(prefix, '');
  }
  return jsIdentifier(camel(base), 'call');
}

/**
 * The code names of every tool in a scope, keyed by tool id. Deterministic:
 * the same scope always yields the same names.
 */
export function codeNames(tools: NameableTool[]): Map<string, CodeName> {
  const ordered = [...tools].sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));
  const taken = new Map<string, Set<string>>();
  const names = new Map<string, CodeName>();
  for (const tool of ordered) {
    const namespace = namespaceOf(tool);
    const used = taken.get(namespace) ?? new Set<string>();
    taken.set(namespace, used);
    const base = functionNameOf(tool, namespace);
    let fn = base;
    for (let n = 2; used.has(fn) || fn === 'search' || fn === 'get' || fn === 'call'; n++) fn = `${base}${n}`;
    used.add(fn);
    names.set(tool.id, { namespace, fn });
  }
  return names;
}

/** A JSON Schema as a TypeScript type. Unknown shapes are `unknown`, never `any`. */
export function schemaToTs(schema: any, depth = 0): string {
  if (!schema || typeof schema !== 'object' || depth > 6) return 'unknown';
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.map(literal).join(' | ');
  for (const key of ['anyOf', 'oneOf'] as const) {
    if (Array.isArray(schema[key]) && schema[key].length) {
      return union(schema[key].map((s: any) => schemaToTs(s, depth + 1)));
    }
  }
  const types: string[] = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (!types.length) {
    if (schema.properties) return objectType(schema, depth);
    if (schema.items) return arrayType(schema, depth);
    return 'unknown';
  }
  const rendered = types.map((t) => {
    switch (t) {
      case 'string':
        return 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return arrayType(schema, depth);
      case 'object':
        return objectType(schema, depth);
      default:
        return 'unknown';
    }
  });
  const base = union(rendered);
  return schema.nullable === true && !rendered.includes('null') ? union([base, 'null']) : base;
}

function literal(value: unknown): string {
  if (typeof value === 'string') return jsStringLiteral(value, 256);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean' || value === null) return String(value);
  return 'unknown';
}

function union(types: string[]): string {
  const unique = [...new Set(types)];
  return unique.length === 1 ? unique[0] : unique.map((t) => (t.includes('=>') ? `(${t})` : t)).join(' | ');
}

function arrayType(schema: any, depth: number): string {
  const item = schema.items ? schemaToTs(schema.items, depth + 1) : 'unknown';
  return /[|&\s]/.test(item) && !item.startsWith('{') ? `Array<${item}>` : `${item}[]`;
}

function objectType(schema: any, depth: number): string {
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
  if (!properties || !Object.keys(properties).length) {
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      return `Record<string, ${schemaToTs(schema.additionalProperties, depth + 1)}>`;
    }
    return 'Record<string, unknown>';
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const fields = Object.entries(properties).map(([key, value]: [string, any]) => {
    const optional = required.includes(key) || value?.required === true ? '' : '?';
    return `${tsPropertyKey(key)}${optional}: ${schemaToTs(value, depth + 1)}`;
  });
  return `{ ${fields.join('; ')} }`;
}

/**
 * The signature a tool has in code: `petstore.getPetById(args: { petId: number }): Promise<Pet>`,
 * preceded by its description as a doc comment.
 */
export function toolSignature(tool: NameableTool, name: CodeName, outputSchema: Record<string, any> | null): string {
  const args = schemaToTs(tool.parameters ?? { type: 'object', properties: {} });
  const returns = outputSchema ? schemaToTs(outputSchema) : 'unknown';
  const doc = tool.description ? `/** ${jsDocText(tool.description, 400)} */\n` : '';
  return `${doc}${name.namespace}.${name.fn}(args: ${args}): Promise<${returns}>`;
}

function exampleValue(schema: any, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 5) return null;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (schema.default !== undefined) return schema.default;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type;
  switch (type) {
    case 'string':
      return schema.format === 'date-time' ? '2026-01-01T00:00:00Z' : schema.format === 'date' ? '2026-01-01' : 'text';
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'array':
      return [exampleValue(schema.items, depth + 1)];
    case 'object':
    default: {
      const out: Record<string, unknown> = {};
      const required: string[] = Array.isArray(schema.required) ? schema.required : [];
      for (const [key, value] of Object.entries(schema.properties ?? {})) {
        if (required.includes(key) || (value as any)?.required === true || depth === 0) out[key] = exampleValue(value, depth + 1);
      }
      return out;
    }
  }
}

/**
 * One example call: the tool's own first example, else one built from its
 * input schema (examples, defaults and enum members first, then a value of
 * the right type).
 */
export function exampleCall(tool: NameableTool, name: CodeName): { arguments: Record<string, unknown>; code: string; synthesized: boolean } {
  const own = Array.isArray(tool.examples) ? tool.examples.find((e) => e?.input && typeof e.input === 'object') : undefined;
  const args = (own?.input ?? exampleValue(tool.parameters ?? { type: 'object' })) as Record<string, unknown>;
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return {
    arguments: safeArgs,
    code: `await ${name.namespace}.${name.fn}(${JSON.stringify(safeArgs)})`,
    synthesized: !own,
  };
}
