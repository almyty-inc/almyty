import { Model } from '../../../../entities/model.entity';
import { eligible, selectCandidates } from '../model-router';

const card = (over: Partial<Model>): Model =>
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

describe('eligible', () => {
  it('rejects cards that are not selectable, above the privacy ceiling, outside the regions, or lacking a capability', () => {
    expect(eligible(card({ validationStatus: 'never' }), {}).ok).toBe(false);
    expect(eligible(card({ privacyTier: 'public' }), { privacyTier: 'private_cloud' }).ok).toBe(false);
    expect(eligible(card({ privacyTier: 'local' }), { privacyTier: 'private_cloud' }).ok).toBe(true);
    expect(eligible(card({ region: 'us' }), { regions: ['eu'] }).ok).toBe(false);
    expect(eligible(card({ region: null }), { regions: ['eu'] })).toEqual({ ok: false, reason: 'region unknown, policy requires one of eu' });
    expect(eligible(card({ region: null }), {}).ok).toBe(true);
    expect(eligible(card({ capabilities: { tools: false } }), { capabilities: { tools: true } }).ok).toBe(false);
    expect(eligible(card({ capabilities: { tools: true } }), { capabilities: { tools: true } }).ok).toBe(true);
  });

  it('skips a card a million tokens of which would blow the remaining budget, but never an unpriced one', () => {
    expect(eligible(card({ pricing: { inPerMTok: 50, outPerMTok: 100, currency: 'USD' } }), { budgetHeadroomCents: 500 }).ok).toBe(false);
    expect(eligible(card({ pricing: null }), { budgetHeadroomCents: 500 }).ok).toBe(true);
  });
});

describe('selectCandidates', () => {
  const cheap = card({ id: 'cheap', pricing: { inPerMTok: 0.5, outPerMTok: 2, currency: 'USD' }, measuredLatencyMs: { p50: 900, p95: 1500, updatedAt: 'x' } });
  const fast = card({ id: 'fast', pricing: { inPerMTok: 5, outPerMTok: 20, currency: 'USD' }, measuredLatencyMs: { p50: 200, p95: 400, updatedAt: 'x' } });
  const local = card({ id: 'local', privacyTier: 'local', pricing: { inPerMTok: 0, outPerMTok: 0, currency: 'USD' } });

  it('ranks by blended price by default and says why', () => {
    const { candidates } = selectCandidates([fast, cheap]);
    expect(candidates.map((c) => c.modelId)).toEqual(['cheap', 'fast']);
    expect(candidates[0].rationale).toMatch(/cheapest .*rank 1/);
  });

  it('ranks by measured latency for fastest', () => {
    const { candidates } = selectCandidates([cheap, fast], { objective: 'fastest' });
    expect(candidates.map((c) => c.modelId)).toEqual(['fast', 'cheap']);
  });

  it('puts the pinned card first and the rest by price behind it', () => {
    const { candidates } = selectCandidates([cheap, fast, local], { objective: 'pinned', pinnedModel: 'fast' });
    expect(candidates.map((c) => c.modelId)).toEqual(['fast', 'local', 'cheap']);
    expect(candidates[0].rationale).toBe('pinned');
  });

  it('follows an explicit fallback chain and reports entries it could not honour', () => {
    const { candidates, rejected } = selectCandidates([cheap, fast], { fallbackChain: ['fast', 'missing', 'cheap'] });
    expect(candidates.map((c) => c.modelId)).toEqual(['fast', 'cheap']);
    expect(candidates[0].rationale).toBe('fallback chain position 1');
    expect(rejected).toContainEqual({ modelId: 'missing', reason: 'chain entry not eligible or unknown' });
  });

  it('applies the hard filters before any ranking and lists the rejections', () => {
    const { candidates, rejected } = selectCandidates([cheap, fast, local], { privacyTier: 'local' });
    expect(candidates.map((c) => c.modelId)).toEqual(['local']);
    expect(rejected.map((r) => r.modelId).sort()).toEqual(['cheap', 'fast']);
  });
});
