jest.mock('dns', () => ({ lookup: jest.fn() }));

import * as dns from 'dns';

import { agentsExempting, isAddressBanned, pinnedLookup } from '../ssrf-safe-agent';

/**
 * The pinning lookup refuses any resolved address that lands in a banned
 * range — the DNS-rebinding defense the up-front URL string check can't
 * provide. `isAddressBanned` is that decision, exercised here directly.
 */
describe('isAddressBanned (SSRF DNS pinning)', () => {
  it.each([
    ['169.254.169.254', 4], // cloud metadata
    ['127.0.0.1', 4], // loopback
    ['10.1.2.3', 4], // RFC1918 class A
    ['172.16.5.4', 4], // RFC1918 class B
    ['192.168.0.1', 4], // RFC1918 class C
    ['169.254.10.10', 4], // link-local
    ['::1', 6], // IPv6 loopback
    ['fd00::1', 6], // IPv6 ULA
    ['fe80::1', 6], // IPv6 link-local
  ])('bans a hostname that resolves to %s', (address, family) => {
    expect(isAddressBanned(address, family)).toBe(true);
  });

  it.each([
    ['93.184.216.34', 4], // example.com
    ['1.1.1.1', 4], // public DNS
    ['2606:2800:220:1:248:1893:25c8:1946', 6], // public IPv6
  ])('allows a hostname that resolves to public %s', (address, family) => {
    expect(isAddressBanned(address, family)).toBe(false);
  });
});

/**
 * The /etc/hosts bypass, which is the one people actually try.
 *
 * Add a public-looking name to /etc/hosts pointing at the target IP, then
 * send it with a matching Host header. Every string check on the URL sees
 * a public hostname and waves it through. `dns.lookup` consults
 * /etc/hosts, so this is exactly what a poisoned resolver looks like from
 * our side, and the only defence that works is checking the address the
 * name actually resolved to.
 *
 * Exposure here is worse than for a sandbox vendor: the runner executes
 * shell in a user workspace, so the attacker owns /etc/hosts, the
 * resolver and the Host header. This test is why the protection cannot be
 * removed quietly.
 */
describe('pinnedLookup refuses a name that resolves somewhere private', () => {
  const resolveTo = (addresses: Array<{ address: string; family: number }>) => {
    (dns.lookup as unknown as jest.Mock).mockImplementation((_host: any, opts: any, cb: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (opts && typeof opts === 'object' && opts.all) return callback(null, addresses);
      return callback(null, addresses[0].address, addresses[0].family);
    });
  };

  afterEach(() => (dns.lookup as unknown as jest.Mock).mockReset());

  const lookup = (host: string, opts: any = {}) =>
    new Promise<{ err: any; address: any }>((resolve) => {
      pinnedLookup(host, opts, (err, address) => resolve({ err, address }));
    });

  it('blocks a public name pointed at loopback, the /etc/hosts case', async () => {
    resolveTo([{ address: '127.0.0.1', family: 4 }]);
    const { err } = await lookup('totally-legit.example.com');
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
    expect(err?.message).toContain('127.0.0.1');
  });

  it('blocks a public name pointed at cloud metadata', async () => {
    resolveTo([{ address: '169.254.169.254', family: 4 }]);
    const { err } = await lookup('metadata.totally-legit.example.com');
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
  });

  it('blocks when ANY returned address is private, not just the first', async () => {
    // A resolver that answers with a public address first and a private
    // one second would otherwise get through on a happy-path check.
    resolveTo([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    const { err } = await lookup('two-faced.example.com', { all: true });
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
    expect(err?.message).toContain('10.0.0.5');
  });

  it('still resolves a name that really is public', async () => {
    resolveTo([{ address: '93.184.216.34', family: 4 }]);
    const { err, address } = await lookup('example.com');
    expect(err).toBeNull();
    expect(address).toBe('93.184.216.34');
  });
});

/**
 * The exception is for one host and no others.
 *
 * These agents are pooled and shared across requests, so an exemption any
 * wider than the exact name would quietly apply to hosts nobody approved.
 */
describe('agentsExempting', () => {
  const lookupOf = (agent: any) => agent.options.lookup as (h: string, o: any, cb: any) => void;
  const run = (agent: any, host: string) =>
    new Promise<{ err: any; address: any }>((resolve) => {
      lookupOf(agent)(host, {}, (err: any, address: any) => resolve({ err, address }));
    });

  beforeEach(() => {
    (dns.lookup as unknown as jest.Mock).mockImplementation((_host: any, opts: any, cb: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      callback(null, '10.0.0.5', 4);
    });
  });
  afterEach(() => (dns.lookup as unknown as jest.Mock).mockReset());

  it('lets the approved name resolve into a private range', async () => {
    const { httpAgent } = agentsExempting('gpu-1.internal');
    const { err, address } = await run(httpAgent, 'gpu-1.internal');
    expect(err).toBeNull();
    expect(address).toBe('10.0.0.5');
  });

  it('matches the name case-insensitively, since DNS does', async () => {
    const { httpsAgent } = agentsExempting('gpu-1.internal');
    const { err } = await run(httpsAgent, 'GPU-1.Internal');
    expect(err).toBeNull();
  });

  it('still refuses every other name through the same agent', async () => {
    const { httpAgent } = agentsExempting('gpu-1.internal');
    const { err } = await run(httpAgent, 'gpu-2.internal');
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
  });

  it('reuses one agent per host rather than leaking a pool per request', async () => {
    expect(agentsExempting('gpu-1.internal')).toBe(agentsExempting('GPU-1.INTERNAL'));
    expect(agentsExempting('gpu-1.internal')).not.toBe(agentsExempting('gpu-2.internal'));
  });
});
