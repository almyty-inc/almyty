/**
 * A gateway tool arrives with a JSON Schema; the MCP SDK's `tool()` wants a
 * Zod raw shape, one Zod type per top-level property. Handing it the JSON
 * Schema object itself meant its values were a string and a nested object
 * rather than Zod types, so full mode registered tools whose parameters the
 * SDK could not describe.
 *
 * The Zod namespace is a parameter rather than an import so the mapping can
 * be checked on its own.
 */

export interface ZodLike {
  string(): any;
  number(): any;
  boolean(): any;
  array(inner: any): any;
  record(inner: any): any;
  unknown(): any;
  enum(values: [string, ...string[]]): any;
}

interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
}

/** One JSON Schema node to one Zod type. Anything unrecognised stays unknown. */
export function zodTypeFor(node: JsonSchemaNode | undefined, z: ZodLike): any {
  if (!node) return z.unknown();

  // A string enum is the one case worth narrowing: it is how a tool says
  // "one of these", and the model behaves better when told.
  if (Array.isArray(node.enum) && node.enum.length > 0 && node.enum.every((v) => typeof v === 'string')) {
    return z.enum(node.enum as [string, ...string[]]);
  }

  // A union type (["string","null"]) is taken by its first concrete member;
  // optionality is carried separately, by `required`.
  const type = Array.isArray(node.type) ? node.type.find((t) => t !== 'null') : node.type;

  switch (type) {
    case 'string': return z.string();
    case 'number': return z.number();
    case 'integer': return z.number();
    case 'boolean': return z.boolean();
    case 'array': return z.array(zodTypeFor(node.items, z));
    case 'object': return z.record(z.unknown());
    default: return z.unknown();
  }
}

/**
 * The top level of a tool's JSON Schema as a Zod raw shape. Properties not
 * listed in `required` are optional, and a schema with no properties is an
 * empty shape, which is how the SDK spells "this tool takes no arguments".
 */
export function buildZodShape(schema: unknown, z: ZodLike): Record<string, any> {
  const node = (schema ?? {}) as JsonSchemaNode;
  const properties = node.properties ?? {};
  const required = new Set(node.required ?? []);
  const shape: Record<string, any> = {};
  for (const [key, definition] of Object.entries(properties)) {
    let field = zodTypeFor(definition, z);
    if (definition?.description && typeof field?.describe === 'function') field = field.describe(definition.description);
    if (!required.has(key) && typeof field?.optional === 'function') field = field.optional();
    shape[key] = field;
  }
  return shape;
}
