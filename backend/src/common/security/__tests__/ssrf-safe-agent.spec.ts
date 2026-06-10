import { isAddressBanned } from '../ssrf-safe-agent';

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
