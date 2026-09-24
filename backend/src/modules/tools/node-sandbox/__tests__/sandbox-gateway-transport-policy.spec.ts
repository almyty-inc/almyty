import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';
import type { SandboxNetPolicy } from '../types';

/**
 * A gateway tool's `requireHttps` and `allowedHttpMethods` reach a
 * sandboxed tool's own traffic.
 *
 * The net guard held a JavaScript or SDK tool to the policy's domains and
 * nothing else: its comment said scheme and method are HTTP-level and a
 * socket cannot see them. So a tool on a GET-only, HTTPS-only gateway
 * could send a plaintext DELETE to any host the policy allowed.
 *
 * Real workers, against loopback servers the test-only allow list lets
 * through the SSRF floor. `http`, `https`, `http2` and `net` are not on
 * the tool's own module allowlist, so they arrive the way a real tool
 * gets them: through an installed dependency (a one-line fixture package
 * that re-exports them).
 */
jest.setTimeout(60_000);

describe('sandboxed tool code is held to the gateway scheme and method rules', () => {
  let service: NodeSandboxService;
  let depsDir: string;

  // A plain HTTP server that records every request it answers.
  let httpServer: http.Server;
  let httpPort: number;
  const seen: string[] = [];

  // A raw TCP server that records the first byte of each connection:
  // 0x16 is a TLS handshake record, so it tells TLS from plaintext
  // without needing a certificate.
  let rawServer: net.Server;
  let rawPort: number;
  const firstBytes: number[] = [];

  beforeAll(async () => {
    depsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-transport-')));
    const pkg = path.join(depsDir, 'node_modules', 'net-clients');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'net-clients', version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(
      path.join(pkg, 'index.js'),
      "module.exports = { http: require('http'), https: require('https'), http2: require('http2'), net: require('net') };\n",
    );
    service = new NodeSandboxService({
      ensureInstalled: jest.fn().mockResolvedValue({ installDir: depsDir, cached: true, installTimeMs: 0 }),
      listCached: jest.fn().mockReturnValue([]),
      clearCache: jest.fn(),
    } as unknown as DependencyManagerService);

    httpServer = http.createServer((req, res) => {
      seen.push(req.method ?? '?');
      res.end('reached');
    });
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    httpPort = (httpServer.address() as net.AddressInfo).port;

    rawServer = net.createServer((sock) => {
      sock.once('data', (chunk: Buffer) => {
        firstBytes.push(chunk[0]);
        sock.destroy();
      });
      sock.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => rawServer.listen(0, '127.0.0.1', resolve));
    rawPort = (rawServer.address() as net.AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
    fs.rmSync(depsDir, { recursive: true, force: true });
  });

  const run = (code: string, hostPolicy: SandboxNetPolicy | null) =>
    service.execute({
      code:
        `const { http, https, http2, net } = require('net-clients');\n` +
        `const HTTP = 'http://127.0.0.1:${httpPort}/'; const RAW_PORT = ${rawPort};\n${code}`,
      parameters: {},
      dependencies: { 'net-clients': '1.0.0' },
      timeoutMs: 15_000,
      memoryLimitMb: 64,
      testNetAllow: `127.0.0.1:${httpPort},127.0.0.1:${rawPort}`,
      hostPolicy,
    });

  const nodeRequest = (mod: string, url: string, method: string) => `
    return await new Promise((resolve, reject) => {
      const req = ${mod}.request(${url}, { method: '${method}', rejectUnauthorized: false }, (res) => {
        let body = ''; res.on('data', (c) => body += c); res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });`;

  describe('allowedHttpMethods', () => {
    const GET_ONLY: SandboxNetPolicy = { allowedHttpMethods: ['get'] };

    it('lets a method through when no policy restricts methods', async () => {
      const before = seen.length;
      const result = await run(`return await (await fetch(HTTP, { method: 'POST' })).text();`, null);
      expect(result.data).toBe('reached');
      expect(seen.slice(before)).toEqual(['POST']);
    });

    it('lets an allowed method through fetch', async () => {
      const result = await run(`return await (await fetch(HTTP)).text();`, GET_ONLY);
      expect(result.data).toBe('reached');
    });

    it.each([
      ['fetch with a method', `return await (await fetch(HTTP, { method: 'POST' })).text();`],
      ['fetch with a Request', `return await (await fetch(new Request(HTTP, { method: 'DELETE' }))).text();`],
      ['http.request', nodeRequest('http', 'HTTP', 'PUT')],
      [
        'an http2 session',
        `const s = http2.connect(HTTP); s.on('error', () => {});
         try { s.request({ ':method': 'POST', ':path': '/' }); } finally { s.destroy(); }
         return 'sent';`,
      ],
    ])('refuses a disallowed method through %s', async (_name, code) => {
      const before = seen.length;
      const result = await run(code, GET_ONLY);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Sandbox refused/);
      expect(result.error).toMatch(/not an allowed method/);
      expect(seen.length).toBe(before);
    });

    it('lets an allowed method through http.get', async () => {
      const result = await run(
        `return await new Promise((resolve, reject) => {
           http.get(HTTP, (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve(b)); }).on('error', reject);
         });`,
        GET_ONLY,
      );
      expect(result.data).toBe('reached');
    });
  });

  describe('requireHttps', () => {
    const HTTPS_ONLY: SandboxNetPolicy = { requireHttps: true };

    it.each([
      ['fetch', `return await (await fetch(HTTP)).text();`],
      ['http.request', nodeRequest('http', 'HTTP', 'GET')],
    ])('refuses a plaintext request through %s', async (_name, code) => {
      const before = seen.length;
      const result = await run(code, HTTPS_ONLY);
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Sandbox refused/);
      expect(result.error).toMatch(/requires HTTPS/);
      expect(seen.length).toBe(before);
    });

    it('refuses a plaintext socket, whatever protocol it would carry', async () => {
      const before = firstBytes.length;
      const result = await run(
        `return await new Promise((resolve, reject) => {
           const s = net.connect(RAW_PORT, '127.0.0.1', () => { s.write('hello'); resolve('connected'); });
           s.on('error', reject);
         });`,
        HTTPS_ONLY,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/plaintext connection is refused/);
      await new Promise((r) => setTimeout(r, 100));
      expect(firstBytes.length).toBe(before);
    });

    it.each([
      ['fetch', `try { await fetch('https://127.0.0.1:' + RAW_PORT + '/'); } catch (e) { return 'tls attempted'; } return 'tls attempted';`],
      [
        'https.request',
        `try { ${nodeRequest('https', "'https://127.0.0.1:' + RAW_PORT + '/'", 'GET').replace('return await', 'await')} } catch (e) {}
         return 'tls attempted';`,
      ],
    ])('lets a TLS connection through %s', async (_name, code) => {
      const before = firstBytes.length;
      const result = await run(code, HTTPS_ONLY);
      expect(result.error).toBeUndefined();
      await new Promise((r) => setTimeout(r, 100));
      // The server saw a TLS ClientHello: the connection was made, and
      // it was TLS. (The handshake then fails; the test has no certificate.)
      expect(firstBytes.slice(before)).toEqual([0x16]);
    });
  });
});
