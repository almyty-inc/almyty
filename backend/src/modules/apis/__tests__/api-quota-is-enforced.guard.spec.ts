import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

import { Organization } from '../../../entities/organization.entity';

/**
 * `settings.maxApis` was decorative. `Organization.canAddMoreApis()` read
 * the never-loaded `apis` relation and nothing called it; `create` and
 * `createHttpApi` ran an unserialised COUNT, and `createSdkApi` and Tool
 * Hub installs did not check at all. The behavioural tests in
 * api-quota.spec.ts prove the limit now holds; this one reads the tree so
 * that a NEW path cannot insert Api rows without going through
 * `withApiQuota` / `assertApiQuota`.
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

/** Does this source insert Api rows? */
function insertsApis(src: string): boolean {
  // Direct forms that name the entity at the call.
  if (/getRepository\(\s*Api\s*\)\s*\.\s*(create|insert|upsert|save)\(/.test(src)) return true;
  if (/\.(create|insert|upsert|save)\(\s*Api\s*,/.test(src)) return true;
  if (/\.into\(\s*Api\s*\)/.test(src)) return true;
  if (/INSERT\s+INTO\s+"?apis"?\s*\(/i.test(src)) return true;

  // Anything bound to an Api repository, then asked to create / insert.
  const names = new Set<string>();
  for (const m of src.matchAll(/(\w+)\s*:\s*Repository<Api>/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[\w.]*getRepository\(\s*Api\s*\)/g)) names.add(m[1]);
  for (const name of names) {
    if (new RegExp(`\\b${escape(name)}\\s*\\.\\s*(create|insert|upsert)\\(`).test(src)) return true;
  }
  return false;
}

/** Files that insert Api rows outside the quota, with the reason. */
const EXEMPT: Record<string, string> = {
  // Operator script run by hand against staging to seed a lifecycle
  // fixture; not reachable from any tenant request.
  [join('scripts', 'lifecycle-staging-verify.ts')]: 'operator verification script',
};

/** Every production file that inserts Api rows today. */
const KNOWN_CREATION_SITES = [
  join('modules', 'apis', 'apis.service.ts'),
  join('modules', 'tool-hub', 'tool-hub.service.ts'),
].sort();

const files = walk(SRC).map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }));
const creators = files.filter((f) => insertsApis(f.src)).map((f) => f.rel);
const ENFORCES = /\b(withApiQuota|assertApiQuota)\(/;

describe('every Api insert is behind the API quota', () => {
  it('the scan still sees every known creation site (it has not gone blind)', () => {
    const seen = creators.filter((f) => !(f in EXEMPT)).sort();
    expect(seen).toEqual(KNOWN_CREATION_SITES);
    for (const rel of Object.keys(EXEMPT)) expect(creators).toContain(rel);
  });

  it.each(KNOWN_CREATION_SITES)('%s enforces the quota with its insert', (rel) => {
    const src = files.find((f) => f.rel === rel)!.src;
    expect(src).toMatch(ENFORCES);
  });

  it('no file inserts Api rows without the locked quota check', () => {
    const unguarded = creators
      .filter((f) => !(f in EXEMPT))
      .filter((rel) => !ENFORCES.test(files.find((f) => f.rel === rel)!.src));
    expect(unguarded).toEqual([]);
  });

  it.each(KNOWN_CREATION_SITES)('%s saves every Api row it creates inside withApiQuota', (rel) => {
    // One quota-wrapped save per apiRepository.create(...): a second
    // create path added to a file that already enforces once is caught.
    const code = files
      .find((f) => f.rel === rel)!
      .src.split('\n')
      .filter((line) => !/^\s*(\/\/|\*)/.test(line))
      .join('\n');
    const creates = code.match(/\bapiRepository\.create\(/g)?.length ?? 0;
    const guardedSaves = code.match(/withApiQuota\([^;]*?tx\.getRepository\(Api\)\.save\(/g)?.length ?? 0;
    expect(creates).toBeGreaterThan(0);
    expect(guardedSaves).toBe(creates);
  });

  it('assertApiQuota is only called on a transaction the caller owns', () => {
    const bare = files
      .filter((f) => !f.rel.endsWith(join('apis', 'api-quota.ts')))
      .filter((f) => /\bassertApiQuota\(/.test(f.src) && !/\.transaction\(/.test(f.src))
      .map((f) => f.rel);
    expect(bare).toEqual([]);
  });

  it('nothing enforces a limit through a relation-reading canAddMore*()', () => {
    const callers = files
      .filter((f) => f.src.split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && /\.canAddMore(Apis|Gateways|Tools)\(/.test(line)))
      .map((f) => f.rel);
    expect(callers).toEqual([]);
    expect('canAddMoreApis' in Organization.prototype).toBe(false);
  });
});
