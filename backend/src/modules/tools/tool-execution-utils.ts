/**
 * Pure helpers used across the tool-execution pipeline.
 *
 * Extracted from the old 1,866-line `tool-executor.service.ts` monolith
 * so the type-specific executors can share them without re-implementing.
 * Everything in this file is stateless + side-effect-free so it can be
 * unit-tested in isolation — which is why the new audit fixes
 * (CRLF-safe header substitution, JSON-safe body templating,
 * pagination URL revalidation) live here.
 */

import { BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { validateUrl } from '../../common/security/url-validator';

// ───── dot-path access ─────────────────────────────────────────────

/**
 * Safe dot-notation property access. Returns `undefined` on any
 * missing link in the chain rather than throwing. Used by response
 * mapping (`responseMapping.dataPath`, `responseMapping.errorPath`),
 * pagination cursor extraction, and success-condition evaluation.
 */
export function getByDotPath(obj: any, path: string): any {
  if (obj == null || typeof path !== 'string' || path.length === 0) {
    return undefined;
  }
  return path.split('.').reduce((curr, key) => {
    if (curr === null || curr === undefined) return undefined;
    return curr[key];
  }, obj);
}

// ───── XML entity escape ───────────────────────────────────────────

/**
 * Escape the five XML predefined entities. Used when interpolating
 * user-supplied parameter values into SOAP body templates — without
 * it, a value like `</soap:Body>` (or any `<`, `>`, `&`) breaks out
 * of its containing element and injects arbitrary XML into the
 * outbound SOAP request.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ───── JSON-safe body template substitution ────────────────────────

/**
 * Apply a `{name}`-style template to a JSON body string safely.
 *
 * The previous implementation in `tool-executor.service.ts` did a
 * naive string replace of `{name}` with the stringified value before
 * calling `JSON.parse` on the result. That's a JSON injection vector:
 * a parameter value like `bar", "admin": true` or `baz"}, "role":
 * "admin", "x": {"` breaks out of its string field and injects new
 * fields or mutates existing ones, because the template is parsed
 * AFTER substitution.
 *
 * The fix: parse the template FIRST (with the placeholders still in
 * place), then walk the resulting JSON value and replace any string
 * whose entire content is a single `{name}` placeholder with the
 * actual parameter value. String interpolation inside larger strings
 * is still supported, but each substituted segment is inserted as a
 * JSON-string — not as raw source — so punctuation in the value
 * cannot change the shape of the surrounding object.
 *
 * Throws BadRequestException if the template isn't valid JSON.
 */
export function applyJsonBodyTemplate(
  template: string,
  parameters: Record<string, any>,
): any {
  // Parse the template with placeholders intact. `{name}` is a valid
  // JSON-string character set, so this works as long as the template
  // author put their placeholders inside quoted strings (which is the
  // documented contract — `{"user": "{name}"}`).
  let parsed: any;
  try {
    parsed = JSON.parse(template);
  } catch (err: any) {
    throw new BadRequestException(`Invalid bodyTemplate (not valid JSON): ${err.message}`);
  }

  const WHOLE_PLACEHOLDER = /^\{(\w+)\}$/;
  const INNER_PLACEHOLDER = /\{(\w+)\}/g;

  const walk = (value: any): any => {
    if (typeof value === 'string') {
      // If the entire value is a single placeholder, splice in the
      // parameter's actual type (object, array, number, boolean, etc.).
      const whole = value.match(WHOLE_PLACEHOLDER);
      if (whole) {
        const name = whole[1];
        return name in parameters ? parameters[name] : value;
      }
      // Otherwise, it's a mixed string — interpolate param values as
      // their string representation. Substituted chunks CAN'T break
      // out of the enclosing JSON string because we're operating on
      // the already-parsed value, not on the serialized source.
      return value.replace(INNER_PLACEHOLDER, (match, name) =>
        name in parameters ? String(parameters[name]) : match,
      );
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  return walk(parsed);
}

// ───── CRLF-safe header substitution ───────────────────────────────

/**
 * Substitute `{name}` placeholders in a header value with sanitized
 * parameter values. Previously the substitution was a blind string
 * replace followed by a `sanitizeHeaders` pass on the whole map —
 * but `sanitizeHeaders` operated on the merged header bag AFTER
 * substitution, which meant a CRLF inside a parameter VALUE already
 * landed in the outgoing request header and the post-hoc sanitizer
 * couldn't tell injected CRLF apart from a legitimate one the caller
 * set directly. HTTP request splitting reachable by anyone who could
 * invoke the tool.
 *
 * The fix is to refuse any substituted value that contains \r or \n
 * at substitution time — i.e. the moment the value enters the header
 * string, before it ever reaches the axios request config.
 *
 * Throws BadRequestException on CRLF so the caller sees a 400 rather
 * than silently corrupted headers.
 */
export function substituteHeaderValue(
  template: string,
  parameters: Record<string, any>,
  headerName: string,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in parameters)) return match;
    const substituted = String(parameters[name]);
    if (/[\r\n]/.test(substituted)) {
      throw new BadRequestException(
        `Header '${headerName}' contains a CRLF in substituted value for '${name}'`,
      );
    }
    return substituted;
  });
}

// ───── pagination URL safety ───────────────────────────────────────

