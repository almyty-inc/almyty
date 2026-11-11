import { isSecretPropertyName } from '../../../common/version-snapshot-redaction';
import { isSecretKey } from '../../tool-hub/template-sanitizer';
import type { JsonSchema } from './dto-schema';

/**
 * No management-MCP call carries a secret. A secret (an API key, a token,
 * a password, a client secret, a private key) is typed into the app, where
 * it goes straight into the credentials vault; it is never an MCP
 * argument, so it never sits in an assistant's context, its transcript or
 * its logs.
 *
 * Two checks hold that:
 *  - an operation whose purpose is a secret (adding or rotating a
 *    credential, setting an API's key) is excluded from the catalog, and
 *    calling it answers with a link to the app page that takes it
 *    (SECRET_OPERATIONS in management-operations.ts);
 *  - every other call is refused when any argument, at any depth, is named
 *    like a secret and has a value (secretArgumentPaths). That covers the
 *    free-form objects a DTO cannot describe (headers, auth configs,
 *    provider configuration).
 *
 * A name is a secret by the two detectors the repo already redacts with:
 * the version-snapshot redaction (`isSecretPropertyName`) and the tool-hub
 * template sanitizer (`isSecretKey`). management-coverage.guard.spec.ts
 * fails when an exposed operation's argument schema has such a field.
 */
export function isSecretArgumentName(name: string): boolean {
  return isSecretPropertyName(name) || isSecretKey(name);
}

const MAX_DEPTH = 16;

/**
 * Where `value` carries a secret: the path of every key named like one
 * whose value is not empty. `notSecret` lists exact paths whose name only
 * reads like a secret (a role's `key`); `passThrough` lists paths whose
 * content is a tool's or an agent's own input, handed to it as it is and
 * never stored as almyty configuration. Paths are dotted, `[]` for an
 * array item: `body.config.apiKey`, `body.headers.Authorization`.
 */
export function secretArgumentPaths(
  value: unknown,
  opts: { notSecret?: readonly string[]; passThrough?: readonly string[] } = {},
  path = '',
  depth = 0,
): string[] {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return [];
  if (path && opts.passThrough?.includes(path)) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => secretArgumentPaths(item, opts, `${path}[]`, depth + 1));
  }
  const found: string[] = [];
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const at = path ? `${path}.${key}` : key;
    if (isSecretArgumentName(key) && hasValue(inner) && !opts.notSecret?.includes(at)) {
      found.push(at);
      continue;
    }
    found.push(...secretArgumentPaths(inner, opts, at, depth + 1));
  }
  return found;
}

function hasValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** The paths of every property in `schema` named like a secret, in the same notation. */
export function secretSchemaPaths(schema: JsonSchema | undefined, path = '', depth = 0): string[] {
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH) return [];
  const found: string[] = [];
  for (const [key, inner] of Object.entries((schema.properties ?? {}) as Record<string, JsonSchema>)) {
    const at = path ? `${path}.${key}` : key;
    if (isSecretArgumentName(key)) found.push(at);
    found.push(...secretSchemaPaths(inner, at, depth + 1));
  }
  if (schema.items) found.push(...secretSchemaPaths(schema.items, `${path}[]`, depth + 1));
  return found;
}

/** `schema` without the properties at `paths` (dotted, as above). */
export function withoutSchemaPaths(schema: JsonSchema, paths: readonly string[]): JsonSchema {
  if (!paths.length) return schema;
  const copy: JsonSchema = structuredClone(schema);
  for (const p of paths) {
    const parts = p.split('.');
    let node: JsonSchema | undefined = copy;
    for (const part of parts.slice(0, -1)) node = node?.properties?.[part];
    const last = parts[parts.length - 1];
    if (node?.properties?.[last]) {
      delete node.properties[last];
      if (Array.isArray(node.required)) {
        node.required = node.required.filter((r: string) => r !== last);
        if (!node.required.length) delete node.required;
      }
    }
  }
  return copy;
}

/** A dashboard address: FRONTEND_URL plus `path`. */
export function appUrl(path: string): string {
  let base = process.env.FRONTEND_URL || 'https://app.almyty.com';
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}${path}`;
}

/** The refusal an MCP client reads when a call carries a secret. */
export function secretRefusal(what: string, paths: string[], appPath = '/credentials/new'): string {
  return (
    `${what} does not take secrets over MCP (${paths.join(', ')}). ` +
    `Add the secret in the app, where it goes straight into the credentials vault: ${appUrl(appPath)}. ` +
    'Then make the call again without it.'
  );
}
