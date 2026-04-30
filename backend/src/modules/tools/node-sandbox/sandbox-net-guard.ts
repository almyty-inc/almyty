/**
 * Network egress guard for the sandbox worker.
 *
 * Node's `--permission` model gives us kernel-adjacent control of
 * the filesystem, child_process, worker_threads, and native addon
 * loading — but its `--allow-net` flag is all-or-nothing. There's
 * no `--allow-net=<host>` or `--deny-net=<cidr>` primitive. That's
 * what this module provides: a set of monkey-patches applied to
 * `dns.lookup`, `net.Socket.prototype.connect`, and `dgram`
 * **before any user code runs**, so every outbound connection
 * attempt — regardless of whether it originates from direct user
 * code, an installed npm dependency, or a transitive require —
 * flows through one choke point that can refuse it.
 *
 * Why patching at this layer works for every package. Every Node
 * TCP-based client — pg, mongodb, mysql2, redis, ioredis, stripe,
 * twilio, @aws-sdk/client-*, googleapis, axios, node-fetch, undici,
 * the built-in http / https / http2, and dozens of others — bottoms
 * out in one of two places:
 *
 *   1. For hostname-based connect: `dns.lookup(host)` is called by
 *      the TCP layer to resolve the target before calling
 *      `net.Socket.prototype.connect` with a literal IP.
 *   2. For literal-IP connect: `net.Socket.prototype.connect` is
 *      called directly.
 *
 * Patch both sites and every library's network access flows through
 * our check. No library-specific shims, no bundler tricks, no
 * runtime classloader magic.
 *
 * What we refuse:
 *   - IPv4: every private RFC1918 range, loopback, link-local
 *     (includes AWS/Azure/GCP metadata), CGNAT, IETF reserved,
 *     TEST-NET ranges, multicast, class E reserved
 *   - IPv6: loopback, unspecified, link-local, ULA, multicast,
 *     IPv4-mapped IPs that land in a banned v4 range
 *   - Known metadata hostnames (refused before DNS resolution
 *     runs, so even a rebinding attack can't help)
 *
 * What gets through: public unicast IPv4 and public unicast IPv6.
 * That's what users want — stripe.com, api.openai.com, their own
 * RDS/MongoDB Atlas/Redis Cloud endpoints, etc.
 *
 * Test-only escape hatch. Integration tests need to run against
 * a local HTTP server bound to 127.0.0.1, which is (correctly)
 * refused by the ban list. The worker accepts a `SANDBOX_TEST_NET_ALLOW`
 * env var (set only by the test harness) containing a comma-
 * separated list of `host:port` combinations that bypass the
 * ban list. This env var is checked inside the worker, which by
 * this point has been scrubbed of the parent process's env, so
 * the test harness has to pass it explicitly via workerData or
 * similar — production code can't set it.
 */
// CommonJS require so we get a mutable module object — `import * as`
// returns a frozen namespace that we can't patch lookup() on under
// TS6's stricter __importStar.
const net = require('net');
const dns = require('dns');
const dgram = require('dgram');
import type * as netTypes from 'net';
import type * as dgramTypes from 'dgram';

// ── Ban list ────────────────────────────────────────────────────

/**
 * IPv4 CIDRs refused by the guard. Sourced from IANA's IPv4
 * special-purpose registry (RFC 6890).
 *
 * Each entry is `[network, prefixLength]`. The check is a mask-and-
 * compare against the 32-bit big-endian representation of the
 * target address.
 */
const BANNED_IPV4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC1918 private
  ['100.64.0.0', 10], // CGNAT (RFC 6598)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local — includes EC2/GCP/Azure IMDS
  ['172.16.0.0', 12], // RFC1918 private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1 (documentation)
  ['192.168.0.0', 16], // RFC1918 private
  ['198.18.0.0', 15], // benchmark
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (class E)
  ['255.255.255.255', 32], // limited broadcast
];

/**
 * IPv6 ranges refused by the guard. We express each range by a
 * lowercase normalized prefix match on the expanded form. Not as
 * surgically precise as a real prefix/mask check, but sufficient
 * for the categories we care about — Node gives us canonical
 * form from `net.isIPv6` / `dns.lookup`, so the string prefix
 * comparison is reliable.
 */
