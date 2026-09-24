import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * `settings.maxTools` was decorative. The only check, in manual create,
 * read `organization.tools` -- a relation nobody loaded -- and every other
 * path that inserts Tool rows (schema import, generate-from-api, MCP sync,
 * Tool Hub install, runner and memory capability publishing) never checked
 * at all. The behavioural tests in tool-quota-enforced.spec.ts prove each
 * known path refuses; this one reads the tree so that a NEW path cannot
 * insert Tool rows without going through `withToolQuota` / `assertToolQuota`.
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

/** Does this source insert Tool rows? */
function insertsTools(src: string): boolean {
  // Direct forms that name the entity at the call.
  if (/getRepository\(\s*Tool\s*\)\s*\.\s*(create|insert|upsert|save)\(/.test(src)) return true;
  if (/\.(create|insert|upsert|save)\(\s*Tool\s*,/.test(src)) return true;
  if (/\.into\(\s*Tool\s*\)/.test(src)) return true;
  if (/INSERT\s+INTO\s+"?tools"?\s*\(/i.test(src)) return true;

  // Anything bound to a Tool repository, then asked to create / insert.
  const names = new Set<string>();
  for (const m of src.matchAll(/(\w+)\s*:\s*Repository<Tool>/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[\w.]*getRepository\(\s*Tool\s*\)/g)) names.add(m[1]);
  for (const name of names) {
    if (new RegExp(`\\b${escape(name)}\\s*\\.\\s*(create|insert|upsert)\\(`).test(src)) return true;
  }
  return false;
}

/** Files that insert Tool rows outside any request path, with the reason. */
const EXEMPT: Record<string, string> = {
  // Operator script run by hand against staging to seed a lifecycle
  // fixture; not reachable from any tenant request.
  [join('scripts', 'lifecycle-staging-verify.ts')]: 'operator verification script',
};

/** Every production file that inserts Tool rows today. */
const KNOWN_CREATION_SITES = [
  join('modules', 'tools', 'tools.service.ts'),
  join('modules', 'tools', 'tools-operation.helper.ts'),
  join('modules', 'tools', 'tool-generator.service.ts'),
  join('modules', 'mcp-sources', 'mcp-sources.service.ts'),
  join('modules', 'tool-hub', 'tool-hub.service.ts'),
  join('modules', 'runner', 'runner-capability.publisher.ts'),
].sort();

const files = walk(SRC).map((f) => ({ rel: relative(SRC, f), src: readFileSync(f, 'utf8') }));
const creators = files.filter((f) => insertsTools(f.src)).map((f) => f.rel);

describe('every Tool insert is behind the tool quota', () => {
  it('the scan still sees every known creation site (it has not gone blind)', () => {
    const seen = creators.filter((f) => !(f in EXEMPT)).sort();
    expect(seen).toEqual(KNOWN_CREATION_SITES);
  });

  // The enforcing forms: `withToolQuota` (opens or joins a transaction,
  // locks, counts, runs the insert) or `assertToolQuota` on a transaction
  // the caller already owns. `precheckToolQuota` is unlocked and does not
  // count as enforcement.
  const ENFORCES = /\b(withToolQuota|assertToolQuota)\(/;

  it.each(KNOWN_CREATION_SITES)('%s enforces the quota with its insert', (rel) => {
    const src = files.find((f) => f.rel === rel)!.src;
    expect(src).toMatch(ENFORCES);
  });

  it('no file inserts Tool rows without the locked quota check', () => {
    const unguarded = creators.filter((f) => !(f in EXEMPT)).filter((rel) => {
      const src = files.find((f) => f.rel === rel)!.src;
      return !ENFORCES.test(src);
    });
    expect(unguarded).toEqual([]);
  });

  it('assertToolQuota is only called on a transaction the caller owns', () => {
    // Outside a transaction the lock would serialise nothing; the helper
    // refuses at runtime, and this keeps a caller from trying.
    const bare = files
      .filter((f) => !f.rel.endsWith(join('tools', 'tool-quota.ts')))
      .filter((f) => /\bassertToolQuota\(/.test(f.src) && !/\.transaction\(/.test(f.src))
      .map((f) => f.rel);
    expect(bare).toEqual([]);
  });

  it('the schema import path (which inserts through ToolsService) checks the batch', () => {
    const src = files.find((f) => f.rel === join('modules', 'apis', 'apis-tool-generator.helper.ts'))!.src;
    expect(src).toMatch(/\bprecheckToolQuota\(/);
    expect(src).toMatch(/\bassertWithinPerSchemaCap\(/);
    expect(src).toMatch(/\bcapGeneratedDescription\(/);
  });

  it('bulk generation writes its batch whole (writeToolBatch), never row by row', () => {
    // Row by row, two batches racing for the last slots each landed part
    // of their operations. The real-Postgres race in
    // test/integration/quota-race.integration.spec.ts proves the batch
    // form; this keeps the bulk paths on it.
    for (const rel of [
      join('modules', 'apis', 'apis-tool-generator.helper.ts'),
      join('modules', 'tools', 'tool-generator.service.ts'),
    ]) {
      const src = files.find((f) => f.rel === rel)!.src;
      const generate = src.slice(src.indexOf('async generateToolsFromApi('));
      const body = generate.slice(0, generate.search(/\n  (?:async |private |logMemoryPhase)/));
      expect(body).toMatch(/\bwriteToolBatch\(/);
      expect(body).not.toMatch(/\b(createFromOperation|updateFromOperation|generateToolFromOperation)\(/);
      expect(body).not.toMatch(/\bwithToolQuota\(/);
    }
  });
  it('bulk paths enforce the per-schema cap and cap derived descriptions', () => {
    for (const rel of [
      join('modules', 'tools', 'tool-generator.service.ts'),
      join('modules', 'mcp-sources', 'mcp-sources.service.ts'),
    ]) {
      const src = files.find((f) => f.rel === rel)!.src;
      expect(src).toMatch(/\bassertWithinPerSchemaCap\(/);
      expect(src).toMatch(/\bcapGeneratedDescription\(/);
    }
  });

  it('nothing enforces the limit through the relation-reading canAddMoreTools()', () => {
    const callers = files
      .filter((f) => !f.rel.startsWith(`entities${sep}`))
      .filter((f) => f.src.split('\n').some((line) => !/^\s*(\/\/|\*)/.test(line) && /\.canAddMoreTools\(/.test(line)))
      .map((f) => f.rel);
    expect(callers).toEqual([]);
  });
});
