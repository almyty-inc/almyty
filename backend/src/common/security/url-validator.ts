/**
 * URL validation and SSRF protection.
 *
 * Blocks requests to private, loopback, link-local, metadata and other
 * reserved addresses, in every spelling (see `ip-classification.ts`, which
 * this shares with the sandbox net guard), to known metadata/cluster
 * hostnames, and to common internal-only service ports on internal-looking
 * names.
 *
 * This is the string half of the gate. A hostname is not known to be
 * private until it resolves: the connect-time half is the DNS-pinning
 * lookup in `ssrf-safe-agent.ts` / `safe-fetch.ts`, which classifies every
 * resolved address with the same function.
 */

import { URL } from 'url';
import * as net from 'net';

import { classifyAddress, isBlockedHostname, stripBrackets } from './ip-classification';

export interface UrlValidationResult {
  valid: boolean;
  error?: string;
  sanitizedUrl?: string;
}

/**
 * Validate a URL is safe for server-side requests (SSRF protection).
 */
export function validateUrl(urlString: string): UrlValidationResult {
  let parsed: URL;

  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, error: `Invalid URL: ${urlString}` };
  }

  // Only allow HTTP and HTTPS
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Blocked protocol: ${parsed.protocol}. Only http: and https: are allowed.` };
  }

  // Block credentials in URL
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with embedded credentials are not allowed.' };
  }

  // Node's URL parser keeps the brackets on an IPv6 host and rewrites the
  // address into compressed hex (`[::ffff:169.254.169.254]` arrives here
  // as `[::ffff:a9fe:a9fe]`), so nothing below may match on spelling.
  const hostname = stripBrackets(parsed.hostname.toLowerCase());
  // The root-label form `localhost.` is the same host as `localhost`.
  const bareName = hostname.replace(/\.+$/, '');

  if (isBlockedHostname(hostname)) {
    return { valid: false, error: `Blocked hostname: ${hostname}` };
  }

  // Reject ambiguous / non-canonical numeric host forms — decimal
  // (2130706433), hex (0x7f000001), or short-dotted (127.1) integers.
  // The WHATWG parser already canonicalises these for http(s), so this is
  // the backstop for a caller that hands us something it did not parse.
  if (
    net.isIP(bareName) === 0 &&
    /^(?:0x[0-9a-f]+|\d+|\d{1,3}(?:\.\d{1,3}){1,3})$/i.test(bareName)
  ) {
    return { valid: false, error: `Blocked ambiguous numeric host: ${hostname}` };
  }

  const verdict = classifyAddress(hostname);
  if (verdict.kind === 'blocked') {
    return {
      valid: false,
      error: verdict.metadata
        ? `Blocked cloud metadata endpoint: ${hostname}`
        : `Blocked private/reserved IP: ${hostname}`,
    };
  }

  // Block common internal ports on any host
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
  const INTERNAL_ONLY_PORTS = [6379, 5432, 3306, 27017, 9200, 2379, 8500]; // redis, postgres, mysql, mongo, elasticsearch, etcd, consul
  if (INTERNAL_ONLY_PORTS.includes(port) && isLikelyInternal(bareName)) {
    return { valid: false, error: `Blocked internal service port ${port} on ${hostname}` };
  }

  return { valid: true, sanitizedUrl: parsed.toString() };
}

/**
 * Check if a hostname looks internal (not a public domain).
 */
function isLikelyInternal(hostname: string): boolean {
  // IP addresses that passed the private range check are considered non-internal
  if (net.isIP(hostname)) return false;

  // Single-label hostnames (no dots) are likely internal
  if (!hostname.includes('.')) return true;

  // Common internal domain patterns
  const internalPatterns = [
    /\.local$/,
    /\.internal$/,
    /\.corp$/,
    /\.lan$/,
    /\.svc$/,
    /\.cluster$/,
  ];

  return internalPatterns.some(p => p.test(hostname));
}

/**
 * Sanitize HTTP headers — remove dangerous headers that could be
 * exploited through tool parameter injection.
 */
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const BLOCKED_HEADERS = new Set([
    'host',
    'transfer-encoding',
    'connection',
    'upgrade',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'keep-alive',
    'x-forwarded-for',
    'x-forwarded-host',
    'x-forwarded-proto',
    'x-real-ip',
    'forwarded',
    'cookie',
    'set-cookie',
  ]);

  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lowerKey = key.toLowerCase();

    // Skip blocked headers
    if (BLOCKED_HEADERS.has(lowerKey)) continue;

    // Skip headers with newlines (header injection)
    if (/[\r\n]/.test(value)) continue;

    // Limit header value length
    if (value.length > 8192) continue;

    sanitized[key] = value;
  }

  return sanitized;
}

/**
 * Validate response size doesn't exceed limits.
 */
export function validateResponseSize(contentLength: number | undefined, maxBytes: number = 10 * 1024 * 1024): boolean {
  if (contentLength === undefined) return true; // Can't check, allow but enforce at stream level
  return contentLength <= maxBytes;
}

/**
 * Escape hatch for self-hosted deployments that run Ollama on
 * localhost / a private network. Mirrors MCP_ALLOW_PRIVATE_URLS for
 * the MCP client.
 *
 * Default OFF: on hosted almyty a tenant-supplied private Ollama URL
 * is exactly the SSRF vector validateUrl() exists to block (cloud
 * metadata, in-cluster services, loopback admin ports). Self-hosters
 * who want a machine-local Ollama set OLLAMA_ALLOW_PRIVATE_URLS=true
 * on the API process.
 *
 * Even when the gate is open, URLs still go through
 * validateUrlAllowingPrivate() — http(s)-only, no embedded
 * credentials — so the override only relaxes the private/loopback
 * range bans, never the protocol or credential rules.
 */
export function ollamaPrivateUrlsAllowed(): boolean {
  return process.env.OLLAMA_ALLOW_PRIVATE_URLS === 'true';
}

/**
 * Same posture for custom OpenAI-compatible providers and endpoint cards
 * (a vLLM box on the LAN is the normal case for a self-host). Hosted
 * deployments leave LLM_ALLOW_PRIVATE_URLS unset so tenant-supplied
 * private URLs stay blocked.
 */
export function customLlmPrivateUrlsAllowed(): boolean {
  return process.env.LLM_ALLOW_PRIVATE_URLS === 'true';
}

/**
 * Reduced validation used when a private-URL escape hatch
 * (OLLAMA_ALLOW_PRIVATE_URLS / MCP_ALLOW_PRIVATE_URLS) is active:
 * the URL must still be parseable, http(s)-only, and free of embedded
 * credentials, but private/loopback/link-local ranges are permitted.
 */
export function validateUrlAllowingPrivate(urlString: string): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { valid: false, error: `Invalid URL: ${urlString}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: `Blocked protocol: ${parsed.protocol}. Only http: and https: are allowed.` };
  }
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with embedded credentials are not allowed.' };
  }
  return { valid: true, sanitizedUrl: parsed.toString() };
}
