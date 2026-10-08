/**
 * Does a tool result conform to the output schema the tool declared?
 *
 * 2025-06-18 tools, "Output Schema": a server that declares an
 * `outputSchema` MUST return `structuredContent` that conforms to it, and
 * clients SHOULD validate. The official SDK clients do, and refuse the
 * whole result on a mismatch, so the server checks first
 * (mcp-tool.handler.ts turns a mismatch into a tool error carrying the
 * data).
 *
 * A JSON Schema 2020-12 validator, lenient about formats and unknown
 * keywords: those are annotations in 2020-12 and a generated schema is full
 * of them. Compiled schemas are cached by their serialisation; the cache is
 * bounded so a stream of distinct schemas cannot grow it without limit.
 */
import Ajv2020, { ValidateFunction } from 'ajv/dist/2020';

const MAX_CACHED = 500;

let ajv: Ajv2020 | null = null;
const compiled = new Map<string, ValidateFunction | null>();

function validatorFor(schema: Record<string, any>): ValidateFunction | null {
  const key = JSON.stringify(schema);
  if (compiled.has(key)) return compiled.get(key) ?? null;
  ajv ??= new Ajv2020({ strict: false, allErrors: false, validateFormats: false, logger: false });
  let fn: ValidateFunction | null = null;
  try {
    fn = ajv.compile(schema);
  } catch {
    // A schema that does not compile constrains nothing we can check;
    // treat it as satisfied rather than fail every call of the tool.
    fn = null;
  }
  if (compiled.size >= MAX_CACHED) compiled.delete(compiled.keys().next().value as string);
  compiled.set(key, fn);
  return fn;
}

/** A short reason the value does not conform, or null when it does. */
export function outputSchemaViolation(schema: Record<string, any>, value: unknown): string | null {
  const validate = validatorFor(schema);
  if (!validate || validate(value)) return null;
  const first = validate.errors?.[0];
  if (!first) return 'does not match';
  return `${first.instancePath || '(root)'} ${first.message ?? 'is invalid'}`.slice(0, 300);
}

/** Compile a schema as 2020-12, returning the compile error, or null. Used by guard specs. */
export function jsonSchema2020CompileError(schema: unknown): string | null {
  const strict = new Ajv2020({ strict: false, validateFormats: false, logger: false });
  try {
    strict.compile(schema as any);
    return null;
  } catch (error: any) {
    return error?.message ?? String(error);
  }
}
