import * as http from 'http';
import * as https from 'https';
import { AddressInfo } from 'net';

import { EgressError } from '../safe-fetch';
import { DEFAULT_REDIRECT_HOPS, pinnedRedirects } from '../pinned-redirects';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from '../ssrf-safe-agent';
import { UrlValidationResult } from '../url-validator';

// test/setup.ts replaces axios with a stub; this spec is about what the
// real client does with the config, so it uses the real one.
const realAxios = jest.requireActual('axios');
const axios = realAxios.default ?? realAxios;

describe('pinnedRedirects: the config', () => {
  it('pins DNS and caps the chain by default', () => {
    const cfg = pinnedRedirects();
    expect(cfg.maxRedirects).toBe(DEFAULT_REDIRECT_HOPS);
    expect(cfg.httpAgent).toBe(ssrfSafeHttpAgent);
    expect(cfg.httpsAgent).toBe(ssrfSafeHttpsAgent);
  });

  it('refuses a hop to a literal metadata address, which DNS pinning never sees', () => {
    const { beforeRedirect } = pinnedRedirects();
    const hop = { href: 'http://169.254.169.254/latest/meta-data/', protocol: 'http:' };
    expect(() => beforeRedirect(hop, {} as any, {} as any)).toThrow(EgressError);
  });

  it('refuses a hop to loopback and to a non-http scheme', () => {
    const { beforeRedirect } = pinnedRedirects();
    expect(() => beforeRedirect({ href: 'http://127.0.0.1:6379/', protocol: 'http:' }, {} as any, {} as any)).toThrow(EgressError);
    expect(() => beforeRedirect({ href: 'file:///etc/passwd', protocol: 'file:' }, {} as any, {} as any)).toThrow(EgressError);
  });

  it('keeps the pinned agent across an http -> https hop', () => {
    // axios hands follow-redirects one agent, for the first protocol. An
    // https hop would otherwise carry the http agent along.
    const { beforeRedirect } = pinnedRedirects();
    const hop: Record<string, any> = { href: 'https://example.com/spec.json', protocol: 'https:', agent: ssrfSafeHttpAgent };
    beforeRedirect(hop, {} as any, {} as any);
    expect(hop.agent).toBe(ssrfSafeHttpsAgent);
  });
});

/**
 * End to end through the real axios / follow-redirects stack. Both servers
 * are on loopback, so the "public" one is simulated by a validator that
 * admits only its port, and plain agents stand in for the pinned ones
 * (which would refuse loopback outright -- the point here is the hop check).
 */
describe('pinnedRedirects: through real axios', () => {
  let publicServer: http.Server;
  let internalServer: http.Server;
  let publicPort: number;
  let internalPort: number;
  let internalHits = 0;
  let loopHits = 0;

  const listen = (server: http.Server) =>
    new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

  beforeAll(async () => {
    internalServer = http.createServer((_req, res) => {
      internalHits++;
      res.end('internal secret');
    });
    internalPort = await listen(internalServer);

    publicServer = http.createServer((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(301, { Location: '/spec.json' }).end();
      } else if (req.url === '/spec.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"openapi":"3.1.0"}');
      } else if (req.url === '/to-internal') {
        res.writeHead(302, { Location: `http://127.0.0.1:${internalPort}/secret` }).end();
      } else if (req.url === '/loop') {
        loopHits++;
        res.writeHead(302, { Location: '/loop' }).end();
      } else {
        res.writeHead(404).end();
      }
    });
    publicPort = await listen(publicServer);
  });

  afterAll(async () => {
    await new Promise((r) => publicServer.close(r));
    await new Promise((r) => internalServer.close(r));
  });

  beforeEach(() => {
    internalHits = 0;
    loopHits = 0;
  });

  const onlyThePublicPort = (url: string): UrlValidationResult =>
    new URL(url).port === String(publicPort)
      ? { valid: true, sanitizedUrl: url }
      : { valid: false, error: 'not the public host' };

  const policy = () =>
    pinnedRedirects({
      validate: onlyThePublicPort,
      agents: { httpAgent: new http.Agent(), httpsAgent: new https.Agent() },
    });

  it('the attack is real: a default axios request follows a public 302 into the internal host', async () => {
    const res = await axios.get(`http://127.0.0.1:${publicPort}/to-internal`);
    expect(res.data).toBe('internal secret');
    expect(internalHits).toBe(1);
  });

  it('refuses the same redirect before a byte reaches the internal host', async () => {
    await expect(axios.get(`http://127.0.0.1:${publicPort}/to-internal`, policy())).rejects.toThrow(
      /Refused to follow a redirect/,
    );
    expect(internalHits).toBe(0);
  });

  it('still follows an ordinary redirect on an allowed host', async () => {
    const res = await axios.get(`http://127.0.0.1:${publicPort}/moved`, policy());
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ openapi: '3.1.0' });
  });

  it('stops a redirect loop at the hop cap', async () => {
    await expect(axios.get(`http://127.0.0.1:${publicPort}/loop`, policy())).rejects.toThrow(/redirects exceeded/i);
    expect(loopHits).toBe(DEFAULT_REDIRECT_HOPS + 1);
  });
});
