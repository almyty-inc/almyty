/**
 * A loopback forward proxy that holds a child process to the SSRF floor.
 *
 * Some outbound traffic is made by a program we spawn rather than by our
 * own HTTP client: `npm install` against a tenant-configured registry is
 * the case that needs it. Checking the registry URL up front is not
 * enough, for three reasons:
 *
 *   - DNS rebinding. npm resolves the registry name again when it
 *     connects; a resolver that answered a public address to our check
 *     can answer `169.254.169.254` to npm.
 *   - Redirects. npm follows 3xx from the registry to any host.
 *   - Tarball URLs. A packument's `dist.tarball` is an absolute URL the
 *     registry chooses; npm fetches it wherever it points.
 *
 * Pointing the child at this proxy (`--proxy` / `--https-proxy`) routes
 * every one of those requests through one choke point. The proxy
 * resolves each target itself through the DNS-pinning lookup, classifies
 * the answer with the shared classifier, and connects to the address it
 * vetted — so there is no second resolution for a rebinding resolver to
 * answer differently. TLS stays end to end (CONNECT tunnels bytes); the
 * proxy sees host and port, never content or credentials.
 *
 * Bound to 127.0.0.1 on an ephemeral port for the lifetime of one child
 * process. Sandboxed tool code cannot reach it: the sandbox net guard
 * refuses loopback.
 */
import * as dns from 'dns';
import * as http from 'http';
import * as net from 'net';

import { classifyAddress, stripBrackets } from './ip-classification';
import { pinnedLookup } from './ssrf-safe-agent';
import { validateUrl } from './url-validator';

export interface EgressProxyOptions {
  /**
   * Hosts that may be reached even though they resolve to a private
   * address, matched exactly and case-insensitively. For a self-hosted
   * registry on the LAN; every other host is still held to the floor.
   */
  exemptHosts?: string[];
  /** Ports a CONNECT tunnel may open. Default: 443. */
  connectPorts?: number[];
  /** Ports a plain-HTTP forward may target. Default: 80. */
  httpPorts?: number[];
  /** Test seam: the resolver used for names that are not exempt. */
  lookup?: typeof pinnedLookup;
}

export interface EgressProxy {
  /** `http://127.0.0.1:<port>`, for `--proxy` / `--https-proxy`. */
  url: string;
  /** Targets refused so far, `host:port` each. For logs and tests. */
  refused: string[];
  close(): Promise<void>;
}

interface Vetted {
  address: string;
  family: number;
}

function lookupOnce(
  lookup: typeof pinnedLookup | typeof dns.lookup,
  host: string,
): Promise<Vetted> {
  return new Promise((resolve, reject) => {
    (lookup as any)(host, { all: false }, (err: Error | null, address: string, family: number) => {
      if (err) reject(err);
      else resolve({ address, family });
    });
  });
}

/** `host:port`, `[v6]:port` -> parts. */
function splitAuthority(authority: string): { host: string; port: number } | null {
  const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(authority);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  return { host: stripBrackets(m[1]).toLowerCase(), port };
}

export async function startEgressProxy(options: EgressProxyOptions = {}): Promise<EgressProxy> {
  const exempt = new Set((options.exemptHosts ?? []).map((h) => stripBrackets(h.toLowerCase())));
  const connectPorts = new Set(options.connectPorts ?? [443]);
  const httpPorts = new Set(options.httpPorts ?? [80]);
  const lookup = options.lookup ?? pinnedLookup;
  const refused: string[] = [];

  /** Resolve `host` to one address the server may connect to, or throw. */
  async function vet(host: string): Promise<Vetted> {
    if (exempt.has(host)) {
      return net.isIP(host) ? { address: host, family: net.isIP(host) } : lookupOnce(dns.lookup, host);
    }
    const verdict = classifyAddress(host);
    if (verdict.kind === 'blocked') throw new Error(`blocked address ${host}`);
    if (verdict.kind === 'public') return { address: host, family: net.isIP(host) };
    if (!validateUrl(`https://${host}/`).valid) throw new Error(`blocked host ${host}`);
    const vetted = await lookupOnce(lookup, host);
    // The pinning lookup already refuses a private answer; checking the
    // address actually returned keeps that true for any resolver passed in.
    if (classifyAddress(vetted.address).kind !== 'public') {
      throw new Error(`${host} resolved to a blocked address`);
    }
    return vetted;
  }

  const server = http.createServer((req, res) => {
    // Plain-HTTP forward: the request line carries an absolute URL.
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const host = stripBrackets(target.hostname.toLowerCase());
    const port = Number(target.port || 80);
    const key = `${host}:${port}`;
    if (target.protocol !== 'http:' || !httpPorts.has(port)) {
      refused.push(key);
      res.writeHead(403).end();
      return;
    }
    vet(host).then(
      ({ address, family }) => {
        const headers = { ...req.headers };
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const upstream = http.request(
          {
            host: address,
            family,
            port,
            method: req.method,
            path: `${target.pathname}${target.search}`,
            headers,
            setHost: false,
          },
          (up) => {
            res.writeHead(up.statusCode ?? 502, up.headers);
            up.pipe(res);
          },
        );
        upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end());
        req.pipe(upstream);
      },
      () => {
        refused.push(key);
        res.writeHead(403).end();
      },
    );
  });

  server.on('connect', (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    const parts = splitAuthority(req.url ?? '');
    const key = req.url ?? '';
    const deny = () => {
      refused.push(key);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    };
    if (!parts || !connectPorts.has(parts.port)) return deny();
    vet(parts.host).then(
      ({ address }) => {
        const upstream = net.connect(parts.port, address, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
      },
      deny,
    );
  });

  // CONNECT tunnels are detached from the HTTP server's bookkeeping, so
  // `close()` tracks raw sockets itself rather than waiting on npm to hang up.
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    refused,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      }),
  };
}
