import { Model } from '../../../../entities/model.entity';
import { eligible, selectCandidates } from '../model-router';

/**
 * A rejection reason is a sentence a person reads when their run did not
 * do what they wanted, so it follows the product's vocabulary rather than
 * ours. No tier, no ceiling, no headroom, no card, no adapter, no slot,
 * and nothing that only makes sense if you have read our code.
 *
 * Written as a guard over every branch rather than as prose assertions,
 * because the failure mode is a NEW reason added later in our own words.
 */
const OUR_WORDS = /\b(tiers?|ceilings?|headrooms?|cards?|adapters?|slots?|fixtures?|conformance|gates?|selectable|co-failure)\b/i;

const model = (over: Partial<Model>): Model =>
  Object.assign(new Model(), {
    id: over.id ?? 'm',
    providerId: 'p1',
    endpointRef: null,
    status: 'active',
    validationStatus: 'passed',
    privacyTier: 'public',
    region: null,
    capabilities: {},
    pricing: { inPerMTok: 1, outPerMTok: 5, currency: 'USD' },
    pricingOverride: null,
    measuredLatencyMs: null,
    modelVersionId: null,
    vendorModelId: over.id ?? 'm',
    ...over,
  });

describe('routing rejection reasons speak the product vocabulary', () => {
  // One case per rejecting branch in `eligible`.
  const branches: Array<[string, Model, Parameters<typeof eligible>[1]]> = [
    ['never validated', model({ validationStatus: 'never' }), {}],
    ['privacy', model({ privacyTier: 'public' }), { privacyTier: 'private_cloud' }],
    ['region unknown', model({ region: null }), { regions: ['eu'] }],
    ['region not allowed', model({ region: 'us' }), { regions: ['eu'] }],
    ['missing capability', model({ capabilities: { tools: false } }), { capabilities: { tools: true } }],
    ['too expensive', model({ pricing: { inPerMTok: 50, outPerMTok: 100, currency: 'USD' } }), { budgetHeadroomCents: 500 }],
  ];

  it.each(branches)('%s', (_name, card, policy) => {
    const result = eligible(card, policy);
    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).not.toMatch(OUR_WORDS);
  });

  it('covers every rejecting branch, so a new one cannot slip past this file', () => {
    // If someone adds a branch, this count fails and they have to come
    // back here rather than quietly shipping a reason in our words.
    const source = require('fs').readFileSync(require('path').join(__dirname, '../model-router.ts'), 'utf8');
    const reasons = source.match(/reason: [`'][^`']+[`']/g) ?? [];
    expect(reasons.length).toBeGreaterThan(0);
    for (const literal of reasons) {
      // Strip the interpolations: `card.privacyTier` is a field name the
      // reader never sees, and only the prose around it is the sentence.
      const prose = literal.replace(/\$\{[^}]*\}/g, '_');
      expect(prose).not.toMatch(OUR_WORDS);
    }
  });

  it('says it in the rejections a caller actually receives, not only in the helper', () => {
    const rejected = selectCandidates(
      [model({ id: 'a', validationStatus: 'never' }), model({ id: 'b', privacyTier: 'public' })],
      { privacyTier: 'local', fallbackChain: ['ghost'] },
    ).rejected;

    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) expect(r.reason).not.toMatch(OUR_WORDS);
  });
});
