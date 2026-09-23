import { Model } from '../../../../entities/model.entity';
import { LlmProviderType } from '../../../../entities/llm-provider-type';
import {
  ScoringUnavailableError,
  canScore,
  resolveScoringRoute,
} from '../scoring-route';

/**
 * Whether a card can serve `decide`'s logits path, and what it says when
 * it cannot.
 *
 * The refusal is the part under test. A platform that answers "scoring is
 * not available" leaves an operator with 39 provider types to work
 * through; one that names the provider and says which half is missing
 * leaves them with one thing to do.
 */

function card(overrides: Partial<Model> = {}): Model {
  const m = new Model();
  m.id = 'card-1';
  m.vendorModelId = 'qwen3-8b';
  m.capabilities = {};
  m.endpointRef = null;
  return Object.assign(m, overrides);
}

const hostedProvider = { type: LlmProviderType.OPENAI, getApiUrl: () => 'https://api.openai.com/v1' };

describe('resolveScoringRoute: refusing, and naming the provider', () => {
  it('refuses a card that never passed a scoring validation run', () => {
    // Declaring a capability is not having one. The support rule this
    // platform runs on says a passed run is what turns a belief into a
    // capability, and scoring is not exempt from it.
    expect(() => resolveScoringRoute(hostedProvider, card())).toThrow(ScoringUnavailableError);

    try {
      resolveScoringRoute(hostedProvider, card());
      fail('expected a refusal');
    } catch (error) {
      const e = error as ScoringUnavailableError;
      expect(e.code).toBe('CARD_NOT_VALIDATED_FOR_SCORING');
      expect(e.providerType).toBe('openai');
      expect(e.message).toContain('openai');
      expect(e.message).toContain('qwen3-8b');
    }
  });

  it('refuses a validated card whose surface has no scoring route, and says why', () => {
    // This is the common case and the one the mode exists in tension with:
    // a hosted chat-completions vendor cannot score a string it did not
    // choose, however good the model is.
    const validated = card({ capabilities: { scoring: true } });

    try {
      resolveScoringRoute(hostedProvider, validated);
      fail('expected a refusal');
    } catch (error) {
      const e = error as ScoringUnavailableError;
      expect(e.code).toBe('NO_SCORING_ROUTE');
      expect(e.providerType).toBe('openai');
      expect(e.message).toContain('openai');
      // The reason has to be in the message. "Not supported" sends an
      // operator to the wrong place; "chat completions only" does not.
      expect(e.message).toMatch(/chat completions/i);
    }
  });


  it('refuses an unvalidated card even when its route is perfectly good', () => {
    // The actual fail-open risk. A card wired to a real scoring endpoint
    // but with no passed run is the one a resolver is tempted to let
    // through, because everything it needs is present. What is absent is
    // the evidence that the endpoint answers, and serving the logits path
    // off an untested route is how a caller gets an exception where they
    // expected a distribution.
    const routedButUnproven = card({
      capabilities: {},
      endpointRef: {
        url: 'https://vllm.internal.example/v1',
        scoring: { protocol: 'openai_completions_echo', path: '/completions' },
      },
    });

    try {
      resolveScoringRoute({ type: LlmProviderType.CUSTOM }, routedButUnproven);
      fail('expected a refusal');
    } catch (error) {
      expect((error as ScoringUnavailableError).code).toBe('CARD_NOT_VALIDATED_FOR_SCORING');
    }
  });
  it('refuses a card with a route but nowhere to send it', () => {
    const noBase = card({
      capabilities: { scoring: true },
      endpointRef: { scoring: { protocol: 'openai_completions_echo', path: '/completions' } },
    });

    try {
      resolveScoringRoute({ type: LlmProviderType.CUSTOM }, noBase);
      fail('expected a refusal');
    } catch (error) {
      expect((error as ScoringUnavailableError).code).toBe('NO_BASE_URL');
    }
  });
});

describe('resolveScoringRoute: resolving from registry data', () => {
  it('uses the route the card declares for its own endpoint', () => {
    // The case this whole mechanism exists for: a serving engine the
    // customer runs, reached through a generic provider row, whose base
    // URL is a box rather than a brand.
    const selfHosted = card({
      capabilities: { scoring: true },
      endpointRef: {
        url: 'https://vllm.internal.example/v1',
        scoring: { protocol: 'openai_completions_echo', path: '/completions' },
      },
    });

    const route = resolveScoringRoute({ type: LlmProviderType.CUSTOM }, selfHosted);

    expect(route).toEqual({
      protocol: 'openai_completions_echo',
      url: 'https://vllm.internal.example/v1/completions',
      vendorModelId: 'qwen3-8b',
    });
  });

  it('joins base and path without doubling or dropping a slash', () => {
    const trailing = card({
      capabilities: { scoring: true },
      endpointRef: {
        url: 'https://engine.example/v1/',
        scoring: { protocol: 'tgi_decoder_input_details', path: 'generate' },
      },
    });

    expect(resolveScoringRoute({ type: LlmProviderType.CUSTOM }, trailing).url).toBe(
      'https://engine.example/v1/generate',
    );
  });

  it('prefers the card over the vendor profile', () => {
    // A profile says what a vendor's surface does in general. A card says
    // what the endpoint behind this row actually is. For a box the
    // customer runs, only one of the two can be right.
    const overriding = card({
      capabilities: { scoring: true },
      endpointRef: {
        url: 'https://engine.example/v1',
        scoring: { protocol: 'tgi_decoder_input_details', path: '/generate' },
      },
    });

    const route = resolveScoringRoute(hostedProvider, overriding);

    expect(route.protocol).toBe('tgi_decoder_input_details');
    expect(route.url).toBe('https://engine.example/v1/generate');
  });
});

describe('canScore', () => {
  it('answers false instead of throwing, so the ladder can step down', () => {
    expect(canScore(hostedProvider, card())).toBe(false);
    expect(canScore(hostedProvider, card({ capabilities: { scoring: true } }))).toBe(false);
  });

  it('answers true for a card that resolves', () => {
    const ok = card({
      capabilities: { scoring: true },
      endpointRef: {
        url: 'https://engine.example/v1',
        scoring: { protocol: 'openai_completions_echo', path: '/completions' },
      },
    });

    expect(canScore({ type: LlmProviderType.CUSTOM }, ok)).toBe(true);
  });
});

describe('no code list of providers', () => {
  it('turns a card scoring-capable by data alone, with no provider named anywhere', () => {
    // The guard against the thing this design exists to avoid. Two cards
    // on the SAME provider type, one of which can score and one of which
    // cannot, decided entirely by what is on the card. A code list keyed
    // on provider type could not express this, which is why there is not
    // one.
    const type = LlmProviderType.CUSTOM;
    const boxThatScores = card({
      id: 'card-a',
      capabilities: { scoring: true },
      endpointRef: {
        url: 'https://vllm.internal.example/v1',
        scoring: { protocol: 'openai_completions_echo', path: '/completions' },
      },
    });
    const boxThatDoesNot = card({
      id: 'card-b',
      capabilities: { scoring: true },
      endpointRef: { url: 'https://proxy.example/v1' },
    });

    expect(canScore({ type }, boxThatScores)).toBe(true);
    expect(canScore({ type }, boxThatDoesNot)).toBe(false);
  });
});
