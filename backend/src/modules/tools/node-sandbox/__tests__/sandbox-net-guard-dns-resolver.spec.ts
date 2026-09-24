import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NodeSandboxService } from '../node-sandbox.service';
import { DependencyManagerService } from '../dependency-manager.service';

/**
 * The net guard patched `dns.lookup` (and its promise twin) and nothing
 * else in `dns`. Everything built on c-ares went round it:
 *
 *   - `dns.resolve4` / `resolve6` / `resolve` / `resolveAny` and the rest,
 *     on the module, on `dns.promises`, and on any `new dns.Resolver()`;
 *   - `setServers`, which points those queries at an arbitrary address and
 *     port. c-ares opens its own sockets in C, so the dgram patch never
 *     sees them -- that is a UDP (and TCP) channel to any internal
 *     host:port, carrying attacker-chosen query names.
 *
 * User code cannot `require('dns')` directly (it is not on the module
 * allowlist), but an installed dependency can, and a tool author chooses
 * its dependencies. So the fixture below is a one-line package that
 * re-exports `dns`, which is all it takes.
 *
 * A tiny DNS server on 127.0.0.1 stands in for an internal resolver: it
 * answers every A query for a name under `.meta.test` with 169.254.169.254
 * and under `.public.test` with a public address.
 */

