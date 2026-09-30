// The resolver is the attacker's: see the stub below.
jest.mock('dns', () => ({ ...jest.requireActual('dns'), lookup: jest.fn() }));

import * as dns from 'dns';
import * as http from 'http';
import { AddressInfo } from 'net';
import { gzipSync } from 'zlib';
import axios from 'axios';

import {
  EgressError,
  ResponseTooLargeError,
  outboundFailureDetail,
  safeFetch,
} from '../safe-fetch';
import { egressAxiosConfig, pinnedRedirects } from '../pinned-redirects';
import { agentsExempting } from '../ssrf-safe-agent';

/**
 * The guarded client against a real HTTP server on loopback.
 *
 * The server stands in for everything the gate exists to keep the API
 * process away from: it is on 127.0.0.1, so it IS an internal service.
 * Names under `.test` are answered by a stubbed resolver with the
 * loopback address, which is what a hostile DNS record does -- the name
 * is public-looking, the answer is not. Each case asserts the request was
 * refused AND that the internal endpoint was never hit: a refusal after
 * the request went out would still be an SSRF.
 */

const hits: Record<string, number> = {};
let server: http.Server;
let port: number;

function hit(path: string): number {
  return hits[path] ?? 0;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    hits[path] = hit(path) + 1;
    switch (path) {
      case '/secret':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"aws_secret":"internal"}');
        return;
      case '/doc':
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      case '/to-literal':
        res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
        return;
      case '/to-name':
        res.writeHead(302, { location: `http://inner.test:${port}/secret` }).end();
        return;
      case '/to-metadata':
        res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
        return;
      case '/to-file':
        res.writeHead(302, { location: 'file:///etc/passwd' }).end();
        return;
      case '/to-same-host':
        res.writeHead(302, { location: '/doc' }).end();
        return;
      case '/loop':
        res.writeHead(302, { location: '/loop' }).end();
        return;
      case '/big-declared':
        res.writeHead(200, { 'content-length': String(2 * 1024 * 1024) });
        res.end(Buffer.alloc(2 * 1024 * 1024, 0x61));
        return;
      case '/big-chunked': {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const chunk = Buffer.alloc(64 * 1024, 0x61);
        let sent = 0;
        const pump = () => {
          while (sent < 64) {
            sent++;
            if (!res.write(chunk)) return void res.once('drain', pump);
          }
          res.end();
        };
        pump();
        return;
      }
      case '/gzip-bomb': {
        const body = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0));
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': String(body.length) });
        res.end(body);
        return;
      }
      case '/drip': {
        res.writeHead(200, { 'content-type': 'text/plain' });
        const timer = setInterval(() => res.write('x'), 100);
        res.on('close', () => clearInterval(timer));
        return;
      }
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Hostile DNS: every `.test` name answers with the loopback address (or,
 * for `mapped.test`, the IPv4-mapped IPv6 spelling of it).
 */
const realLookup = jest.requireActual('dns').lookup;
beforeEach(() => {
  for (const k of Object.keys(hits)) delete hits[k];
  (dns.lookup as unknown as jest.Mock).mockImplementation((hostname: string, options: any, callback?: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    if (!hostname.endsWith('.test')) return realLookup(hostname, options, callback);
    const [address, family] = hostname === 'mapped.test' ? ['::ffff:127.0.0.1', 6] : ['127.0.0.1', 4];
    process.nextTick(() => (opts.all ? cb(null, [{ address, family }]) : cb(null, address, family)));
  });
});
afterEach(() => (dns.lookup as unknown as jest.Mock).mockReset());

const url = (host: string, path: string) => `http://${host}:${port}${path}`;

describe('a name that resolves to an internal address at connect time (DNS rebinding)', () => {
  it.each(['rebind.test', 'mapped.test'])('is refused for %s, and the internal endpoint is never hit', async (host) => {
    await expect(safeFetch(url(host, '/secret'))).rejects.toThrow();
    expect(hit('/secret')).toBe(0);
  });

  it('says nothing about what answered', async () => {
    const err = await safeFetch(url('rebind.test', '/secret')).catch((e) => e);
    expect(outboundFailureDetail(err)).toBe('the endpoint could not be reached');
    expect(outboundFailureDetail(err)).not.toMatch(/127\.0\.0\.1|ECONN|resolved/);
  });

  it('is refused on the axios path too', async () => {
    await expect(axios.get(url('rebind.test', '/secret'), { ...egressAxiosConfig() })).rejects.toThrow();
    expect(hit('/secret')).toBe(0);
  });
});

describe('the explicit private-host opt-in', () => {
  it('reaches the one opted-in host', async () => {
    const res = await safeFetch(url('origin.test', '/doc'), { privateHost: 'origin.test' });
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not extend to any other name', async () => {
    await expect(safeFetch(url('other.test', '/secret'), { privateHost: 'origin.test' })).rejects.toThrow();
    expect(hit('/secret')).toBe(0);
  });
});

