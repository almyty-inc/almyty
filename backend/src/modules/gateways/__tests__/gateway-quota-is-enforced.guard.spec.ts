import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

/**
 * `settings.maxGateways` was decorative. The only check, in
 * GatewaysService.createGateway, read `organization.gateways` -- a
 * relation that call never loaded -- so it always passed. The behavioural
 * tests in gateway-quota.spec.ts prove the limit now holds; this one reads
 * the tree so that a NEW path cannot insert Gateway rows without going
 * through `withGatewayQuota` / `assertGatewayQuota`.
 *
 * Source-reading on purpose: the defect is the absence of a call, which no
 * test of the helper itself can see.
 */
const SRC = join(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (['__tests__', 'test', 'migrations'].includes(name)) continue;
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does this source insert Gateway rows? */
function insertsGateways(src: string): boolean {
  // Direct forms that name the entity at the call.
  if (/getRepository\(\s*Gateway\s*\)\s*\.\s*(create|insert|upsert|save)\(/.test(src)) return true;
  if (/\.(create|insert|upsert|save)\(\s*Gateway\s*,/.test(src)) return true;
  if (/\.into\(\s*Gateway\s*\)/.test(src)) return true;
  if (/INSERT\s+INTO\s+"?gateways"?\s*\(/i.test(src)) return true;

  // Anything bound to a Gateway repository, then asked to create / insert.
  const names = new Set<string>();
  for (const m of src.matchAll(/(\w+)\s*:\s*Repository<Gateway>/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[\w.]*getRepository\(\s*Gateway\s*\)/g)) names.add(m[1]);
  for (const name of names) {
    if (new RegExp(`\\b${escape(name)}\\s*\\.\\s*(create|insert|upsert)\\(`).test(src)) return true;
  }
  return false;
}

/** Files that insert Gateway rows outside the quota, with the reason. */
const EXEMPT: Record<string, string> = {
  // Operator script run by hand against staging to seed a lifecycle
  // fixture; not reachable from any tenant request.
  [join('scripts', 'lifecycle-staging-verify.ts')]: 'operator verification script',
  // The platform's own `/almyty` management gateway (isSystem). It is
  // infrastructure, not counted by the quota, and an organization at its
  // limit must still get it.
  [join('modules', 'gateways', 'gateway-init.helper.ts')]: 'system gateway, not counted',
};

/** Every production file that inserts tenant Gateway rows today. */
const KNOWN_CREATION_SITES = [join('modules', 'gateways', 'gateways.service.ts')].sort();

const files = walk(SRC).map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }));
const creators = files.filter((f) => insertsGateways(f.src)).map((f) => f.rel);
const ENFORCES = /\b(withGatewayQuota|assertGatewayQuota)\(/;

describe('every Gateway insert is behind the gateway quota', () => {
  it('the scan still sees every known creation site (it has not gone blind)', () => {
    const seen = creators.filter((f) => !(f in EXEMPT)).sort();
    expect(seen).toEqual(KNOWN_CREATION_SITES);
    for (const rel of Object.keys(EXEMPT)) expect(creators).toContain(rel);
  });

  it.each(KNOWN_CREATION_SITES)('%s enforces the quota with its insert', (rel) => {
    const src = files.find((f) => f.rel === rel)!.src;
    expect(src).toMatch(ENFORCES);
  });

  it('no file inserts Gateway rows without the locked quota check', () => {
    const unguarded = creators
      .filter((f) => !(f in EXEMPT))
      .filter((rel) => !ENFORCES.test(files.find((f) => f.rel === rel)!.src));
    expect(unguarded).toEqual([]);
  });

  it('the exempt runtime path only ever creates the system gateway', () => {
    const src = files.find((f) => f.rel === join('modules', 'gateways', 'gateway-init.helper.ts'))!.src;
    const creates = src.match(/gatewayRepository\.create\(\{[\s\S]*?\}\)/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    for (const call of creates) expect(call).toMatch(/isSystem:\s*true/);
  });

  it('assertGatewayQuota is only called on a transaction the caller owns', () => {
    const bare = files
      .filter((f) => !f.rel.endsWith(join('gateways', 'gateway-quota.ts')))
      .filter((f) => /\bassertGatewayQuota\(/.test(f.src) && !/\.transaction\(/.test(f.src))
      .map((f) => f.rel);
    expect(bare).toEqual([]);
  });

  it('nothing enforces the limit through a relation-reading canAddMoreGateways()', () => {
    const callers = files
      .filter((f) => f.src.split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && /\.canAddMore(Gateways|Tools)\(/.test(line)))
      .map((f) => f.rel);
    expect(callers).toEqual([]);
  });
});
