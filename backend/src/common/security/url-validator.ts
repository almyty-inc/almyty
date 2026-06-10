/**
 * URL validation and SSRF protection.
 *
 * Blocks requests to:
 * - Private IP ranges (10.x, 172.16-31.x, 192.168.x)
 * - Loopback (127.x, localhost, ::1)
 * - Link-local (169.254.x)
 * - Cloud metadata endpoints (169.254.169.254)
 * - Internal services (redis, postgres ports on localhost)
 */

import { URL } from 'url';
import * as net from 'net';

// Private and reserved IP ranges (CIDR notation conceptual)
const BLOCKED_IP_PATTERNS = [
  /^127\./,                    // Loopback
  /^10\./,                     // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./, // Class B private
  /^192\.168\./,               // Class C private
  /^169\.254\./,               // Link-local / cloud metadata
  /^0\./,                      // Current network
  /^100\.(6[4-9]|[7-9]\d|1[0-2][0-7])\./, // Shared address space
  /^198\.1[89]\./,             // Benchmark testing
  /^::1$/,                     // IPv6 loopback
  /^f[cd][0-9a-f]{2}:/i,       // IPv6 unique local (fc00::/7)
  /^fe80:/i,                   // IPv6 link-local
];

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
  'metadata.aws.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.com',
  'metadata.azure.net',
  'kubernetes.default',
  'kubernetes.default.svc',
];

// Cloud metadata IPs
const CLOUD_METADATA_IPS = [
  '169.254.169.254',  // AWS, GCP, Azure
  'fd00:ec2::254',    // AWS IPv6
];

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

  // Node's URL parser preserves the surrounding brackets for IPv6 hosts
  // (e.g. `http://[::1]/`.hostname === '[::1]'). Strip them so the IP
  // checks below see the bare address — otherwise [::1] sails past the
  // /^::1$/ loopback pattern and we'd silently allow IPv6 SSRF.
  const rawHostname = parsed.hostname.toLowerCase();
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  // Block known dangerous hostnames
  for (const blocked of BLOCKED_HOSTNAMES) {
    if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
      return { valid: false, error: `Blocked hostname: ${hostname}` };
    }
  }

  // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1) to its embedded v4
  // so the v4 ban patterns below catch it. net.isIP returns 6 for the
  // mapped form, so without this it skips the v4 checks entirely.
  let ipForCheck = hostname;
  const mapped = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped) {
    ipForCheck = mapped[1];
  }

  // Reject ambiguous / non-canonical numeric host forms — decimal
  // (2130706433), hex (0x7f000001), or short-dotted (127.1) integers.
  // net.isIP returns 0 for these, so they'd otherwise sail past the
  // IP-range checks as "hostnames", yet the OS resolver expands them
  // to real (often loopback/internal) addresses. Canonical dotted
  // quads already match net.isIP === 4.
  if (
    net.isIP(ipForCheck) === 0 &&
    /^(?:0x[0-9a-f]+|\d+|\d{1,3}(?:\.\d{1,3}){1,3})$/i.test(ipForCheck)
  ) {
    return { valid: false, error: `Blocked ambiguous numeric host: ${hostname}` };
  }
  // Check if hostname is an IP address
  if (net.isIP(ipForCheck)) {
    // Check cloud metadata endpoints first (more specific match)
    if (CLOUD_METADATA_IPS.includes(ipForCheck)) {
      return { valid: false, error: `Blocked cloud metadata endpoint: ${hostname}` };
    }

    // Check against blocked IP patterns
    for (const pattern of BLOCKED_IP_PATTERNS) {
      if (pattern.test(ipForCheck)) {
        return { valid: false, error: `Blocked private/reserved IP: ${hostname}` };
      }
    }
  }

  // Block common internal ports on any host
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80);
  const INTERNAL_ONLY_PORTS = [6379, 5432, 3306, 27017, 9200, 2379, 8500]; // redis, postgres, mysql, mongo, elasticsearch, etcd, consul
  if (INTERNAL_ONLY_PORTS.includes(port) && isLikelyInternal(hostname)) {
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