const BANNED_IPV6_EXACT = new Set<string>([
  '::1', // loopback
  '::', // unspecified
]);
const BANNED_IPV6_PREFIXES: ReadonlyArray<string> = [
  'fe80:', // link-local
  'fc', // ULA (fc00::/7 — covers fc*/fd*)
  'fd',
  'ff', // multicast
];

/**
 * Hostnames refused BEFORE DNS lookup runs. A DNS rebinding attack
 * can't help if we never ask DNS at all. These are the three most
 * common cloud metadata hostnames.
 */
const BANNED_HOSTNAMES: ReadonlySet<string> = new Set<string>([
  'metadata.google.internal',
  'metadata.aws.internal',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.com',
  'metadata.azure.net',
  'localhost',
]);

// ── IP classification helpers ───────────────────────────────────

function ipv4ToLong(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return -1;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return -1;
    out = (out << 8) | n;
  }
  // Force unsigned 32-bit
  return out >>> 0;
}

function isBannedIPv4(ip: string): boolean {
  const long = ipv4ToLong(ip);
  if (long < 0) return true; // unparseable → refuse
  for (const [net, bits] of BANNED_IPV4) {
    const netLong = ipv4ToLong(net);
    if (netLong < 0) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((long & mask) === (netLong & mask)) return true;
  }
  return false;
}

function isBannedIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (BANNED_IPV6_EXACT.has(lower)) return true;
  // IPv4-mapped IPv6 addresses: ::ffff:a.b.c.d — map back and
  // reuse the v4 classifier.
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isBannedIPv4(v4);
  }
  for (const prefix of BANNED_IPV6_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Classify a literal IP address. Returns `true` if the address is
 * in any banned range. Non-IPs return `false` (let the caller
 * decide) — this is intended to be composed with `net.isIP`.
 */
export function isBannedAddress(ip: string): boolean {
  const fam = net.isIP(ip);
  if (fam === 4) return isBannedIPv4(ip);
  if (fam === 6) return isBannedIPv6(ip);
  return false;
}

// ── Refusal error ───────────────────────────────────────────────

function refusal(target: string, reason: string): NodeJS.ErrnoException {
  const err: any = new Error(
    `Sandbox refused network target ${target}: ${reason}`,
  );
  err.code = 'ERR_SANDBOX_NET_REFUSED';
  return err;
}

// ── Test-only allow list ────────────────────────────────────────

interface NetGuardOptions {
  /**
   * Comma-separated `host:port` combinations that bypass the ban
   * list. Exists so integration tests can stand up a local HTTP
   * server on 127.0.0.1 and exercise the worker against it.
   * Production code never sets this.
   */
  testAllow?: string;
}

let allowedTestTargets: Set<string> = new Set();

function isAllowedTestTarget(host: string, port: number): boolean {
  if (allowedTestTargets.size === 0) return false;
  return (
    allowedTestTargets.has(`${host}:${port}`) ||
    allowedTestTargets.has(`${host}:*`) ||
    allowedTestTargets.has(`*:${port}`)
  );
}

// ── Patches ─────────────────────────────────────────────────────

let installed = false;

/**
 * Install the monkey-patches on `net.Socket.prototype.connect`,
 * `dns.lookup`, `dns.promises.lookup`, and `dgram.createSocket`.
 *
 * Idempotent: calling this more than once is a no-op. Must be
 * called from the sandbox worker bootstrap BEFORE any user code
 * loads so that subsequent requires of `net`, `http`, etc. see
 * the patched behaviour.
 */
export function installSandboxNetGuard(options: NetGuardOptions = {}): void {
  if (installed) return;
  installed = true;

  if (options.testAllow) {
    allowedTestTargets = new Set(
      options.testAllow
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  patchDnsLookup();
  patchSocketConnect();
  patchDgram();
}

/** Exposed for tests that want to reset state between runs. */
export function resetSandboxNetGuardForTesting(): void {
  installed = false;
  allowedTestTargets = new Set();
}

// ── dns.lookup patch ────────────────────────────────────────────

/**
 * Wrap `dns.lookup` and `dns.promises.lookup`. The patch:
 *
 *   1. Refuses hostnames in BANNED_HOSTNAMES before calling the
 *      real resolver (prevents DNS rebinding from even getting
 *      a chance).
 *   2. Runs the original resolver.
 *   3. Validates every returned IP against the ban list.
 *   4. Returns the result, or throws ERR_SANDBOX_NET_REFUSED.
 *
 * The test allow list bypasses both steps 1 and 3.
 */
function patchDnsLookup(): void {
  const origCallback = dns.lookup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns as any).lookup = function patchedLookup(
    hostname: string,
    optionsOrCb: any,
    maybeCb?: any,
  ): void {
    const callback = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    const options = typeof optionsOrCb === 'function' ? {} : optionsOrCb || {};

    if (typeof callback !== 'function') {
      // No callback — unusual but preserve original behaviour by
      // forwarding, since we can't refuse async without one.
      return (origCallback as any)(hostname, optionsOrCb, maybeCb);
    }

    const lowered = String(hostname).toLowerCase();
    if (BANNED_HOSTNAMES.has(lowered) && !allowedTestTargets.has(`${lowered}:*`)) {
      return process.nextTick(callback, refusal(hostname, 'banned hostname'));
    }

    (origCallback as any)(hostname, options, (err: any, address: any, family: any) => {
      if (err) return callback(err);
      const addrs = Array.isArray(address) ? address : [{ address, family }];
      for (const { address: a, family: f } of addrs) {
        const banned = f === 4 ? isBannedIPv4(a) : isBannedIPv6(a);
        if (banned && !isAllowedTestTarget(hostname, 0) && !isAllowedTestTarget(hostname, -1)) {
          return callback(refusal(`${hostname} (resolved ${a})`, 'banned IP'));
        }
      }
      callback(null, address, family);
    });
  };

  const origPromise = dns.promises.lookup;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns.promises as any).lookup = async function patchedPromiseLookup(
    hostname: string,
    options?: any,
  ): Promise<any> {
    const lowered = String(hostname).toLowerCase();
    if (BANNED_HOSTNAMES.has(lowered) && !allowedTestTargets.has(`${lowered}:*`)) {
      throw refusal(hostname, 'banned hostname');
    }
    const result = await (origPromise as any)(hostname, options);
    const addrs = Array.isArray(result) ? result : [result];
    for (const { address: a, family: f } of addrs) {
      const banned = f === 4 ? isBannedIPv4(a) : isBannedIPv6(a);
      if (banned && !isAllowedTestTarget(hostname, 0) && !isAllowedTestTarget(hostname, -1)) {
        throw refusal(`${hostname} (resolved ${a})`, 'banned IP');
      }
    }
    return result;
  };
}

// ── net.Socket.prototype.connect patch ──────────────────────────

/**
 * Wrap every TCP connect. The Node internals call this through
 * `net.connect`, `net.createConnection`, `http.Agent.createConnection`,
 * and every built-in HTTP client, so it's the single choke point
 * for literal-IP connections (which bypass `dns.lookup`).
 *
 * Hostname connects go through our `dns.lookup` patch above, but
 * we also validate them here — defence in depth.
 */
function patchSocketConnect(): void {
  const orig = net.Socket.prototype.connect;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (net.Socket.prototype as any).connect = function patchedConnect(
    this: netTypes.Socket,
    ...args: any[]
  ): netTypes.Socket {
    // Normalise the overloaded signature into a { host, port }
    // shape. Supports:
    //   connect(options, callback?)
    //   connect(port, host?, callback?)
    //   connect(path, callback?)  // Unix domain socket
    //   connect([options, callback])  // Node's pre-normalised form
    //     — used by net.createConnection, which calls
    //     `socket.connect(normalizeArgs(arguments))` with a
    //     single positional argument that is itself a tuple
    //     array. Without unwrapping this, every connection made
    //     via net.createConnection (and therefore every undici/
    //     fetch/axios/http-client connection to a literal IP)
    //     silently bypasses the ban list.
    let host: string | undefined;
    let port: number | undefined;
    let isUnixSocket = false;

    // Unwrap the pre-normalised form: single arg that is an array.
    let normArgs = args;
    if (args.length === 1 && Array.isArray(args[0])) {
      normArgs = args[0];
    }

    const first = normArgs[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      if (typeof first.path === 'string') {
        isUnixSocket = true;
      } else {
        host = first.host ?? '127.0.0.1';
        port = first.port;
      }
    } else if (typeof first === 'number') {
      port = first;
      host = typeof normArgs[1] === 'string' ? normArgs[1] : '127.0.0.1';
    } else if (typeof first === 'string') {
      // Single-argument path form — Unix socket
      isUnixSocket = true;
    }

    // Unix domain sockets: refuse outright. Nothing a user tool
    // should be doing talks to a Unix socket, and they can
    // reach our own backend's local services (Redis, Postgres)
    // on some Docker configurations.
    if (isUnixSocket) {
      const sock = this;
      process.nextTick(() =>
        sock.emit(
          'error',
          refusal('<unix socket>', 'unix domain sockets are not allowed'),
        ),
      );
      return sock;
    }

    if (host && port !== undefined) {
      // Test allow-list bypass: exact host:port match.
      if (isAllowedTestTarget(host, port)) {
        return orig.apply(this, args as any);
      }

      // Literal IP fast path.
      if (net.isIP(host)) {
        if (isBannedAddress(host)) {
          const sock = this;
          process.nextTick(() =>
            sock.emit(
              'error',
              refusal(`${host}:${port}`, 'banned IP literal'),
            ),
          );
          return sock;
        }
      } else {
        // Hostname. Pre-DNS ban-list check.
        if (BANNED_HOSTNAMES.has(host.toLowerCase())) {
          const sock = this;
          process.nextTick(() =>
            sock.emit(
              'error',
              refusal(`${host}:${port}`, 'banned hostname'),
            ),
          );
          return sock;
        }
        // Hostname resolution happens inside the underlying
        // connect via `dns.lookup`, which is also patched — so
        // if the hostname resolves to a banned IP the lookup
        // callback returns ERR_SANDBOX_NET_REFUSED and the
        // socket emits error. Nothing extra to do here.
      }
    }

    return orig.apply(this, args as any);
  };
}

// ── dgram patch ─────────────────────────────────────────────────

/**
 * UDP is less commonly used by npm packages than TCP, but it's
 * still a potential escape (DNS-over-UDP targeting an internal
 * resolver, NTP, SSDP discovery, etc.). Wrap `dgram.Socket.send`
 * and refuse destinations in the ban list.
 */
function patchDgram(): void {
  const OrigSocket = dgram.Socket;
  const origSend = OrigSocket.prototype.send;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (OrigSocket.prototype as any).send = function patchedSend(
    this: dgramTypes.Socket,
    ...args: any[]
  ): any {
    // dgram.send has ~6 overloads. The `port` and `address` args
    // can be at several positions. Walk args to find them.
    let port: number | undefined;
    let address: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a === 'number' && port === undefined) {
        port = a;
      } else if (typeof a === 'string' && address === undefined) {
        address = a;
      }
    }
    if (port !== undefined && address) {
      if (isAllowedTestTarget(address, port)) {
        return origSend.apply(this, args as any);
      }
      if (net.isIP(address)) {
        if (isBannedAddress(address)) {
          const err = refusal(`${address}:${port}`, 'banned UDP target');
          // Find the callback and invoke it with the error.
          const cb = args[args.length - 1];
          if (typeof cb === 'function') process.nextTick(cb, err);
          else process.nextTick(() => this.emit('error', err));
          return;
        }
      } else if (BANNED_HOSTNAMES.has(address.toLowerCase())) {
        const err = refusal(`${address}:${port}`, 'banned hostname');
        const cb = args[args.length - 1];
        if (typeof cb === 'function') process.nextTick(cb, err);
        else process.nextTick(() => this.emit('error', err));
        return;
      }
    }
    return origSend.apply(this, args as any);
  };
}
