import { Model } from '../../../../entities/model.entity';
import { eligible, selectCandidates } from '../../routing/model-router';

/**
 * That a routing policy can ask for a scoring-capable model WITHOUT the
 * router being taught about scoring.
 *
 * This is a claim about `model-router.ts`, which is not changed by the
 * `decide` work and must not need to be. Its capability filter iterates
 * whatever keys `ModelCapabilities` declares rather than checking named
 * ones, so a capability added to the entity is routable the moment it
 * exists. That property is the reason the scoring fact went on the card
 * instead of into a table beside the router, and a property nobody tests
 * is a property that gets refactored away by someone who did not know it
 * was load-bearing.
 *
 * If this file ever has to change to keep passing, the filter has been
 * turned into a list of known capabilities and `decide` is not the only
 * thing that broke.
 */

function card(id: string, capabilities: Model['capabilities']): Model {
  const m = new Model();
  m.id = id;
  m.vendorModelId = id;
  m.providerId = 'provider-1';
  m.status = 'active';
  m.validationStatus = 'passed';
  m.privacyTier = 'private_cloud';
  m.capabilities = capabilities;
  m.pricing = { inPerMTok: 1, outPerMTok: 2, currency: 'USD' };
  return m;
}

describe('a routing policy asking for scoring', () => {
  const scorer = card('scorer', { scoring: true, tools: true });
  const chatOnly = card('chat-only', { tools: true });

  it('admits a card that proved it can score', () => {
    expect(eligible(scorer, { capabilities: { scoring: true } })).toEqual({ ok: true });
  });

  it('rejects a card that did not, naming the capability it lacks', () => {
    const verdict = eligible(chatOnly, { capabilities: { scoring: true } });

    expect(verdict.ok).toBe(false);
    expect((verdict as { ok: false; reason: string }).reason).toBe('lacks scoring');
  });

  it('narrows a mixed pool to the scorers, and says why each other card went', () => {
    const { candidates, rejected } = selectCandidates([scorer, chatOnly], {
      capabilities: { scoring: true },
    });

    expect(candidates.map(c => c.modelId)).toEqual(['scorer']);
    expect(rejected).toEqual([{ modelId: 'chat-only', reason: 'lacks scoring' }]);
  });

  it('leaves both in the pool when the policy does not ask for scoring', () => {
    // A capability is a requirement only when a policy states it. Adding
    // one to the entity must not quietly narrow every existing route.
    const { candidates } = selectCandidates([scorer, chatOnly], {});

    expect(candidates.map(c => c.modelId).sort()).toEqual(['chat-only', 'scorer']);
  });

  it('still requires the card to be selectable at all', () => {
    // Scoring is an additional requirement, never a way around the support
    // rule: an unvalidated card that claims scoring is still not routable.
    const unvalidated = card('unvalidated', { scoring: true });
    unvalidated.validationStatus = 'never';

    expect(eligible(unvalidated, { capabilities: { scoring: true } })).toEqual({
      ok: false,
      reason: 'not usable yet',
    });
  });
});
