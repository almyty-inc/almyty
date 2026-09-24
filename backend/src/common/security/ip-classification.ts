/**
 * The one address classifier for every outbound request the server makes.
 *
 * Two gates used to decide "is this address private" independently: the
 * URL validator (`url-validator.ts`, reached by schema import, HTTP tools,
 * webhooks, MCP sources, OAuth, model endpoints and the DNS-pinning agents)
 * and the sandbox net guard (`sandbox-net-guard.ts`, reached by tool code).
 * The validator matched regexes against the host string, so any IPv6
 * spelling of a banned IPv4 address walked past it: the WHATWG URL parser
 * rewrites `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]` before the
 * validator ever sees it, and the IPv4-compatible, NAT64, 6to4 and Teredo
 * forms were never considered at all. Both gates now ask this module, so
 * a range cannot be banned in one and forgotten in the other.
 *
 * How an address is classified:
 *
 *   1. Brackets are stripped. An IPv6 zone id (`fe80::1%eth0`) makes the
 *      address blocked outright: zones only exist for scoped addresses,
 *      which are never a valid target for the server.
 *   2. IPv4 is checked against BLOCKED_IPV4 with `net.BlockList`, which
 *      parses the address instead of comparing its spelling.
 *   3. IPv6 is parsed into its eight 16-bit groups. If it embeds an IPv4
 *      address a router or the kernel would deliver to (IPv4-mapped
 *      `::ffff:0:0/96`, 6to4 `2002::/16`), the embedded address is
 *      classified as IPv4. The IPv6 address itself is then checked against
 *      BLOCKED_IPV6, which bans outright the embedding forms that have no
 *      business being a server-side target (IPv4-compatible `::/96`, SIIT
 *      `::ffff:0:0:0/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`,
 *      Teredo `2001::/32`) whatever address they carry.
 *
 * This file must stay dependency-free apart from `net`: the sandbox worker
 * loads it under Node's permission model with a file-scoped read grant.
 */
import * as net from 'net';

/**
 * IPv4 ranges no outbound request may reach. IANA special-purpose
 * registry (RFC 6890) plus multicast and class E.
 */
export const BLOCKED_IPV4_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes EC2/GCP/Azure IMDS
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmark
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (class E)
  ['255.255.255.255', 32], // limited broadcast
];

/** IPv6 ranges no outbound request may reach. */
export const BLOCKED_IPV6_CIDRS: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // unspecified, loopback and deprecated IPv4-compatible (::a.b.c.d)
  ['::ffff:0:0:0', 96], // SIIT IPv4-translated (RFC 7915)
  ['64:ff9b::', 96], // NAT64 well-known prefix (RFC 6052)
  ['64:ff9b:1::', 48], // NAT64 local-use (RFC 8215)
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo: embeds a client IPv4 the relay would deliver to
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['3fff::', 20], // documentation (RFC 9637)
  ['fc00::', 7], // unique local (fc* and fd*)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

/**
 * Hostnames refused before DNS runs, so no resolver answer can matter.
 * Subdomains are refused too (`x.metadata.google.internal`), and a
 * trailing root dot (`localhost.`) is not a way around the list.
 */
