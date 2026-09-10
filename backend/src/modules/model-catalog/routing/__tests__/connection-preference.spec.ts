import { Model } from '../../../../entities/model.entity';
import { selectCandidates } from '../model-router';

/**
 * L3 gate: connectionPreference beats cost ranking.
 *
 * Which account runs a model is a commercial decision, usually already
 * made before we see the request: committed cloud spend, a negotiated
 * contract, a direct vendor relationship. Cost ranking does not get to
 * overturn it. See docs/design/layers.md, L3.
 */
function card(id: string, providerId: string, inPerMTok: number, providerType = 'openai'): Model {
  return Object.assign(new Model(), {
    id,
    organizationId: 'org',
    name: id,
    vendorModelId: id,
    providerId,
    providerType,
    modelVersionId: null,
    status: 'active',
    validationStatus: 'passed',
    privacyTier: 'public',
    capabilities: {},
    pricing: { inPerMTok, outPerMTok: inPerMTok * 3, currency: 'USD' },
    effectivePricing() {
      return this.pricing;
    },
    isSelectable() {
      return true;
    },
  });
}

describe('connectionPreference', () => {
  // cheap-other is genuinely cheaper. That is the point: preference has to
  // win anyway, or it is not a preference.
  const cards = [
    card('cheap-other', 'prov-b', 1),
    card('dear-preferred', 'prov-a', 10),
    card('mid-other', 'prov-c', 5),
  ];

  it('ranks a dearer model on the preferred account above a cheaper one elsewhere', () => {
    const { candidates } = selectCandidates(cards, { objective: 'cheapest', connectionPreference: ['prov-a'] });
    expect(candidates[0].modelId).toBe('dear-preferred');
  });

  it('still ranks by cost inside a preference band, not across bands', () => {
    const { candidates } = selectCandidates(cards, {
      objective: 'cheapest',
      connectionPreference: ['prov-a'],
    });
    // prov-a first, then the rest in cost order among themselves.
    expect(candidates.map((c) => c.modelId)).toEqual(['dear-preferred', 'cheap-other', 'mid-other']);
  });

  it('honours the order of the preference list, not just membership', () => {
    const { candidates } = selectCandidates(cards, {
      objective: 'cheapest',
      connectionPreference: ['prov-c', 'prov-a'],
    });
    expect(candidates.map((c) => c.modelId)).toEqual(['mid-other', 'dear-preferred', 'cheap-other']);
  });

  it('prefers by provider type too, so a preference can name a vendor rather than an account', () => {
    const mixed = [card('on-groq', 'p1', 1, 'groq'), card('on-openai', 'p2', 9, 'openai')];
    const { candidates } = selectCandidates(mixed, { objective: 'cheapest', connectionPreference: ['openai'] });
    expect(candidates[0].modelId).toBe('on-openai');
  });

  it('does not exclude an unnamed provider, only rank it later', () => {
    const { candidates } = selectCandidates(cards, { objective: 'cheapest', connectionPreference: ['prov-a'] });
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.modelId)).toContain('cheap-other');
  });

  it('changes nothing when no preference is given', () => {
    const { candidates } = selectCandidates(cards, { objective: 'cheapest' });
    expect(candidates.map((c) => c.modelId)).toEqual(['cheap-other', 'mid-other', 'dear-preferred']);
  });

  it('leaves an explicit fallback chain alone, since that is already an order', () => {
    const { candidates } = selectCandidates(cards, {
      fallbackChain: ['cheap-other', 'dear-preferred'],
      connectionPreference: ['prov-a'],
    });
    expect(candidates.map((c) => c.modelId)).toEqual(['cheap-other', 'dear-preferred']);
  });
});