/**
 * Validate a URL pulled from an API response (cursor pagination,
 * Link header) before we fetch it as the next page.
 *
 * The old pagination loop would take `nextUrl` from `response.data`
 * or parse it out of `Link: <url>; rel="next"` and immediately stuff
 * it into `pageConfig.url` with nothing more than a `startsWith('http')`
 * check. That's SSRF: a malicious upstream API can return a first
 * page that looks legitimate, then hand us a `nextUrl` pointing at
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/`,
 * `http://localhost:6379/`, or any internal service, and the next
 * page fetch carries our auth headers (see `addAuthentication` in
 * the HTTP executor) straight into the internal network.
 *
 * Every page transition MUST re-run validateUrl on whatever URL is
 * about to be fetched. This helper resolves relative URLs against
 * the base, runs the same SSRF gate the initial request passed, and
 * returns the safe URL — or throws so the pagination loop stops.
 */
export function assertSafeNextPageUrl(
  nextUrl: string,
  baseUrl: string | undefined,
): string {
  if (typeof nextUrl !== 'string' || nextUrl.length === 0) {
    throw new BadRequestException('Pagination next URL is empty');
  }

  // Resolve relative to the current page's URL if needed.
  let resolved: string;
  try {
    resolved = new URL(nextUrl, baseUrl || undefined).toString();
  } catch {
    throw new BadRequestException(`Invalid pagination next URL: ${nextUrl}`);
  }

  const check = validateUrl(resolved);
  if (!check.valid) {
    throw new BadRequestException(`Refused pagination next URL: ${check.error}`);
  }
  return resolved;
}

// ───── HTTP success condition DSL ──────────────────────────────────

/**
 * Evaluate a `successCondition` string from `responseMapping.successCondition`.
 *
 * Supports two shapes:
 *   - `status < 400`       (or ==, !=, >, <=, >=)
 *   - `data.path === value`
 *
 * Anything else falls back to the HTTP default (2xx + 3xx = success).
 * Kept deliberately tiny — this is a config DSL, not an expression
 * language, and every token that gets added becomes another
 * injection surface.
 */
export function evaluateHttpSuccessCondition(
  condition: string,
  status: number,
  data: any,
): boolean {
  const trimmed = condition.trim();

  // "status < 400"
  const statusMatch = trimmed.match(/^status\s*(===?|!==?|<|>|<=|>=)\s*(\d+)$/);
  if (statusMatch) {
    const [, op, val] = statusMatch;
    return compareConditionValues(status, op, Number(val));
  }

  // "data.foo === true"
  const dataMatch = trimmed.match(/^data\.(.+?)\s*(===?|!==?)\s*(.+)$/);
  if (dataMatch) {
    const [, path, op, rawVal] = dataMatch;
    const actual = getByDotPath(data, path);
    let expected: any = rawVal.trim();
    if (expected === 'true') expected = true;
    else if (expected === 'false') expected = false;
    else if (expected === 'null') expected = null;
    else if (expected === 'undefined') expected = undefined;
    else if (/^\d+$/.test(expected)) expected = Number(expected);
    else expected = expected.replace(/^['"]|['"]$/g, '');
    return compareConditionValues(actual, op, expected);
  }

  return status >= 200 && status < 400;
}

export function compareConditionValues(a: any, op: string, b: any): boolean {
  switch (op) {
    case '==':
    case '===':
      return a === b;
    case '!=':
    case '!==':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
    default:
      return false;
  }
}

// ───── form-urlencoded encoder ─────────────────────────────────────

/**
 * Flatten an object (arrays, nested objects, scalars) into a
 * form-urlencoded string using the PHP/Rack bracket convention.
 * Arrays become `key[]=val&key[]=val`, nested objects become
 * `parent[child]=val`.
 */
export function encodeFormUrlencoded(body: Record<string, any>): string {
  const params = new URLSearchParams();
  const flatten = (obj: any, prefix = '') => {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}[${key}]` : key;
      if (Array.isArray(value)) {
        value.forEach(v => params.append(`${fullKey}[]`, String(v)));
      } else if (typeof value === 'object' && value !== null) {
        flatten(value, fullKey);
      } else if (value !== undefined && value !== null) {
        params.append(fullKey, String(value));
      }
    }
  };
  flatten(body);
  return params.toString();
}

// ───── deterministic cache-key hashing ─────────────────────────────

/**
 * Deterministic JSON hash with stable key ordering at every nesting
 * level. Used to key the per-tool result cache.
 *
 * The old implementation used `JSON.stringify(obj, Object.keys(obj).sort())`,
 * whose second argument is a KEY FILTER applied at every level —
 * not a sort order. Nested keys that didn't appear at the top level
 * got dropped, so `{filter: {name: 'foo'}}` and `{filter: {name:
 * 'bar'}}` both serialized to `{"filter":{}}` and hit the same
 * cache slot. Cache collision → wrong data returned to LLMs.
 *
 * This implementation recursively sorts every object's keys so the
 * output is stable for equal inputs regardless of original key
 * order, without filtering.
 */
export function hashCacheObject(obj: any): string {
  const stable = (value: any): any => {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(stable);
    const sortedKeys = Object.keys(value).sort();
    const out: Record<string, any> = {};
    for (const key of sortedKeys) out[key] = stable(value[key]);
    return out;
  };
  const str = JSON.stringify(stable(obj));
  return crypto.createHash('md5').update(str).digest('hex');
}

// ───── tiny helpers ────────────────────────────────────────────────

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Unguessable request id. The old shape was
 * `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}` —
 * predictable timestamp + non-cryptographic random. This one isn't
 * security-critical (it's only surfaced in metadata for debugging)
 * but we're making every id in this codebase unguessable as a rule.
 */
export function generateRequestId(): string {
  return `req_${crypto.randomBytes(12).toString('hex')}`;
}