function buildDnsServer(): Promise<{ port: number; queries: string[]; close: () => void }> {
  const sock = dgram.createSocket('udp4');
  const queries: string[] = [];
  sock.on('message', (msg, rinfo) => {
    // Question name starts at offset 12.
    let off = 12;
    const labels: string[] = [];
    while (msg[off] !== 0) {
      const len = msg[off];
      labels.push(msg.subarray(off + 1, off + 1 + len).toString());
      off += len + 1;
    }
    off += 1;
    const qtype = msg.readUInt16BE(off);
    const questionEnd = off + 4;
    const name = labels.join('.');
    queries.push(name);

    const ip = name.endsWith('.meta.test')
      ? [169, 254, 169, 254]
      : name.endsWith('.public.test')
        ? [93, 184, 215, 14]
        : null;
    const answer = qtype === 1 && ip;

    const header = Buffer.alloc(12);
    msg.copy(header, 0, 0, 2); // id
    header.writeUInt16BE(0x8180, 2); // response, RD, RA, NOERROR
    header.writeUInt16BE(1, 4); // qdcount
    header.writeUInt16BE(answer ? 1 : 0, 6); // ancount
    const question = msg.subarray(12, questionEnd);
    const parts = [header, question];
    if (answer) {
      const rr = Buffer.alloc(16);
      rr.writeUInt16BE(0xc00c, 0); // pointer to the question name
      rr.writeUInt16BE(1, 2); // A
      rr.writeUInt16BE(1, 4); // IN
      rr.writeUInt32BE(60, 6); // ttl
      rr.writeUInt16BE(4, 10);
      Buffer.from(ip).copy(rr, 12);
      parts.push(rr);
    }
    sock.send(Buffer.concat(parts), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    sock.bind(0, '127.0.0.1', () => {
      resolve({ port: sock.address().port, queries, close: () => sock.close() });
    });
  });
}

describe('sandbox net guard - the c-ares resolver paths', () => {
  let service: NodeSandboxService;
  let depsDir: string;
  let server: { port: number; queries: string[]; close: () => void };

  jest.setTimeout(60_000);

  beforeAll(async () => {
    // realpath: on macOS the tmpdir is behind a symlink, and the worker's
    // --allow-fs-read grant is checked against the resolved path.
    depsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-dns-proxy-')));
    const pkg = path.join(depsDir, 'node_modules', 'dns-proxy');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(
      path.join(pkg, 'package.json'),
      JSON.stringify({ name: 'dns-proxy', version: '1.0.0', main: 'index.js' }),
    );
    fs.writeFileSync(path.join(pkg, 'index.js'), "module.exports = require('dns');\n");

    const depManager = {
      ensureInstalled: jest
        .fn()
        .mockResolvedValue({ installDir: depsDir, cached: true, installTimeMs: 0 }),
      listCached: jest.fn().mockReturnValue([]),
      clearCache: jest.fn(),
    } as unknown as DependencyManagerService;
    service = new NodeSandboxService(depManager);
    server = await buildDnsServer();
  });

  afterAll(() => {
    server.close();
    fs.rmSync(depsDir, { recursive: true, force: true });
  });

  const exec = (code: string, testNetAllow?: string) =>
    service.execute({
      code:
        `const dns = require('dns-proxy'); const PORT = ${server.port}; ` +
        `const SERVER = '127.0.0.1:${server.port}';\n${code}`,
      parameters: {},
      dependencies: { 'dns-proxy': '1.0.0' },
      timeoutMs: 15000,
      memoryLimitMb: 64,
      testNetAllow,
    });

  describe('pointing a resolver at an internal address', () => {
    const cases: Array<[string, string]> = [
      [
        'new dns.Resolver().setServers',
        `const r = new dns.Resolver(); r.setServers([SERVER]);
         return await new Promise((res, rej) => r.resolve4('a.meta.test', (e, a) => e ? rej(e) : res(a)));`,
      ],
      [
        'new dns.promises.Resolver().setServers',
        `const r = new dns.promises.Resolver(); r.setServers([SERVER]);
         return await r.resolve4('b.meta.test');`,
      ],
      [
        'module-level dns.setServers',
        `dns.setServers([SERVER]);
         return await new Promise((res, rej) => dns.resolve4('c.meta.test', (e, a) => e ? rej(e) : res(a)));`,
      ],
      [
        'dns.promises.setServers',
        `dns.promises.setServers([SERVER]);
         return await dns.promises.resolve4('d.meta.test');`,
      ],
      [
        'the native handle behind a Resolver',
        `const r = new dns.Resolver(); r._handle.setServers([[4, '127.0.0.1', PORT]]);
         return await new Promise((res, rej) => r.resolve4('l.meta.test', (e, a) => e ? rej(e) : res(a)));`,
      ],
    ];

    it.each(cases)('refuses %s', async (_name, code) => {
      const before = server.queries.length;
      const result = await exec(code);
      expect(result.data).toBeUndefined();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Sandbox refused/);
      // And nothing reached the internal resolver.
      expect(server.queries.length).toBe(before);
    });
  });

  describe('answers that land on a banned address', () => {
    // The harness allow-list lets the test resolver itself be configured,
    // so what is exercised here is the check on the ANSWER.
    const allow = () => `127.0.0.1:${server.port}`;

    const cases: Array<[string, string]> = [
      [
        'Resolver#resolve4',
        `const r = new dns.Resolver(); r.setServers([SERVER]);
         return await new Promise((res, rej) => r.resolve4('e.meta.test', (e, a) => e ? rej(e) : res(a)));`,
      ],
      [
        'Resolver#resolve4 with ttl',
        `const r = new dns.Resolver(); r.setServers([SERVER]);
         return await new Promise((res, rej) => r.resolve4('f.meta.test', { ttl: true }, (e, a) => e ? rej(e) : res(a)));`,
      ],
      [
        'Resolver#resolve with rrtype A',
        `const r = new dns.Resolver(); r.setServers([SERVER]);
         return await new Promise((res, rej) => r.resolve('g.meta.test', 'A', (e, a) => e ? rej(e) : res(a)));`,
      ],
      [
        'promises.Resolver#resolve4',
        `const r = new dns.promises.Resolver(); r.setServers([SERVER]);
         return await r.resolve4('h.meta.test');`,
      ],
      [
        'promises.Resolver#resolve',
        `const r = new dns.promises.Resolver(); r.setServers([SERVER]);
         return await r.resolve('i.meta.test');`,
      ],
      [
        'module-level dns.resolve4',
        `dns.setServers([SERVER]);
         return await new Promise((res, rej) => dns.resolve4('j.meta.test', (e, a) => e ? rej(e) : res(a)));`,
      ],
      [
        'module-level dns.promises.resolve4',
        `dns.promises.setServers([SERVER]);
         return await dns.promises.resolve4('k.meta.test');`,
      ],
    ];

    it.each(cases)('refuses %s', async (_name, code) => {
      const result = await exec(code, allow());
      expect(result.data).toBeUndefined();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Sandbox refused/);
    });

    it('still returns a public answer', async () => {
      const result = await exec(
        `const r = new dns.promises.Resolver(); r.setServers([SERVER]);
         return await r.resolve4('ok.public.test');`,
        allow(),
      );
      expect(result.error).toBeUndefined();
      expect(result.data).toEqual(['93.184.215.14']);
    });
  });

  it('still lets a resolver be pointed at a public server', async () => {
    // Nothing is queried: setServers only records the address.
    const result = await exec(
      `const r = new dns.Resolver(); r.setServers(['8.8.8.8', '[2606:4700:4700::1111]:53']);
       return r.getServers();`,
    );
    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(['8.8.8.8', '2606:4700:4700::1111']);
  });
});
