import { isBannedAddress } from '../sandbox-net-guard';

/**
 * The guard used to classify IPv6 by lowercase string prefix, on the
 * assumption that Node hands it a canonical address. It does not: the
 * host comes from whatever URL the sandboxed tool code typed, and
 * `fetch('http://[0:0:0:0:0:ffff:127.0.0.1]:6379/')` reaches the guard
 * spelled exactly like that.
 *
 * Every address below denotes a banned IPv4 address, or a banned IPv6
 * range, in a spelling the prefix match did not recognise.
 */
describe('sandbox net guard - IPv6 spellings of banned addresses', () => {
  const banned: Array<[string, string]> = [
    ['::ffff:127.0.0.1', 'mapped loopback, dotted form'],
    ['::ffff:7f00:1', 'mapped loopback, hex form'],
    ['0:0:0:0:0:ffff:127.0.0.1', 'mapped loopback, expanded form'],
    ['::FFFF:7F00:1', 'mapped loopback, uppercase hex form'],
    ['::ffff:169.254.169.254', 'mapped IMDS, dotted form'],
    ['::ffff:a9fe:a9fe', 'mapped IMDS, hex form'],
    ['0:0:0:0:0:ffff:169.254.169.254', 'mapped IMDS, expanded form'],
    ['::ffff:192.168.0.1', 'mapped RFC1918, dotted form'],
    ['::ffff:c0a8:1', 'mapped RFC1918, hex form'],
    ['::ffff:10.0.0.1', 'mapped RFC1918 /8'],
    ['::ffff:a00:1', 'mapped RFC1918 /8, hex form'],
    ['64:ff9b::7f00:1', 'NAT64 well-known prefix wrapping loopback'],
    ['::1', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback, expanded form'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['FE80::1', 'link-local, uppercase'],
    ['fe80::1%eth0', 'link-local with a zone index'],
    ['fc00::1', 'unique local'],
    ['fd12:3456::1', 'unique local, fd half of fc00::/7'],
    ['ff02::1', 'multicast'],
  ];

  it.each(banned)('refuses %s (%s)', (address) => {
    expect(isBannedAddress(address)).toBe(true);
  });

  const allowed: Array<[string, string]> = [
    ['2606:4700:4700::1111', 'a public resolver'],
    ['2a00:1450:4001:80e::200e', 'a public host'],
    ['::ffff:8.8.8.8', 'a mapped PUBLIC IPv4 address stays allowed'],
    ['::ffff:808:808', 'the same, hex form'],
    ['8.8.8.8', 'a public IPv4 address'],
  ];

  it.each(allowed)('allows %s (%s)', (address) => {
    expect(isBannedAddress(address)).toBe(false);
  });

  it('still refuses every banned IPv4 range in dotted form', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '255.255.255.255',
      '224.0.0.1',
    ]) {
      expect([ip, isBannedAddress(ip)]).toEqual([ip, true]);
    }
  });

  it('leaves non-IP strings to the caller', () => {
    expect(isBannedAddress('example.com')).toBe(false);
    expect(isBannedAddress('not-an-ip')).toBe(false);
  });
});
