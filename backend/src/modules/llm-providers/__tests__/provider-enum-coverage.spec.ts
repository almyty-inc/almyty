import { readFileSync } from 'fs';
import { join } from 'path';

import { LlmProviderType } from '../../../entities/llm-provider-type';
import { PROVIDER_PROFILES } from '../provider-profile';

/**
 * Ratchet: every vendor in `LlmProviderType` has a row in
 * `PROVIDER_PROFILES`, unless it is on the allow-list below.
 *
 * Nothing connected the enum to the registry, and the gap was invisible
 * in exactly the way that matters. The published provider table is
 * generated from `PROVIDER_PROFILES`, so a vendor that ships with an
 * entity switch and no profile is a vendor a customer can select in the
 * UI and never find in the docs. Six were in that state when this guard
 * was written, and `providers-doc.spec.ts` was green throughout: it
 * proves the table matches the registry, which says nothing about the
 * registry matching the product.
 *
 * Both directions are asserted, so the allow-list only shrinks: a new
 * enum member without a profile fails here, and an allow-listed member
 * that finally gains one fails here too until it is removed from the
 * list. Moving a vendor off the list is the point, not a chore.
 */

/**
 * Vendors still served by the switches in `llm-provider.entity.ts`
 * rather than by a profile, with why each is awkward to express as a
 * row today. Each is a real, selectable vendor -- this list is a record
 * of unfinished migration, never a parking space for a dead enum value,
 * which is why every entry is checked for a live switch below.
 */
const ON_LEGACY_SWITCHES: Partial<Record<LlmProviderType, string>> = {
  [LlmProviderType.AZURE_OPENAI]:
    'base is per-deployment (resource + deployment id + api-version), not one template. TODO migrate to bases/basesField',
  [LlmProviderType.VERTEX_AI]:
    'mints a short-lived token per call from a service account; needs an auth scheme the profile type has no case for. TODO',
  [LlmProviderType.HUGGINGFACE]:
    'one base per inference endpoint, supplied by the account. TODO migrate with a {dotted.path} base',
  [LlmProviderType.PERPLEXITY]:
    'plain bearer on an OpenAI-compatible surface; no reason left not to be a row. TODO migrate',
  [LlmProviderType.OLLAMA]:
    'keyless local inference, gated by OLLAMA_ALLOW_PRIVATE_URLS; auth scheme none with a non-https base, which the profile shape-guards reject. TODO',
  [LlmProviderType.CUSTOM]:
    'the escape hatch: the customer supplies the base, so there is no built-in row to write. Expected to stay.',
};

const ENTITY = join(__dirname, '../../../entities/llm-provider.entity.ts');

describe('the provider registry covers the provider enum', () => {
  const covered = new Set(PROVIDER_PROFILES.map((p) => p.key));
  const allowed = Object.keys(ON_LEGACY_SWITCHES) as LlmProviderType[];
  const all = Object.values(LlmProviderType);

  it('gives every vendor a profile, or an allow-listed reason', () => {
    // If this fails you added an enum member without a row. Write the
    // row -- a base, an auth header, a path and a listing path -- rather
    // than extending the allow-list. The table in the docs is generated
    // from the rows, so a vendor without one ships undocumented.
    const missing = all.filter((t) => !covered.has(t) && !ON_LEGACY_SWITCHES[t]);
    expect(missing).toEqual([]);
  });

  it('keeps the allow-list shrinking: every entry is still uncovered', () => {
    // A vendor that gained a profile comes off the list in the same
    // change, so the list measures what is left rather than what once
    // was.
    const stale = allowed.filter((t) => covered.has(t));
    expect(stale).toEqual([]);
  });

  it('allow-lists only vendors that really are in the enum', () => {
    const unknown = allowed.filter((t) => !all.includes(t));
    expect(unknown).toEqual([]);
  });

  it('allow-lists only vendors the entity still serves', () => {
    // The allow-list is for an unfinished migration, not a graveyard.
    // A type with neither a profile nor a switch is reachable from
    // nowhere and should be deleted from the enum instead.
    const entity = readFileSync(ENTITY, 'utf8');
    for (const type of allowed) {
      const member = Object.keys(LlmProviderType).find(
        (k) => LlmProviderType[k as keyof typeof LlmProviderType] === type,
      );
      expect(`${type} -> ${entity.includes(`LlmProviderType.${member}`)}`).toBe(`${type} -> true`);
    }
  });

  it('gives every allow-list entry a stated reason', () => {
    for (const [type, reason] of Object.entries(ON_LEGACY_SWITCHES)) {
      expect(`${type}: ${(reason ?? '').trim().length > 20}`).toBe(`${type}: true`);
    }
  });
});