export const BLOCKED_HOSTNAMES: ReadonlyArray<string> = [
  'localhost',
  'metadata',
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

/** Cloud instance-metadata addresses, reported with a more specific reason. */
const CLOUD_METADATA_ADDRESSES: ReadonlyArray<string> = [
  '169.254.169.254', // AWS, GCP, Azure, most others
  '169.254.170.2', // ECS task metadata
  'fd00:ec2::254', // AWS IPv6 IMDS
];

let blockList: net.BlockList | null = null;

function blocked(): net.BlockList {
  if (blockList) return blockList;
  const list = new net.BlockList();
  for (const [addr, bits] of BLOCKED_IPV4_CIDRS) {
    if (bits === 32) list.addAddress(addr, 'ipv4');
    else list.addSubnet(addr, bits, 'ipv4');
  }
  for (const [addr, bits] of BLOCKED_IPV6_CIDRS) {
    if (bits === 128) list.addAddress(addr, 'ipv6');
    else list.addSubnet(addr, bits, 'ipv6');
  }
  blockList = list;
  return list;
}

/** `[::1]` -> `::1`; anything else unchanged. */
export function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Parse an IPv6 address (no zone, no brackets) into eight 16-bit groups.
 * Accepts every accepted spelling: compressed, expanded, mixed case,
 * leading zeros, and a dotted-quad tail. Returns null for anything else.
 */
export function parseIPv6(address: string): number[] | null {
  if (net.isIPv6(address) === false) return null;
  let s = address.toLowerCase();
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    if (net.isIPv4(tail) === false) return null;
    const o = tail.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const words = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return words.some((w) => Number.isNaN(w)) ? null : words;
}

function v4FromWords(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

function canonicalIPv6(address: string): string | null {
  const w = parseIPv6(address);
  return w ? w.map((x) => x.toString(16)).join(':') : null;
}

/**
 * The IPv4 address an IPv6 address delivers to, when it is one of the
 * forms a host or router translates: IPv4-mapped (`::ffff:a.b.c.d`) and
 * 6to4 (`2002:AABB:CCDD::/48`). Null otherwise. The other embedding forms
 * are banned wholesale by BLOCKED_IPV6_CIDRS and need no extraction.
 */
export function embeddedIPv4(address: string): string | null {
  const w = parseIPv6(address);
  if (!w) return null;
  if (w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0xffff) {
    return v4FromWords(w[6], w[7]);
  }
  if (w[0] === 0x2002) return v4FromWords(w[1], w[2]);
  return null;
}

export type AddressVerdict =
  | { kind: 'not-ip' }
  | { kind: 'public'; address: string }
  | { kind: 'blocked'; address: string; metadata: boolean };

function isMetadataAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return CLOUD_METADATA_ADDRESSES.includes(address);
  const canonical = canonicalIPv6(address);
  return CLOUD_METADATA_ADDRESSES.some((m) => net.isIPv6(m) && canonicalIPv6(m) === canonical);
}

/**
 * Classify a literal address. `input` may carry IPv6 brackets or a
 * zone id. Anything that is not an IP literal is `not-ip`: the caller
 * decides what a hostname means (resolve it and classify the answers).
 */
export function classifyAddress(input: string): AddressVerdict {
  const raw = stripBrackets(String(input).trim()).toLowerCase();
  const pct = raw.indexOf('%');
  if (pct !== -1) {
    const bare = raw.slice(0, pct);
    return net.isIPv6(bare) ? { kind: 'blocked', address: bare, metadata: false } : { kind: 'not-ip' };
  }

  const family = net.isIP(raw);
  if (family === 0) return { kind: 'not-ip' };

  if (family === 4) {
    const metadata = isMetadataAddress(raw, 4);
    return metadata || blocked().check(raw, 'ipv4')
      ? { kind: 'blocked', address: raw, metadata }
      : { kind: 'public', address: raw };
  }

  const v4 = embeddedIPv4(raw);
  if (v4 !== null) {
    const inner = classifyAddress(v4);
    if (inner.kind === 'blocked') return inner;
  }
  const metadata = isMetadataAddress(raw, 6);
  return metadata || blocked().check(raw, 'ipv6')
    ? { kind: 'blocked', address: raw, metadata }
    : { kind: 'public', address: raw };
}

/**
 * True when `address` is an IP literal in a blocked range. False for a
 * public address AND for anything that is not an IP literal; use
 * `classifyAddress` when the difference matters.
 */
export function isBlockedAddress(address: string): boolean {
  return classifyAddress(address).kind === 'blocked';
}

/** True when a hostname (not an IP) is on the pre-DNS refusal list. */
export function isBlockedHostname(hostname: string): boolean {
  const h = stripBrackets(String(hostname).trim().toLowerCase()).replace(/\.+$/, '');
  if (!h) return false;
  return BLOCKED_HOSTNAMES.some((b) => h === b || h.endsWith(`.${b}`));
}
