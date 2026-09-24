/**
 * Network egress guard for the sandbox worker.
 *
 * Node's `--permission` model gives us kernel-adjacent control of
 * the filesystem, child_process, worker_threads, and native addon
 * loading — but its `--allow-net` flag is all-or-nothing. There's
 * no `--allow-net=<host>` or `--deny-net=<cidr>` primitive. That's
 * what this module provides: a set of monkey-patches applied to
 * `dns.lookup`, the c-ares resolvers, `net.Socket.prototype.connect`,
 * and `dgram` **before any user code runs**, so every outbound connection
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
const tls = require('tls');
const http = require('http');
const https = require('https');
const http2 = require('http2');
import type * as netTypes from 'net';
import type * as dgramTypes from 'dgram';
import {
  classifyAddress,
  isBlockedAddress,
  isBlockedHostname,
  stripBrackets,
} from '../../../common/security/ip-classification';
import { decideToolRequest, domainMatches } from '../../../common/security/gateway-tool-policy';
import type { SandboxNetPolicy } from './types';

// ── Ban list ────────────────────────────────────────────────────

/**
 * The ranges and hostnames live in `common/security/ip-classification.ts`,
 * shared with the host-side URL validator and DNS-pinning agents, so the
 * sandbox and the server cannot disagree about what is private.
 *
 * This file used to carry its own copy. Its IPv6 half was first a
 * lowercase string-prefix match, which missed the expanded and hex
 * spellings of IPv4-mapped loopback and metadata; then a `net.BlockList`,
 * which fixed the mapped form (BlockList normalises `::ffff:0:0/96` back
 * to IPv4) but still passed the IPv4-compatible `::a.b.c.d`, SIIT, 6to4
 * and Teredo forms, none of which BlockList unwraps. The shared classifier
 * parses the address and unwraps or bans every one of them.
 *
 * The sandbox worker loads this module under Node's permission model; the
 * compiled classifier is granted a file-scoped read in
 * `NodeSandboxService.buildWorkerExecArgv` for exactly that reason.
 */

/**
 * Classify a literal IP address. Returns `true` if the address is
 * in any banned range. Non-IPs return `false` (let the caller
 * decide) — this is intended to be composed with `net.isIP`.
 */
export function isBannedAddress(ip: string): boolean {
  return isBlockedAddress(ip);
}

/**
 * A resolver answer. Anything but a public IP literal is refused: an
 * answer that does not parse as an address is not something to connect to.
 */
