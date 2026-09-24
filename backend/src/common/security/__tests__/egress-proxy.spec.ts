import * as http from 'http';
import * as net from 'net';

import { EgressProxy, startEgressProxy } from '../egress-proxy';

/**
 * The egress proxy is what holds a spawned `npm install` to the SSRF floor
 * across DNS re-resolution, redirects and registry-chosen tarball URLs.
 * These tests drive it over real sockets on loopback.
 */

/** Send a CONNECT and return the proxy's status line. */
function connectVia(proxy: EgressProxy, authority: string): Promise<string> {
  const { port } = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n')) {
        socket.destroy();
        resolve(buf.split('\r\n')[0]);
      }
    });
    socket.on('error', reject);
    socket.on('end', () => resolve(buf.split('\r\n')[0]));
  });
}

/** Send a plain-HTTP proxied GET for an absolute URL; resolve status + body. */
function getVia(proxy: EgressProxy, url: string): Promise<{ status: number; body: string }> {
  const { port } = new URL(proxy.url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: Number(port), method: 'GET', path: url, headers: { host: new URL(url).host } },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A resolver that answers every name with `address`. */
const resolveTo =
  (address: string) =>
  (_host: string, _opts: unknown, cb: (e: Error | null, a: string, f: number) => void): void =>
    cb(null, address, net.isIP(address));

describe('startEgressProxy', () => {
  let proxy: EgressProxy | undefined;
  afterEach(async () => {
    await proxy?.close();
    proxy = undefined;
  });

  describe('CONNECT (https)', () => {
    it('refuses a private or loopback literal, in any IPv6 spelling', async () => {
      proxy = await startEgressProxy();
      for (const target of ['127.0.0.1:443', '169.254.169.254:443', '[::ffff:a9fe:a9fe]:443', '[64:ff9b::a00:1]:443', '[::1]:443']) {
        expect(await connectVia(proxy, target)).toMatch(/403/);
      }
    });

    it('refuses a blocked metadata hostname before resolving it', async () => {
      proxy = await startEgressProxy({ lookup: resolveTo('93.184.215.14') as never });
      expect(await connectVia(proxy, 'metadata.google.internal:443')).toMatch(/403/);
    });

    it('refuses a public name whose resolver answers a private address (rebinding)', async () => {
      proxy = await startEgressProxy({ lookup: resolveTo('10.0.0.7') as never });
      expect(await connectVia(proxy, 'registry.rebind.example:443')).toMatch(/403/);
      expect(proxy.refused).toContain('registry.rebind.example:443');
    });

    it('refuses a port that is not on the list', async () => {
      proxy = await startEgressProxy({ lookup: resolveTo('93.184.215.14') as never });
      expect(await connectVia(proxy, 'registry.example.com:6379')).toMatch(/403/);
    });

    it('tunnels to an exempt host, and only to it', async () => {
      const echo = net.createServer((s) => s.pipe(s));
      await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
      const echoPort = (echo.address() as net.AddressInfo).port;
      try {
        proxy = await startEgressProxy({ exemptHosts: ['127.0.0.1'], connectPorts: [echoPort] });
        expect(await connectVia(proxy, `127.0.0.1:${echoPort}`)).toMatch(/200/);
        expect(await connectVia(proxy, `[::1]:${echoPort}`)).toMatch(/403/);
      } finally {
        echo.close();
      }
    });
  });

  describe('plain HTTP forward', () => {
    it('refuses a redirect-style hop to a private host', async () => {
      proxy = await startEgressProxy();
      expect((await getVia(proxy, 'http://169.254.169.254/latest/meta-data/')).status).toBe(403);
      expect((await getVia(proxy, 'http://[::ffff:7f00:1]/')).status).toBe(403);
    });

    it('refuses a tarball URL on a name that resolves privately', async () => {
      proxy = await startEgressProxy({ lookup: resolveTo('192.168.1.10') as never });
      expect((await getVia(proxy, 'http://tarballs.evil.example/pkg.tgz')).status).toBe(403);
    });

    it('forwards to an exempt host', async () => {
      const upstream = http.createServer((_req, res) => res.end('ok'));
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
      const port = (upstream.address() as net.AddressInfo).port;
      try {
        proxy = await startEgressProxy({ exemptHosts: ['127.0.0.1'], httpPorts: [port] });
        expect(await getVia(proxy, `http://127.0.0.1:${port}/x`)).toEqual({ status: 200, body: 'ok' });
      } finally {
        upstream.close();
      }
    });
  });
});
