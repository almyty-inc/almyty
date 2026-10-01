/**
 * Output-side normalisation of tool schemas to the JSON Schema 2020-12
 * dialect (MCP 2025-11-25, changelog Minor 10: schemas without `$schema`
 * are 2020-12).
 *
 * Schemas reach a tool from many places: the OpenAPI 3.0 parser (draft-04/05
 * idioms such as `nullable` and boolean `exclusiveMinimum`), Swagger 2,
 * GraphQL and SOAP generators, a person typing JSON into the tool page, and
 * remote MCP servers. A strict 2020-12 validator on the client side rejects
 * the 3.0 idioms or silently reads them differently, so the server rewrites
 * them on the way out. The stored schema is never changed: this runs on
 * output only (design doc, Risks: "ship the rewrite on output only").
 *
 * What changes:
 *  - `nullable: true` becomes `null` in `type` (or in `enum`);
 *  - boolean `exclusiveMinimum` / `exclusiveMaximum` become the numeric form;
 *  - `definitions` becomes `$defs`, and refs into it follow;
 *  - a `$ref` that does not resolve inside the schema (an OpenAPI
 *    `#/components/...` leftover, an external URL) is dropped, leaving an
 *    unconstrained subschema rather than one no client can resolve;
 *  - `$schema` is kept only when it already names 2020-12;
 *  - OpenAPI-only keywords (`discriminator`, `xml`, `externalDocs`) are
 *    dropped and `example` becomes `examples`;
 *  - Swagger 2's `type: file` becomes a string;
 *  - a boolean `required` on a property (draft-03, and how the OpenAPI
 *    parameter translator marks a required parameter) moves into the
 *    parent's `required` array;
 *  - the root of an input schema is always an object schema.
 *
 * Everything else, including keywords 2020-12 treats as annotations, is
 * kept as it was.
 */

export const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

const MAX_DEPTH = 64;

/** Keywords whose value is a map from names to subschemas. */
const SCHEMA_MAP_KEYWORDS = ['properties', 'patternProperties', '$defs', 'dependentSchemas'];
/** Keywords whose value is one subschema. */
const SCHEMA_KEYWORDS = [
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'items',
];
/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
/** OpenAPI keywords that mean nothing in JSON Schema. */
const OPENAPI_ONLY_KEYWORDS = ['discriminator', 'xml', 'externalDocs', 'nullable'];

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve a local JSON pointer (`#/a/b`) against the root. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: any = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (node === null || typeof node !== 'object' || !(key in node)) return undefined;
    node = node[key];
  }
  return node;
}

function rewriteRef(ref: string): string {
  return ref.startsWith('#/definitions/') ? `#/$defs/${ref.slice('#/definitions/'.length)}` : ref;
}