describe('redirects', () => {
  it('are refused outright by default', async () => {
    await expect(
      safeFetch(url('origin.test', '/to-same-host'), { privateHost: 'origin.test' }),
    ).rejects.toThrow();
    expect(hit('/doc')).toBe(0);
  });

  it('are followed when asked, within the opted-in host', async () => {
    const res = await safeFetch(url('origin.test', '/to-same-host'), {
      privateHost: 'origin.test',
      maxRedirects: 3,
    });
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each([
    ['/to-literal', 'a literal loopback address'],
    ['/to-name', 'a name that resolves to loopback'],
    ['/to-metadata', 'the cloud metadata address'],
    ['/to-file', 'a file: URL'],
  ])('never follow %s (%s) into the internal endpoint', async (path) => {
    const err = await safeFetch(url('origin.test', path), {
      privateHost: 'origin.test',
      maxRedirects: 3,
    }).catch((e) => e);
    // Refused (an error, from whichever realm undici throws it in), never a response.
    expect(err).not.toBeInstanceOf(Response);
    expect(err?.message).toEqual(expect.any(String));
    expect(hit('/secret')).toBe(0);
  });

  it('refuse a literal internal Location by the string gate, before any request', async () => {
    const err = await safeFetch(url('origin.test', '/to-literal'), {
      privateHost: 'origin.test',
      maxRedirects: 3,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(EgressError);
    expect(err.message).toMatch(/redirect/i);
  });

  it('stop at the hop limit', async () => {
    await expect(
      safeFetch(url('origin.test', '/loop'), { privateHost: 'origin.test', maxRedirects: 3 }),
    ).rejects.toBeInstanceOf(EgressError);
    expect(hit('/loop')).toBe(4);
  });

  it('are refused on the axios path, every hop re-gated', async () => {
    // The first hop's host is exempt so the redirect is actually served;
    // the hop to a different name must still be pinned and refused.
    const config = { ...pinnedRedirects({ agents: agentsExempting('origin.test') }), maxContentLength: 1024 };
    for (const path of ['/to-name', '/to-literal', '/to-metadata']) {
      await expect(axios.get(url('origin.test', path), config)).rejects.toThrow();
    }
    expect(hit('/secret')).toBe(0);
    // ...and the same-host hop is followed, so the refusals above are not
    // just "redirects never work".
    await expect(axios.get(url('origin.test', '/to-same-host'), config)).resolves.toMatchObject({ data: { ok: true } });
  });
});

describe('response size', () => {
  const opts = { privateHost: 'origin.test', maxBytes: 1024 * 1024 };

  it('refuses a declared oversize body before reading it', async () => {
    await expect(safeFetch(url('origin.test', '/big-declared'), opts)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('stops an undeclared body at the cap', async () => {
    const res = await safeFetch(url('origin.test', '/big-chunked'), opts);
    await expect(res.text()).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('counts a compressed body at its decompressed size', async () => {
    const res = await safeFetch(url('origin.test', '/gzip-bomb'), opts);
    await expect(res.arrayBuffer()).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});

describe('a slow response', () => {
  it('is cut at the total deadline even though bytes keep arriving', async () => {
    const started = Date.now();
    // The deadline may fire before the headers or while the body drips in;
    // either way the fetch as a whole must fail within it.
    const fetchAll = async () => {
      const res = await safeFetch(url('origin.test', '/drip'), { privateHost: 'origin.test', timeoutMs: 600 });
      return res.text();
    };
    await expect(fetchAll()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('is cut at the total deadline on the axios path, where `timeout` alone is an idle timer', async () => {
    const started = Date.now();
    // The origin host is exempted from the pin: this case is about the
    // deadline. (A plain http.Agent would resolve through Node's internal
    // resolver, fail with ENOTFOUND, and pass for the wrong reason.)
    const config = { ...egressAxiosConfig({ timeoutMs: 600 }), ...agentsExempting('origin.test') };
    await expect(axios.get(url('origin.test', '/drip'), config)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('the string gate', () => {
  it.each([
    'file:///etc/passwd',
    'gopher://127.0.0.1:6379/_INFO',
    'ftp://example.com/x',
    'data:text/plain,hello',
    'http://user:pass@example.com/',
  ])('refuses %s', async (target) => {
    await expect(safeFetch(target)).rejects.toBeInstanceOf(EgressError);
  });

  it.each([
    ['127.0.0.1', 'loopback'],
    ['2130706433', 'decimal loopback'],
    ['0177.0.0.1', 'octal loopback'],
    ['0x7f000001', 'hex loopback'],
    ['127.1', 'short-dotted loopback'],
    ['0.0.0.0', 'unspecified'],
    ['[::1]', 'IPv6 loopback'],
    ['[::ffff:127.0.0.1]', 'IPv4-mapped IPv6 loopback'],
    ['[::ffff:7f00:1]', 'IPv4-mapped IPv6, hex form'],
    ['169.254.169.254', 'cloud metadata'],
    ['[fd00::1]', 'unique-local IPv6'],
    ['10.0.0.1', '10/8'],
    ['172.16.0.1', '172.16/12'],
    ['192.168.1.1', '192.168/16'],
  ])('refuses %s (%s) without a request', async (host) => {
    await expect(safeFetch(`http://${host}:${port}/secret`)).rejects.toBeInstanceOf(EgressError);
    expect(hit('/secret')).toBe(0);
  });
});
