import { classifyAddress, isBlockedAddress, isBlockedHostname } from '../ip-classification';
import { isAddressBanned, pinnedLookup } from '../ssrf-safe-agent';
import { validateUrl } from '../url-validator';
import { isBannedAddress as netGuardIsBanned } from '../../../modules/tools/node-sandbox/sandbox-net-guard';

/**
 * One table, every gate. The URL validator, the DNS-pinning lookup and the
 * sandbox net guard all have to refuse the same addresses however they are
 * spelled; they share `ip-classification.ts` so they cannot drift, and this
 * spec is what notices if one of them stops asking it.
 *
 * Each row is an IPv6 spelling of a range the server must not reach. None
 * of them are exotic: the WHATWG URL parser rewrites the dotted mapped
 * form into the hex form before any validator sees it, which is how the
 * first row got past the old regex list.
 */
const BLOCKED_IPV6_SPELLINGS: Array<[string, string]> = [
  ['IPv4-mapped, dotted (metadata)', '::ffff:169.254.169.254'],
  ['IPv4-mapped, hex (metadata)', '::ffff:a9fe:a9fe'],
  ['IPv4-mapped, hex (loopback)', '::ffff:7f00:1'],
  ['IPv4-mapped, fully expanded, upper case', '0:0:0:0:0:FFFF:7F00:0001'],
  ['IPv4-mapped, leading zeros', '0000:0000:0000:0000:0000:ffff:0a00:0001'],
  ['IPv4-mapped RFC1918', '::ffff:c0a8:101'],
  ['IPv4-compatible, dotted', '::127.0.0.1'],
  ['IPv4-compatible, hex', '::a9fe:a9fe'],
  ['SIIT IPv4-translated', '::ffff:0:7f00:1'],
  ['NAT64 well-known prefix', '64:ff9b::a9fe:a9fe'],
  ['NAT64 well-known prefix, dotted', '64:ff9b::10.0.0.1'],
  ['NAT64 local-use prefix', '64:ff9b:1::a9fe:a9fe'],
  ['6to4 embedding metadata', '2002:a9fe:a9fe::1'],
  ['6to4 embedding loopback', '2002:7f00:1::'],
  ['Teredo', '2001:0:4136:e378:8000:63bf:3fff:fdd2'],
  ['unspecified', '::'],
  ['loopback, expanded', '0:0:0:0:0:0:0:1'],
  ['unique local', 'fd12:3456::1'],
  ['link-local', 'fe80::1'],
  ['AWS IPv6 metadata', 'fd00:ec2::254'],
  ['multicast', 'ff02::1'],
];

const PUBLIC_ADDRESSES: string[] = [
  '8.8.8.8',
  '1.1.1.1',
  '2606:4700:4700::1111',
  '::ffff:8.8.8.8',
  '2002:808:808::1', // 6to4 of a public address
];

describe('IPv6 spellings of banned IPv4 ranges', () => {
  for (const [label, address] of BLOCKED_IPV6_SPELLINGS) {
    describe(`${label} (${address})`, () => {
      it('is blocked by the shared classifier', () => {
        expect(isBlockedAddress(address)).toBe(true);
      });

      it('is refused by validateUrl as a bracketed URL host', () => {
        expect(validateUrl(`http://[${address}]/`).valid).toBe(false);
      });

      it('is refused by the DNS-pinning lookup when a name resolves to it', () => {
        expect(isAddressBanned(address, 6)).toBe(true);
      });

      it('is refused by the sandbox net guard', () => {
        expect(netGuardIsBanned(address)).toBe(true);
      });
    });
  }

  for (const address of PUBLIC_ADDRESSES) {
    it(`${address} stays reachable through every gate`, () => {
      const v6 = address.includes(':');
      expect(isBlockedAddress(address)).toBe(false);
      expect(validateUrl(`https://${v6 ? `[${address}]` : address}/`).valid).toBe(true);
      expect(isAddressBanned(address, v6 ? 6 : 4)).toBe(false);
      expect(netGuardIsBanned(address)).toBe(false);
    });
  }

  it('refuses an IPv6 address carrying a zone id', () => {
    expect(isBlockedAddress('fe80::1%eth0')).toBe(true);
    expect(isBlockedAddress('2606:4700::1%1')).toBe(true);
  });

  it('reports the metadata endpoint by name whatever spelling reached it', () => {
    for (const host of ['[::ffff:169.254.169.254]', '[::ffff:a9fe:a9fe]', '[2002:a9fe:a9fe::]', '169.254.169.254']) {
      expect(validateUrl(`http://${host}/latest/meta-data/`).error).toMatch(/cloud metadata/);
    }
    expect(classifyAddress('::ffff:a9fe:a9fe')).toEqual({
      kind: 'blocked',
      address: '169.254.169.254',
      metadata: true,
    });
  });

  it('does not let a trailing root dot or a subdomain slip past the hostname list', () => {
    const hosts = [
      'localhost.',
      'LOCALHOST',
      'x.localhost',
      'metadata.google.internal.',
      'a.metadata.google.internal',
      'metadata',
    ];
    for (const host of hosts) {
      expect(isBlockedHostname(host)).toBe(true);
      expect(validateUrl(`http://${host}/`).valid).toBe(false);
    }
    expect(isBlockedHostname('notlocalhost.example.com')).toBe(false);
  });

  it('refuses a blocked hostname in the pinning lookup before DNS is asked', async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((resolve) =>
      pinnedLookup('metadata.google.internal.', { all: true }, (e) => resolve(e)),
    );
    expect(err?.code).toBe('ERR_SSRF_BLOCKED');
  });
});