function normalizeNode(node: unknown, root: Record<string, any>, depth: number): unknown {
  if (typeof node === 'boolean') return node;
  if (!isPlainObject(node) || depth > MAX_DEPTH) return {};

  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(node)) {
    if (OPENAPI_ONLY_KEYWORDS.includes(key)) continue;
    if (key === 'definitions') continue; // re-added as $defs below
    if (key === '$schema') {
      if (value === JSON_SCHEMA_2020_12) out.$schema = value;
      continue;
    }
    if (key === 'example') {
      if (node.examples === undefined) out.examples = [value];
      continue;
    }
    if (key === '$ref') {
      if (typeof value !== 'string') continue;
      const ref = rewriteRef(value);
      // A ref that resolves against the original root (before the
      // definitions rename) stays; anything else is dropped.
      if (resolvePointer(root, value) !== undefined) out.$ref = ref;
      continue;
    }
    if (key === 'properties' && isPlainObject(value)) {
      // Draft-03 and OpenAPI-parameter style: `required: true` on the
      // property itself. 2020-12 only knows the parent's `required` array.
      const lifted = Object.entries(value)
        .filter(([, sub]) => isPlainObject(sub) && sub.required === true)
        .map(([name]) => name);
      if (lifted.length) {
        const own = Array.isArray(node.required) ? node.required : [];
        out.required = [...new Set([...own, ...lifted])];
      }
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, normalizeNode(sub, root, depth + 1)]),
      );
      continue;
    }
    if (key === 'required') {
      // Only the array form; a boolean belongs to the parent (lifted above).
      if (Array.isArray(value)) out.required = [...new Set([...(out.required ?? []), ...value])];
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.includes(key) && isPlainObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, sub]) => [name, normalizeNode(sub, root, depth + 1)]),
      );
      continue;
    }
    if (key === 'items' && Array.isArray(value)) {
      // Draft-04 tuple form: `items: [a, b]` is 2020-12 `prefixItems`, and
      // the old `additionalItems` becomes `items`.
      out.prefixItems = value.map((sub) => normalizeNode(sub, root, depth + 1));
      continue;
    }
    if (key === 'additionalItems') {
      if (Array.isArray(node.items)) out.items = normalizeNode(value, root, depth + 1);
      continue;
    }
    if (SCHEMA_KEYWORDS.includes(key)) {
      out[key] = normalizeNode(value, root, depth + 1);
      continue;
    }
    if (SCHEMA_ARRAY_KEYWORDS.includes(key) && Array.isArray(value)) {
      out[key] = value.map((sub) => normalizeNode(sub, root, depth + 1));
      continue;
    }
    out[key] = value;
  }

  if (isPlainObject(node.definitions)) {
    const defs = Object.fromEntries(
      Object.entries(node.definitions).map(([name, sub]) => [name, normalizeNode(sub, root, depth + 1)]),
    );
    out.$defs = { ...defs, ...(out.$defs ?? {}) };
  }

  if (out.type === 'file') out.type = 'string';

  // Draft-04: `exclusiveMinimum: true` qualifies `minimum`.
  for (const [exclusive, bound] of [
    ['exclusiveMinimum', 'minimum'],
    ['exclusiveMaximum', 'maximum'],
  ] as const) {
    if (typeof out[exclusive] === 'boolean') {
      if (out[exclusive] && typeof out[bound] === 'number') {
        out[exclusive] = out[bound];
        delete out[bound];
      } else {
        delete out[exclusive];
      }
    }
  }

  if (node.nullable === true) {
    if (typeof out.type === 'string') {
      out.type = out.type === 'null' ? 'null' : [out.type, 'null'];
    } else if (Array.isArray(out.type) && !out.type.includes('null')) {
      out.type = [...out.type, 'null'];
    }
    if (Array.isArray(out.enum) && !out.enum.includes(null)) {
      out.enum = [...out.enum, null];
    }
  }

  return out;
}

/** Normalise any schema (a subschema, an output schema) to 2020-12. */
export function normalizeJsonSchema(schema: unknown): Record<string, any> | boolean {
  if (typeof schema === 'boolean') return schema;
  if (!isPlainObject(schema)) return {};
  return normalizeNode(schema, schema, 0) as Record<string, any>;
}

/**
 * Normalise a tool's input schema. MCP requires an object schema at the
 * root; a schema with no `type` is given one, and anything that is not an
 * object schema at all is replaced by an empty one.
 */
export function normalizeInputSchema(schema: unknown): Record<string, any> {
  if (!isPlainObject(schema)) return { type: 'object', properties: {} };
  const normalized = normalizeJsonSchema(schema);
  if (!isPlainObject(normalized)) return { type: 'object', properties: {} };
  if (normalized.type === undefined) return { type: 'object', ...normalized };
  if (normalized.type !== 'object') return { type: 'object', properties: {} };
  return normalized;
}

/**
 * Normalise a tool's output schema, or return null when it cannot be one.
 * MCP (2025-06-18 and 2025-11-25) requires `outputSchema` to describe an
 * object, because `structuredContent` is an object.
 */
export function normalizeOutputSchema(schema: unknown): Record<string, any> | null {
  const normalized = normalizeJsonSchema(schema);
  if (!isPlainObject(normalized) || normalized.type !== 'object') return null;
  return normalized;
}
