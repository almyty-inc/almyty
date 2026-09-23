import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { LlmProviderStatus } from '../../../entities/llm-provider.entity';

/**
 * A health gate that let everything through.
 *
 * `LlmProviderStatus.ERROR` was assigned in exactly one place --
 * `LlmProvider.updateHealthStatus()` -- and that method had no caller
 * anywhere in src or ee. The real health sweep writes `isHealthy` and
 * `lastError` with a partial UPDATE and deliberately never touches
 * `status`, because status is the operator's intent and health is an
 * observation.
 *
 * So `onboarding.service.ts` asking for `status: Not(ERROR)` under a
 * method named `hasHealthyProvider` excluded nothing: an org whose only
 * provider had been failing every call still counted as having a working
 * one, and the onboarding checklist ticked a step that was not done.
 *
 * Source-reading on purpose: every unit test of updateHealthStatus passed
 * (there were four of them) the entire time nothing called it.
 *
 * What it guards:
 *   1. no production code filters a provider query on a status value
 *      nothing assigns;
 *   2. the onboarding gate asks about isHealthy;
 *   3. the method that used to write ERROR is gone rather than back.
 */
const SRC = join(__dirname, '..', '..', '..');

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === 'test') continue;
      productionFiles(p, out);
    } else if (name.endsWith('.ts') && !name.includes('.spec.')) {
      out.push(p);
    }
  }
  return out;
}
/**
 * Comments stripped before matching: this file's own fixes are documented
 * in prose that names the very patterns being banned, and a guard that
 * trips on its own postmortem is a guard people delete.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const files = productionFiles(SRC).map((path) => ({
  path,
  src: stripComments(readFileSync(path, 'utf8')),
}));

/** Status values some production file assigns to a provider row. */
function assignedStatuses(): Set<string> {
  const assigned = new Set<string>();
  for (const { path, src } of files) {
    if (path.endsWith(join('entities', 'llm-provider.entity.ts'))) {
      // Only the column default counts from inside the entity.
      for (const m of src.matchAll(/default:\s*LlmProviderStatus\.(\w+)/g)) assigned.add(m[1]);
      continue;
    }
    for (const m of src.matchAll(/(?:status\s*[:=]|=)\s*LlmProviderStatus\.(\w+)/g)) assigned.add(m[1]);
  }
  return assigned;
}

describe('no provider query filters on a status nothing writes', () => {
  it('ERROR is still unassigned -- the invariant the comment states', () => {
    expect([...assignedStatuses()]).not.toContain('ERROR');
  });

  it('nothing filters a query on it', () => {
    const offenders = files
      .filter(({ path }) => !path.endsWith(join('entities', 'llm-provider.entity.ts')))
      .filter(({ src }) => /Not\(\s*LlmProviderStatus\.ERROR\s*\)/.test(src))
      .map(({ path }) => path.slice(SRC.length + 1));

    // `Not(ERROR)` over a value nobody writes is a filter that excludes
    // nothing while reading as a safety check -- the exact bug this fixed.
    expect(offenders).toEqual([]);
  });

  it('the method that would have written it is gone', () => {
    const entity = files.find(({ path }) =>
      path.endsWith(join('entities', 'llm-provider.entity.ts')),
    )!.src;
    expect(entity).not.toContain('updateHealthStatus(');
    expect(LlmProviderStatus.ERROR).toBe('error');
  });
});

describe('the onboarding gate asks about health', () => {
  const onboarding = files.find(({ path }) =>
    path.endsWith(join('modules', 'onboarding', 'onboarding.service.ts')),
  )!.src;

  it('hasHealthyProvider reads isHealthy and requires an active provider', () => {
    const start = onboarding.indexOf('private async hasHealthyProvider(');
    expect(start).toBeGreaterThan(-1);
    const body = onboarding.slice(start, onboarding.indexOf('\n  }', start));
    expect(body).toContain('isHealthy: true');
    expect(body).toContain('LlmProviderStatus.ACTIVE');
  });
});
