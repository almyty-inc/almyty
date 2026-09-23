import { readFileSync } from 'fs';
import { join } from 'path';

import { eligible } from '../../model-catalog/routing/model-router';
import type { Model } from '../../../entities/model.entity';

/**
 * `AgentRole.requirement` is the durable statement of what a role's job
 * needs. Until this was wired, `requirementToPolicy()` mapped three of its
 * six fields and dropped the rest: `minContext`, `maxBlendedPrice` and
 * `tags` were written by the API, stored in jsonb, and read by nothing. A
 * role that said "at least 200k of context, never above $3/M" resolved
 * happily to a 4k card on a frontier model, and nothing said so.
 *
 * Source-reading on purpose. The failure mode is the ABSENCE of a mapping,
 * and every behavioural test of `requirementToPolicy` passes just as
 * happily when a field is missing from both the function and the test --
 * which is exactly how this survived a test suite. Only a test that reads
 * the entity and the mapper side by side notices the two lists drifting.
 *
 * What it guards:
 *   1. every field RoleRequirement declares is read by requirementToPolicy;
 *   2. every RoutingPolicy key requirementToPolicy sets is consulted by
 *      eligible() -- mapping a field onto a policy key the router ignores
 *      is the same bug one layer down;
 *   3. the two new filters actually reject, including the unprovable case
 *      (a card with no context length, or no price), which is where a lazy
 *      implementation leaks.
 */
const SRC = join(__dirname, '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const entity = read('entities', 'agent-role.entity.ts');
const service = read('modules', 'agents', 'agent-roles.service.ts');
const router = read('modules', 'model-catalog', 'routing', 'model-router.ts');

/** Everything from a top-level declaration to the closing brace in column 0. */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

const mapperBody = () => bodyOf(service, 'export function requirementToPolicy(');
const eligibleBody = () => bodyOf(router, 'export function eligible(');

describe('every RoleRequirement field reaches the router', () => {
  // Field names come out of the interface itself, so a field added there
  // later fails here until the mapper handles it.
  const block = bodyOf(entity, 'export interface RoleRequirement {');
  const fields = [...block.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);

  it('finds the interface and its fields', () => {
    expect([...fields].sort()).toEqual([
      'capabilities',
      'maxBlendedPrice',
      'minContext',
      'privacyTierCeiling',
      'region',
    ]);
  });

  it.each(fields)('requirementToPolicy reads r.%s', (field) => {
    expect(mapperBody()).toMatch(new RegExp(String.raw`\br\.${field}\b`));
  });
});

describe('every policy key the mapper sets is consulted by eligible()', () => {
  // `policy.x = ...` -- the keys this mapper claims the router understands.
  const keys = [...mapperBody().matchAll(/policy\.(\w+)\s*=/g)].map((m) => m[1]);

  it('sets one key per mapped requirement field', () => {
    expect([...keys].sort()).toEqual([
      'capabilities',
      'maxBlendedPricePerMTok',
      'minContextLength',
      'privacyTier',
      'regions',
    ]);
  });

  it.each(keys)('eligible() reads policy.%s', (key) => {
    expect(eligibleBody()).toMatch(new RegExp(String.raw`policy\??\.${key}\b`));
  });
});

describe('the two new filters actually reject', () => {
  const card = (over: Record<string, unknown>): Model =>
    ({
      id: 'm1',
      status: 'active',
      providerId: 'p1',
      validationStatus: 'passed',
      privacyTier: 'public',
      region: null,
      capabilities: {},
      contextLength: 200_000,
      pricing: { inPerMTok: 1, outPerMTok: 1 },
      pricingOverride: null,
      isSelectable(): boolean {
        return true;
      },
      effectivePricing(): unknown {
        return (this as Record<string, unknown>).pricing;
      },
      ...over,
    }) as unknown as Model;

  it('accepts a card that clears both bars', () => {
    expect(eligible(card({}), { minContextLength: 128_000, maxBlendedPricePerMTok: 5 })).toEqual({
      ok: true,
    });
  });

  it('rejects a context window below the minimum', () => {
    expect(eligible(card({ contextLength: 4_096 }), { minContextLength: 128_000 }).ok).toBe(false);
  });

  it('rejects a card whose context window is unknown -- it cannot prove it qualifies', () => {
    expect(eligible(card({ contextLength: null }), { minContextLength: 128_000 }).ok).toBe(false);
  });

  it('rejects a card above the blended price ceiling', () => {
    const dear = card({ pricing: { inPerMTok: 40, outPerMTok: 80 } });
    expect(eligible(dear, { maxBlendedPricePerMTok: 5 }).ok).toBe(false);
  });

  it('rejects an unpriced card against a ceiling -- unpriced is not free', () => {
    expect(eligible(card({ pricing: null }), { maxBlendedPricePerMTok: 5 }).ok).toBe(false);
  });

  it('leaves both filters off when the policy says nothing', () => {
    expect(eligible(card({ contextLength: null, pricing: null }), {})).toEqual({ ok: true });
  });
});
