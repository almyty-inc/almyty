import { HttpConfig } from '../../entities/tool.entity';

/**
 * A template is a shape, not a configured request.
 *
 * A Tool in a working organization carries live credentials in several
 * places -- `authConfig`, `httpConfig.headers`, a bearer token baked into
 * a query parameter, a `credentialId` in `metadata`, and the `headers` /
 * `authentication` of the Api it hangs off. A ToolTemplate is readable by
 * every organization that can see it, so none of that may cross into one.
 * Everything here is deny-by-default: a field is copied because it was
 * named, never because it happened to be on the source object.
 */

/**
 * Key names that carry a credential. Matched against the key with
 * everything but letters and digits removed, so `X-Api-Key`, `x_api_key`
 * and `apiKey` all collapse to `apikey`.
 *
 * Split into exact and substring sets on purpose: `auth` as a substring
 * would drop a legitimate `author` parameter, so bare words match whole
 * keys only, and compound words -- which cannot occur by accident -- match
 * anywhere.
 */
const SECRET_KEY_EXACT = new Set([
  'auth',
  'authorization',
  'bearer',
  'cookie',
  'credential',
  'credentials',
  'key',
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'session',
  'sig',
  'signature',
  'token',
]);

const SECRET_KEY_FRAGMENTS = [
  'accesskey',
  'accesstoken',
  'apikey',
  'apisecret',
  'apitoken',
  'authtoken',
  'clientsecret',
  'privatekey',
  'refreshtoken',
  'secretkey',
  'securitytoken',
  'sessiontoken',
  'subscriptionkey',
];

/** Prefixes that identify a credential whatever the key is called. */
const SECRET_VALUE_PREFIXES = [
  'bearer ',
  'basic ',
  'sk-',
  'sk_live',
  'sk_test',
  'pk_live',
  'ghp_',
  'gho_',
  'github_pat_',
  'xox',
  'aws4-hmac',
  'eyj', // a JWT's base64 '{"' header
];

/** Opaque-token shape: long, and nothing but credential alphabet. */
const OPAQUE_TOKEN = /^[A-Za-z0-9._\-+/=]{20,}$/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a key name declares itself a credential. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * True when a value looks like a credential that was baked in rather
 * than left as a `{placeholder}` for the installing organization to
 * fill. A value containing a placeholder is structural by definition.
 */
export function isSecretValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  const lowered = trimmed.toLowerCase();
  if (SECRET_VALUE_PREFIXES.some((prefix) => lowered.startsWith(prefix))) return true;
  if (trimmed.includes('{')) return false;
  return OPAQUE_TOKEN.test(trimmed);
}

/** Drop every entry whose key or value carries a credential. */
export function scrubStringMap(
  map: Record<string, string> | undefined | null,
): Record<string, string> | undefined {
  if (!map || typeof map !== 'object') return undefined;
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (isSecretKey(key) || isSecretValue(value)) continue;
    kept[key] = value;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * The publishable part of a tool's HTTP configuration.
 *
 * `headers` is dropped whole rather than filtered. Headers are where
 * request-level auth lives, an installing organization supplies its own
 * through the Api the install creates, and no header a template could
 * carry is worth the risk of a filter that missed one.
 *
 * `queryParams` is filtered instead of dropped because query parameters
 * are routinely structural (`?limit={limit}`); only the ones that name or
 * look like a credential go.
 */
export function sanitizeHttpConfig(httpConfig: HttpConfig | null | undefined): HttpConfig | null {
  if (!httpConfig || typeof httpConfig !== 'object') return null;
  const { method, path, bodyEncoding, bodyTemplate, responseMapping, pagination } = httpConfig;
  const queryParams = scrubStringMap(httpConfig.queryParams);
  return {
    method,
    path,
    ...(bodyEncoding ? { bodyEncoding } : {}),
    ...(bodyTemplate ? { bodyTemplate } : {}),
    ...(responseMapping ? { responseMapping } : {}),
    ...(pagination ? { pagination } : {}),
    ...(queryParams ? { queryParams } : {}),
  };
}

/**
 * The publishable part of a tool's `configuration`. Named fields only:
 * `configuration.mcp` points at an McpSource row in the publishing
 * organization and means nothing anywhere else, and the column is a free
 * JSON bag that anything could have written to.
 */
export function sanitizeConfiguration(
  configuration: Record<string, any> | null | undefined,
): Record<string, any> {
  if (!configuration || typeof configuration !== 'object') return {};
  const { timeout, retries, rateLimit, cache } = configuration as any;
  return {
    ...(typeof timeout === 'number' ? { timeout } : {}),
    ...(typeof retries === 'number' ? { retries } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    ...(cache ? { cache } : {}),
  };
}

/**
 * Example inputs are real call payloads recorded against a real account,
 * so a parameter genuinely named `api_key` arrives here holding one.
 * Keep the example, drop those fields.
 */
export function sanitizeExamples(
  examples: Array<{ name: string; input: any; expectedOutput?: any }> | null | undefined,
): Array<{ name: string; input: any; expectedOutput?: any }> {
  if (!Array.isArray(examples)) return [];
  return examples.map((example) => {
    const input =
      example?.input && typeof example.input === 'object' && !Array.isArray(example.input)
        ? Object.fromEntries(
            Object.entries(example.input).filter(
              ([key, value]) => !isSecretKey(key) && !isSecretValue(value),
            ),
          )
        : {};
    return {
      name: example?.name ?? 'example',
      input,
      ...(example?.expectedOutput !== undefined ? { expectedOutput: example.expectedOutput } : {}),
    };
  });
}
