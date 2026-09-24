import * as fs from 'fs';
import * as path from 'path';

/**
 * Every "is this address private" decision goes through
 * `common/security/ip-classification.ts`.
 *
 * The SSRF bypass this guards against was two classifiers disagreeing: the
 * URL validator matched regexes on the host string while the sandbox net
 * guard parsed addresses, so an IPv6 spelling of 169.254.169.254 was
 * refused by one and allowed by the other. A third hand-rolled check
 * somewhere else would reopen the same hole the next time a range is
 * added to only one of them.
 *
 * This reads the tree (comments stripped) and fails on the shapes such a
 * check takes: a regex or string prefix test for a private/loopback/
 * link-local range, a `net.BlockList`, or a helper named like one.
 * Import `classifyAddress` / `isBlockedAddress` / `isBlockedHostname`
 * instead.
 */

const SRC_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLASSIFIER = path.join('common', 'security', 'ip-classification.ts');

/**
 * Files that look at IP ranges for a reason other than deciding where the
 * server may connect. Each needs a justification.
 */
const EXEMPT: Record<string, string> = {
  // Inbound client-IP allowlist for gateway auth: the organization's own
  // CIDR list matched against the caller's socket address. Not egress.
  [path.join('modules', 'gateways', 'gateway-auth-utils.ts')]: 'inbound client-IP ACL',
  // Prompt-injection heuristics that flag the text "127.0.0.1" in model
  // input. Pattern-matching prose, not classifying a connect target.
  [path.join('common', 'security', 'input-sanitizer.ts')]: 'text heuristic',
};

const FORBIDDEN: Array<[string, RegExp]> = [
  ['a net.BlockList (use the shared classifier)', /\bBlockList\b/],
  ['a regex over a private/loopback/link-local range', /\/\^?\(?(?:10|127|169|172|192)\\\./],
  ['a regex over an IPv6 local range', /\/\^?[^/\n]*(?:fe80|fc00|f\[cd\]|::ffff)[^/\n]*\/[gimsuy]*/i],
  [
    'a string-prefix test for a private range',
    /\.startsWith\(\s*['"`](?:10\.|127\.|169\.254|192\.168|172\.(?:1[6-9]|2\d|3[01])|fe80|fc|fd|::ffff:)/i,
  ],
  ['a hand-rolled private-address helper', /\bfunction\s+is(?:Private|Internal|Loopback|Reserved)(?:Ip|IP|Address|Host)\b/],
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('no ad-hoc IP classification outside ip-classification.ts', () => {
  const files = walk(SRC_ROOT);

  it('finds the source tree', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((f) => path.relative(SRC_ROOT, f))).toContain(CLASSIFIER);
  });

  it('has no hand-rolled private-range checks', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC_ROOT, file);
      if (rel === CLASSIFIER || EXEMPT[rel]) continue;
      const source = stripComments(fs.readFileSync(file, 'utf8'));
      for (const [what, pattern] of FORBIDDEN) {
        const hit = source.match(pattern);
        if (hit) offenders.push(`${rel}: ${what}: ${hit[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catches the shapes it claims to catch', () => {
    const samples = [
      'const x = new net.BlockList();',
      'const r = /^169\\.254\\./;',
      'const r = /^192\\.168\\./;',
      'const r = /^fe80:/i;',
      "if (ip.startsWith('::ffff:')) ip = ip.slice(7);",
      "if (host.startsWith('10.')) return true;",
      'function isPrivateIp(ip: string) { return false; }',
    ];
    for (const sample of samples) {
      expect(FORBIDDEN.some(([, p]) => p.test(sample))).toBe(true);
    }
    expect(FORBIDDEN.some(([, p]) => p.test("import { isBlockedAddress } from './ip-classification';"))).toBe(false);
  });
});
