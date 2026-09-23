import {
  EgressError,
  assertOutboundUrlAllowed,
  outboundFailureDetail,
  safeFetch,
} from '../safe-fetch';

describe('assertOutboundUrlAllowed', () => {
  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://127.0.0.1:6379/', 'loopback'],
    ['http://10.0.0.5:8500/v1/kv', 'private range'],
    ['http://[::1]/', 'ipv6 loopback'],
    ['http://2130706433/', 'decimal loopback'],
    ['file:///etc/passwd', 'non-http scheme'],
    ['http://user:pass@example.com/', 'embedded credentials'],
  ])('refuses %s (%s)', (url) => {
    expect(() => assertOutboundUrlAllowed(url)).toThrow(EgressError);
  });

  it('allows an ordinary public URL and returns it normalised', () => {
    expect(assertOutboundUrlAllowed('https://hooks.example.com/abc')).toBe(
      'https://hooks.example.com/abc',
    );
  });
});

describe('safeFetch', () => {
  it('never reaches the network for a refused URL', async () => {
    const spy = jest.spyOn(globalThis, 'fetch');
    await expect(safeFetch('http://169.254.169.254/')).rejects.toBeInstanceOf(EgressError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses redirects rather than following them', async () => {
    const spy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 200 }));
    // The host does not resolve, so the DNS half is a no-op and we can
    // observe exactly what init reaches fetch.
    await safeFetch('https://nonexistent.invalid/x', { method: 'HEAD' });
    expect(spy.mock.calls[0][1]).toMatchObject({ method: 'HEAD', redirect: 'error' });
    spy.mockRestore();
  });
});

describe('outboundFailureDetail', () => {
  /**
   * The prior test-connection branches reported `unreachable: connect
   * ECONNREFUSED 10.0.0.5:8500` and the upstream status code, which
   * separates "port open, speaks HTTP" from "closed" for any address in
   * the cluster — a port scanner an admin can drive from the dashboard.
   */
  it.each([
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8500'), { code: 'ECONNREFUSED' }),
    Object.assign(new Error('getaddrinfo ENOTFOUND internal.svc'), { code: 'ENOTFOUND' }),
    Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }),
  ])('says the same thing whatever the errno was', (err) => {
    expect(outboundFailureDetail(err)).toBe('the endpoint could not be reached');
  });

  it('does keep the reason a URL was refused — that is about what they typed', () => {
    const err = new EgressError('Blocked private/reserved IP: 10.0.0.5');
    expect(outboundFailureDetail(err)).toBe('Blocked private/reserved IP: 10.0.0.5');
  });
});