function isBannedAnswer(ip: string): boolean {
  return classifyAddress(ip).kind !== 'public';
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
  /**
   * The host restrictions of the gateway tool this execution runs for
   * (`gateway_tools.securityPolicy`). See `policyRefusal`.
   */
  hostPolicy?: SandboxHostPolicy | null;
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

// ── Gateway host policy ─────────────────────────────────────────

/**
 * A JavaScript or SDK tool run through a gateway used to be held only to
 * the SSRF floor. The gateway tool's `securityPolicy` -- allowed and
 * blocked domains -- was enforced on HTTP/GraphQL/SOAP/gRPC tools by the
 * host-side executors, but a sandboxed tool's own `fetch` (or any npm
 * client it loaded) never met it, so an allow-list of `api.example.com`
 * did not stop the tool calling anything else on the internet.
 *
 * The policy is enforced here, at the same choke points as the ban list,
 * with the same `domainMatches` the executors use. Hostnames are checked
 * where they are visible (lookup, resolver queries, connect). A literal
 * address passes an allow-list only if it is itself listed or a name the
 * policy allowed resolved to it -- the latter so a client that resolves
 * first and connects by address still works.
 *
 * `requireHttps` and `allowedHttpMethods` are enforced here too (see
 * `transportRefusal` and `patchHttpClients`). They were left to the
 * executors on the grounds that a socket shows neither, which left a
 * sandboxed tool free of both: it could send a DELETE a GET-only policy
 * forbids, in plaintext, to a host the policy allowed.
 */
export type SandboxHostPolicy = SandboxNetPolicy;

let hostPolicy: SandboxHostPolicy | null = null;
const policyVettedAddresses = new Set<string>();

/**
 * The HTTP-level half of the policy. `requireHttps` is held at two
 * layers: every TCP connect must be a TLS socket (so no client, however
 * it builds its requests, can speak plaintext), and every request made
 * through fetch / http / https / http2 must name https. The method list
 * is held where a method is visible: those same request entry points.
 */
let transportPolicy: { requireHttps: boolean; allowedHttpMethods: string[] } | null = null;

function policyRefusal(host: string): string | null {
  if (!hostPolicy) return null;
  const h = stripBrackets(String(host).toLowerCase());
  if (net.isIP(h) && policyVettedAddresses.has(h)) return null;
  const blocked = (hostPolicy.blockedDomains ?? []).filter(Boolean);
  if (blocked.some((pattern) => domainMatches(h, pattern))) {
    return "on this gateway tool's blocked-domain list";
  }
  const allowed = (hostPolicy.allowedDomains ?? []).filter(Boolean);
  if (allowed.length > 0 && !allowed.some((pattern) => domainMatches(h, pattern))) {
    return "not on this gateway tool's allowed-domain list";
  }
  return null;
}

/**
 * The scheme and method rules for one HTTP request, decided by the same
 * `decideToolRequest` the host-side executors use. The domain rules are
 * left to the connect / lookup patches, which see every connection.
 */
function transportRefusal(url: string, method: string): string | null {
  if (!transportPolicy) return null;
  const decision = decideToolRequest(transportPolicy, url, method);
  return decision.allowed ? null : (decision.reason ?? 'refused by security policy');
}

function rememberPolicyAddresses(addrs: Array<{ address: string }>): void {
  if (!hostPolicy) return;
  for (const { address } of addrs) {
    if (typeof address === 'string') policyVettedAddresses.add(address.toLowerCase());
  }
}

// ── Patches ─────────────────────────────────────────────────────

let installed = false;
/**
 * Once set, neither `installSandboxNetGuard`'s testAllow nor
 * `resetSandboxNetGuardForTesting` may change the guard's state.
 * See `lockSandboxNetGuard`.
 */
let locked = false;

/**
 * Install the monkey-patches on `net.Socket.prototype.connect`,
 * `dns.lookup`, `dns.promises.lookup`, the c-ares resolvers (server
 * changes and answers, see patchDnsResolvers), `dgram`, and the HTTP
 * request entry points (fetch, http, https, http2; see patchHttpClients).
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
    if (locked) {
      throw new Error('Sandbox net guard is locked; testAllow is refused.');
    }
    allowedTestTargets = new Set(
      options.testAllow
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const allowed = (options.hostPolicy?.allowedDomains ?? []).filter(Boolean);
  const blocked = (options.hostPolicy?.blockedDomains ?? []).filter(Boolean);
  hostPolicy =
    allowed.length > 0 || blocked.length > 0
      ? { allowedDomains: [...allowed], blockedDomains: [...blocked] }
      : null;

  const requireHttps = options.hostPolicy?.requireHttps === true;
  const allowedHttpMethods = (options.hostPolicy?.allowedHttpMethods ?? [])
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => m.trim().toUpperCase());
  transportPolicy =
    requireHttps || allowedHttpMethods.length > 0 ? { requireHttps, allowedHttpMethods } : null;

  patchDnsLookup();
  patchDnsResolvers();
  patchSocketConnect();
  patchDgram();
  patchHttpClients();
}

/**
 * Seal the guard's mutable state. Called by the sandbox worker once
 * the guard is installed and before any user code runs.
 *
 * Without this, sandboxed code could turn the guard off from inside
 * it. The guard lives in the same realm and the same CJS module cache
 * as the user's tool code, and both of the functions above it are
 * module exports, so this was a live, confirmed SSRF:
 *
 *     const { createRequire } = await import('node:module');
 *     const r = createRequire('/x.js');
 *     const g = r.cache[Object.keys(r.cache)
 *       .find(k => k.includes('sandbox-net-guard'))].exports;
 *     g.resetSandboxNetGuardForTesting();                     // installed = false
 *     g.installSandboxNetGuard({ testAllow: '127.0.0.1:*' }); // blanket allow
 *     await fetch('http://127.0.0.1:6379/');                  // reached
 *
 * Re-installing does not un-patch anything; the damage was that
 * `allowedTestTargets` is module-level state read by every patch
 * closure, so setting it once opened every layer at once — and
 * `isAllowedTestTarget` honours `host:*` and `*:port`, so one call
 * opened a whole class of targets.
 *
 * The module-resolution hook in the worker now also refuses
 * `import('node:module')`, which is how the snippet above got its
 * hands on the cache. This is the second lock on the same door: a
 * fresh copy of this module obtained some other way re-patches on top
 * of the existing patches, so the original guard still runs
 * underneath — but only as long as it cannot be told to allow.
 */
export function lockSandboxNetGuard(): void {
  locked = true;
}

/**
 * Exposed for tests that want to reset state between runs. Refuses
 * once the guard is locked, which is what the sandbox worker does
 * before handing control to user code.
 */
export function resetSandboxNetGuardForTesting(): void {
  if (locked) {
    throw new Error('Sandbox net guard is locked; reset is refused.');
  }
  installed = false;
  allowedTestTargets = new Set();
  hostPolicy = null;
  transportPolicy = null;
  policyVettedAddresses.clear();
}

// ── dns.lookup patch ────────────────────────────────────────────

/**
 * Wrap `dns.lookup` and `dns.promises.lookup`. The patch:
 *
 *   1. Refuses blocked hostnames (isBlockedHostname) before calling the
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
    const policyReason = policyRefusal(lowered);
    if (policyReason) {
      return process.nextTick(callback, refusal(hostname, policyReason));
    }
    if (isBlockedHostname(lowered) && !allowedTestTargets.has(`${lowered}:*`)) {
      return process.nextTick(callback, refusal(hostname, 'banned hostname'));
    }

    (origCallback as any)(hostname, options, (err: any, address: any, family: any) => {
      if (err) return callback(err);
      const addrs = Array.isArray(address) ? address : [{ address, family }];
      for (const { address: a } of addrs) {
        const banned = isBannedAnswer(a);
        if (banned && !isAllowedTestTarget(hostname, 0) && !isAllowedTestTarget(hostname, -1)) {
          return callback(refusal(`${hostname} (resolved ${a})`, 'banned IP'));
        }
      }
      rememberPolicyAddresses(addrs);
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
    const policyReason = policyRefusal(lowered);
    if (policyReason) throw refusal(hostname, policyReason);
    if (isBlockedHostname(lowered) && !allowedTestTargets.has(`${lowered}:*`)) {
      throw refusal(hostname, 'banned hostname');
    }
    const result = await (origPromise as any)(hostname, options);
    const addrs = Array.isArray(result) ? result : [result];
    for (const { address: a } of addrs) {
      const banned = isBannedAnswer(a);
      if (banned && !isAllowedTestTarget(hostname, 0) && !isAllowedTestTarget(hostname, -1)) {
        throw refusal(`${hostname} (resolved ${a})`, 'banned IP');
      }
    }
    rememberPolicyAddresses(addrs);
    return result;
  };
}

// ── c-ares resolver patches ─────────────────────────────────────

/**
 * `dns.lookup` is getaddrinfo. Everything else in `dns` -- `resolve4`,
 * `resolve6`, `resolve`, `resolveAny` and the rest, on the module, on
 * `dns.promises`, and on any `new dns.Resolver()` -- is c-ares, which the
 * lookup patch above never sees. Two things went round the guard that
 * way:
 *
 *   1. `setServers`. c-ares opens its own UDP and TCP sockets in C, so
 *      neither the dgram patch nor the Socket#connect patch sees them.
 *      Pointing a resolver at `10.0.0.5:6379` and resolving an
 *      attacker-chosen name was a packet channel to any internal
 *      host:port.
 *   2. The answers. A resolver hands back internal addresses the lookup
 *      patch would have refused.
 *
 * (1) is closed at the one place every server change goes through: the
 * native `ChannelWrap.prototype.setServers`, which `Resolver#setServers`,
 * `dns.setServers` and `dns.promises.setServers` all end in. Patching the
 * JS-level `setServers` instead would leave `resolver._handle.setServers`
 * as a way round it. A server is accepted if it is one the host was
 * already configured with when the guard was installed (those are
 * usually private -- a VPC resolver, kube-dns, systemd-resolved -- and
 * asking them is exactly what `dns.lookup` does anyway), a public
 * address, or a test-harness allow-list entry.
 *
 * (2) is closed by wrapping every query method on both Resolver
 * prototypes and on both module objects, and refusing an answer that
 * contains a banned address. That half is defence in depth: a banned
 * address learned from DNS still cannot be connected to, because
 * Socket#connect refuses the literal.
 */

type ServerEntry = [number, string, number];

/** `ip:port` for every resolver the host had when the guard went in. */
let systemDnsServers: Set<string> = new Set();

function dnsServerKey(ip: string, port: number): string {
  return `${String(ip).toLowerCase()}:${port}`;
}

function isAllowedDnsServer(ip: string, port: number): boolean {
  if (systemDnsServers.has(dnsServerKey(ip, port))) return true;
  if (isAllowedTestTarget(ip, port)) return true;
  if (!net.isIP(ip)) return false;
  return !isBannedAddress(ip);
}

/** The first banned address in a resolver answer, or null. */
function bannedAddressInAnswer(result: unknown): string | null {
  const items = Array.isArray(result) ? result : [result];
  for (const item of items) {
    const address =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? (item as { address?: unknown }).address
          : undefined;
    if (typeof address === 'string' && net.isIP(address) && isBannedAddress(address)) {
      return address;
    }
  }
  return null;
}

/**
 * Wrap one query method. Handles both the callback form (last argument
 * is a function) and the promise form. The caller's callback is invoked
 * without a receiver: the original calls it with `this` set to the
 * native QueryReqWrap, which would hand user code the request class.
 */
function wrapResolverQuery(orig: (...a: any[]) => any): (...a: any[]) => any {
  return function patchedResolverQuery(this: unknown, ...args: any[]): any {
    const name = String(args[0]);
    const lowered = name.toLowerCase();
    const last = args.length - 1;
    const cb = last >= 0 && typeof args[last] === 'function' ? args[last] : null;
    const answerExempt = isAllowedTestTarget(name, 0) || isAllowedTestTarget(name, -1);

    const policyReason = policyRefusal(lowered);
    if (policyReason) {
      const err = refusal(name, policyReason);
      if (cb) {
        process.nextTick(() => cb(err));
        return undefined;
      }
      return Promise.reject(err);
    }

    if (isBlockedHostname(lowered) && !allowedTestTargets.has(`${lowered}:*`)) {
      const err = refusal(name, 'banned hostname');
      if (cb) {
        process.nextTick(() => cb(err));
        return undefined;
      }
      return Promise.reject(err);
    }

    if (cb) {
      args[last] = (err: any, result: any, ...rest: any[]) => {
        if (err) return cb(err);
        const hit = answerExempt ? null : bannedAddressInAnswer(result);
        if (hit) return cb(refusal(`${name} (resolved ${hit})`, 'banned IP'));
        return cb(null, result, ...rest);
      };
      return orig.apply(this, args);
    }

    const out = orig.apply(this, args);
    if (out && typeof out.then === 'function') {
      return out.then((result: any) => {
        const hit = answerExempt ? null : bannedAddressInAnswer(result);
        if (hit) throw refusal(`${name} (resolved ${hit})`, 'banned IP');
        return result;
      });
    }
    return out;
  };
}

const RESOLVER_QUERY_METHOD = /^(resolve|reverse)/;

function wrapQueryMethodsOn(target: any): void {
  for (const key of Object.getOwnPropertyNames(target)) {
    if (!RESOLVER_QUERY_METHOD.test(key)) continue;
    const orig = target[key];
    if (typeof orig !== 'function') continue;
    target[key] = wrapResolverQuery(orig);
  }
}

function patchDnsResolvers(): void {
  const probe = new dns.Resolver();
  const channelProto = Object.getPrototypeOf(probe._handle);

  systemDnsServers = new Set(
    (probe._handle.getServers() || []).map(([ip, port]: [string, number]) =>
      dnsServerKey(ip, port),
    ),
  );

  const origSetServers = channelProto.setServers;
  channelProto.setServers = function patchedChannelSetServers(
    this: unknown,
    servers: ServerEntry[],
    ...rest: any[]
  ): any {
    for (const entry of Array.isArray(servers) ? servers : []) {
      const ip = Array.isArray(entry) ? entry[1] : undefined;
      const port = Array.isArray(entry) ? entry[2] : undefined;
      if (typeof ip !== 'string' || typeof port !== 'number' || !isAllowedDnsServer(ip, port)) {
        throw refusal(`DNS server ${ip}:${port}`, 'not an allowed resolver');
      }
    }
    return origSetServers.call(this, servers, ...rest);
  };

  // The prototypes the `new dns.Resolver()` / `new dns.promises.Resolver()`
  // instances use. The query methods are own properties of each.
  wrapQueryMethodsOn(dns.Resolver.prototype);
  wrapQueryMethodsOn(dns.promises.Resolver.prototype);
  // The module-level functions were bound to the ORIGINAL prototype
  // methods when `dns` loaded, so they are separate objects to wrap. (A
  // later `dns.setServers` re-binds them from the prototypes above, which
  // are wrapped by then.)
  wrapQueryMethodsOn(dns);
  wrapQueryMethodsOn(dns.promises);
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
        // A caller-supplied `lookup` bypasses our patched dns.lookup
        // (and therefore the post-resolution IP ban check), letting a
        // hostname resolve to an internal/metadata IP unchecked. Force
        // the default (patched) resolver.
        if (first.lookup) delete first.lookup;
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

    // requireHttps, held where no client can route round it: every TCP
    // connection must be a TLS socket. `tls.connect` (https, undici's
    // fetch, http2, every TLS database driver) calls connect on the
    // TLSSocket itself; a plain `net.Socket` here is plaintext. A
    // STARTTLS protocol (a TLS upgrade after a plaintext greeting) is
    // plaintext first and is refused too: the policy says HTTPS.
    if (transportPolicy?.requireHttps && !(this instanceof tls.TLSSocket)) {
      const sock = this;
      const target = host && port !== undefined ? `${host}:${port}` : '<socket>';
      process.nextTick(() =>
        sock.emit('error', refusal(target, 'this gateway tool requires HTTPS; a plaintext connection is refused')),
      );
      return sock;
    }

    if (host && port !== undefined) {
      // The gateway's host policy comes first and has no test bypass:
      // it narrows what the tool may reach, it never widens it.
      const policyReason = policyRefusal(host);
      if (policyReason) {
        const sock = this;
        process.nextTick(() =>
          sock.emit('error', refusal(`${host}:${port}`, policyReason)),
        );
        return sock;
      }
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
        if (isBlockedHostname(host.toLowerCase())) {
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
    // UDP is never HTTPS.
    if (transportPolicy?.requireHttps) {
      const err = refusal(`${address ?? '<connected>'}:${port ?? '?'}`, 'this gateway tool requires HTTPS; UDP is refused');
      const cb = args[args.length - 1];
      if (typeof cb === 'function') process.nextTick(cb, err);
      else process.nextTick(() => this.emit('error', err));
      return;
    }
    if (port !== undefined && address) {
      const policyReason = policyRefusal(address);
      if (policyReason) {
        const err = refusal(`${address}:${port}`, policyReason);
        const cb = args[args.length - 1];
        if (typeof cb === 'function') process.nextTick(cb, err);
        else process.nextTick(() => this.emit('error', err));
        return;
      }
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
      } else if (isBlockedHostname(address.toLowerCase())) {
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

// ── HTTP request entry points ───────────────────────────────────

const SESSION_PATCHED = Symbol('sandboxHttp2SessionPatched');

/** Best-effort absolute URL for a policy decision; the scheme is what matters. */
function policyUrl(protocol: string, host: string | undefined): string {
  const scheme = protocol.endsWith(':') ? protocol : `${protocol}:`;
  const h = stripBrackets(String(host ?? '')).replace(/:\d+$/, '') || 'unknown';
  const shown = net.isIP(h) === 6 ? `[${h}]` : h;
  try {
    return new URL(`${scheme}//${shown}/`).href;
  } catch {
    return `${scheme}//unknown/`;
  }
}

/** Method and target of an `http.request` / `https.request` / `.get` call. */
function describeNodeRequest(defaultProtocol: string, args: any[]): { url: string; method: string } {
  let base: URL | null = null;
  let i = 0;
  if (typeof args[0] === 'string' || args[0] instanceof URL) {
    try {
      base = new URL(String(args[0]));
    } catch {
      base = null;
    }
    i = 1;
  }
  const opts = args[i] && typeof args[i] === 'object' ? args[i] : {};
  const method = String(opts.method ?? 'GET').toUpperCase();
  const protocol = String(opts.protocol ?? base?.protocol ?? opts.agent?.protocol ?? defaultProtocol);
  const host = opts.hostname ?? opts.host ?? base?.hostname;
  return { url: policyUrl(protocol, host), method };
}

/** Method and target of a `fetch(input, init)` call. */
function describeFetch(input: any, init: any): { url: string; method: string } {
  const isRequest =
    !!input && typeof input === 'object' && !(input instanceof URL) && typeof input.url === 'string';
  const url = isRequest ? input.url : String(input);
  const method = String(init?.method ?? (isRequest ? input.method : undefined) ?? 'GET').toUpperCase();
  return { url, method };
}

/** The origin an `http2.connect(authority)` call names. */
function describeAuthority(authority: any): string {
  if (typeof authority === 'string') return authority;
  if (authority instanceof URL) return authority.href;
  if (authority && typeof authority === 'object') {
    return policyUrl(String(authority.protocol ?? 'https:'), authority.hostname ?? authority.host);
  }
  return 'https://unknown/';
}

/**
 * Hold every HTTP request a tool makes to the gateway tool's scheme and
 * method rules. These are the entry points that know a method: the
 * `fetch` global (undici), `http` / `https` `request` and `get` (which
 * axios, node-fetch, got, the AWS and Stripe SDKs and most others sit
 * on), and `http2` sessions. A refused call throws (or, for fetch,
 * rejects) with ERR_SANDBOX_NET_REFUSED before any byte is sent.
 *
 * The patches are installed whatever the policy and decide at call time,
 * like the rest of the guard. After patching, the ESM views of the
 * built-ins are re-synced so `import { request } from 'node:https'` in
 * an installed dependency sees the patched function too.
 */
function patchHttpClients(): void {
  const guardNodeModule = (mod: any, defaultProtocol: string) => {
    for (const name of ['request', 'get']) {
      const orig = mod[name];
      mod[name] = function patchedHttpRequest(this: unknown, ...args: any[]) {
        const { url, method } = describeNodeRequest(defaultProtocol, args);
        const reason = transportRefusal(url, method);
        if (reason) throw refusal(`${method} ${url}`, reason);
        return orig.apply(this, args);
      };
    }
  };
  guardNodeModule(http, 'http:');
  guardNodeModule(https, 'https:');

  const origFetch = (globalThis as any).fetch;
  if (typeof origFetch === 'function') {
    (globalThis as any).fetch = function patchedFetch(this: unknown, input: any, init?: any) {
      const { url, method } = describeFetch(input, init);
      const reason = transportRefusal(url, method);
      if (reason) return Promise.reject(refusal(`${method} ${url}`, reason));
      return origFetch.call(this, input, init);
    };
  }

  // http2 has no module-level request: a method is chosen per stream on
  // a session. The session class is not exported, so its prototype is
  // patched from the first session made, before that session is handed
  // back -- no code can hold a session whose class is still unpatched.
  const sessionOrigins = new WeakMap<object, string>();
  const origConnect = http2.connect;
  http2.connect = function patchedHttp2Connect(this: unknown, authority: any, ...rest: any[]) {
    const session = origConnect.call(this, authority, ...rest);
    sessionOrigins.set(session, describeAuthority(authority));
    const proto = Object.getPrototypeOf(session);
    if (proto && !Object.prototype.hasOwnProperty.call(proto, SESSION_PATCHED)) {
      const origRequest = proto.request;
      proto.request = function patchedHttp2Request(this: object, headers: any, ...more: any[]) {
        const origin = sessionOrigins.get(this) ?? 'https://unknown/';
        const method = String(headers?.[':method'] ?? 'GET').toUpperCase();
        const reason = transportRefusal(origin, method);
        if (reason) throw refusal(`${method} ${origin}`, reason);
        return origRequest.call(this, headers, ...more);
      };
      Object.defineProperty(proto, SESSION_PATCHED, { value: true });
    }
    return session;
  };

  require('module').syncBuiltinESMExports();
}
