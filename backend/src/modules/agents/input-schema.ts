/**
 * Checking a run's input against the schema the input node declares.
 *
 * The builder has had a JSON Schema editor on the input node since the
 * beginning, it saved to `node.data.schema`, and `executeInputNode`
 * passed `context.input` straight through without looking at it. So a
 * declared contract was decoration: a caller could send anything, the
 * run proceeded, and the failure surfaced several nodes later as a
 * template resolving to undefined or a model asked to reason about a
 * missing field.
 *
 * This validator covers what the builder can produce — `type`,
 * `properties`, `required`, `enum`, `items`, and nesting — and ignores
 * keywords it does not know rather than rejecting them, because the
 * editor also accepts pasted schemas and refusing a `pattern` nobody
 * asked us to enforce would be worse than not enforcing it. What it will
 * not do is claim a schema passed when it could not read it: an
 * unsupported keyword is skipped silently, an unreadable schema is
 * reported.
 */

/** A schema that says nothing to check — the input node's default. */
export function schemaConstrainsAnything(schema: any): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (Array.isArray(schema.required) && schema.required.length > 0) return true;
  if (schema.properties && Object.keys(schema.properties).length > 0) return true;
  if (schema.enum || schema.items) return true;
  // A bare `type` on its own is worth enforcing only when it is not the
  // `object` the editor defaults to; otherwise every agent reached from a
  // chat surface would start refusing its own input.
  return typeof schema.type === 'string' && schema.type !== 'object';
}

const JSON_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;

/** The JSON type name of a value, as a caller would recognise it. */
const typeOf = (value: unknown): string => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const matchesType = (value: unknown, type: string): boolean => {
  // `integer` is the one JSON Schema type with no JavaScript counterpart,
  // so it is a predicate rather than a name comparison — and 42 is
  // reported as a number, not an integer, because that is what the
  // caller sent.
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeOf(value) === type;
};

/**
 * Every way the value fails the schema, as sentences a caller can act
 * on. An empty array means it passed.
 */
export function schemaProblems(schema: any, value: unknown, path = 'input'): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const problems: string[] = [];

  const types: string[] = Array.isArray(schema.type)
    ? schema.type.filter((t: unknown) => typeof t === 'string')
    : typeof schema.type === 'string'
      ? [schema.type]
      : [];
  const known = types.filter((t) => (JSON_TYPES as readonly string[]).includes(t));
  if (known.length && !known.some((t) => matchesType(value, t))) {
    problems.push(`${path} must be ${known.join(' or ')}, and it is ${typeOf(value)}`);
    // Nothing below this can be checked against a value of the wrong
    // shape, and guessing would produce a second misleading complaint.
    return problems;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed: unknown) => allowed === value)) {
    problems.push(`${path} must be one of ${schema.enum.map((v: unknown) => JSON.stringify(v)).join(', ')}`);
  }

  if (typeOf(value) === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof key === 'string' && obj[key] === undefined) {
        problems.push(`${path}.${key} is required and was not given`);
      }
    }
    if (schema.properties && typeof schema.properties === 'object') {
      for (const [key, sub] of Object.entries(schema.properties as Record<string, any>)) {
        if (obj[key] === undefined) continue; // absence is `required`'s business
        problems.push(...schemaProblems(sub, obj[key], `${path}.${key}`));
      }
    }
  }

  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    value.forEach((item, i) => {
      problems.push(...schemaProblems(schema.items, item, `${path}[${i}]`));
    });
  }

  return problems;
}

export class InputSchemaViolation extends Error {
  readonly code = 'INPUT_SCHEMA_VIOLATION';
  constructor(readonly problems: string[]) {
    super(
      `The input does not match the schema this agent declares: ${problems.join('; ')}. ` +
        'Send input that matches, or change the schema on the input node.',
    );
    this.name = 'InputSchemaViolation';
  }
}
