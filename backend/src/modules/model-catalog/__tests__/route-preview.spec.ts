import { ValidationPipe } from '@nestjs/common';

import { RoutePreviewBodyDto } from '../dto/model-catalog-controller.dto';
import { Model } from '../../../entities/model.entity';
import { ModelRouterService } from '../routing/model-router.service';

/**
 * L3 gate: `plan()` is callable with no agent, and preview shows chosen
 * and rejected with reasons.
 *
 * The DTO half runs through the real ValidationPipe rather than calling
 * the service directly, because a policy submitted over HTTP crosses that
 * boundary and a shape that the pipe refuses is a shape the feature does
 * not have. A controller DTO that silently rejected every valid body is
 * exactly how the deployment feature shipped unreachable this week.
 */
describe('the routing policy crosses the HTTP boundary intact', () => {
  const pipe = new ValidationPipe({ transform: true });
  const meta = { type: 'body' as const, metatype: RoutePreviewBodyDto };

  it('accepts a policy with no agent, no model and no provider named', async () => {
    await expect(pipe.transform({ objective: 'cheapest' }, meta)).resolves.toMatchObject({ objective: 'cheapest' });
    await expect(pipe.transform({}, meta)).resolves.toEqual({});
  });

  it('accepts the whole policy shape the editor sends', async () => {
    const body = {
      objective: 'fastest',
      privacyTier: 'private_cloud',
      regions: ['eu-central'],
      capabilities: { tools: true },
      fallbackChain: ['card-a', 'card-b'],
      pinnedModel: 'card-a',
      budgetHeadroomCents: 500,
      connectionPreference: ['prov-a', 'openai'],
    };
    await expect(pipe.transform(body, meta)).resolves.toMatchObject(body);
  });

  it('refuses an objective that is not one of the three', async () => {
    await expect(pipe.transform({ objective: 'cleverest' }, meta)).rejects.toThrow();
  });

  it('refuses a negative budget, which would silently pass everything', async () => {
    await expect(pipe.transform({ budgetHeadroomCents: -1 }, meta)).rejects.toThrow();
  });
});

describe('preview answers with the decision, and never with a credential', () => {
  function card(id: string, name: string, inPerMTok: number): Model {
    return Object.assign(new Model(), {
      id,
      organizationId: 'org',
      name,
      vendorModelId: `vendor/${id}`,
      providerId: `prov-${id}`,
      providerType: 'openai',
      modelVersionId: null,
      status: 'active',
      validationStatus: 'passed',
      privacyTier: 'public',
      region: 'eu-central',
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

  const cheap = card('a', 'Cheap', 1);
  const dear = card('b', 'Dear', 9);

  function makeService(cards: Model[]): ModelRouterService {
    const service = Object.create(ModelRouterService.prototype) as ModelRouterService;
    Object.assign(service, {
      models: { find: async () => cards },
      // Every card is callable, with a provider row that carries a secret.
      providerFor: async () => ({
        id: 'p1',
        name: 'OpenAI',
        isHealthy: true,
        status: 'active',
        configuration: { apiKey: 'sk-super-secret' },
      }),
    });
    return service;
  }

  it('orders the candidates and explains each one', async () => {
    const out = await makeService([dear, cheap]).preview('org', { objective: 'cheapest' });
    expect(out.candidates.map((c) => c.modelId)).toEqual(['a', 'b']);
    expect(out.candidates[0].rationale).toContain('cheapest');
    expect(out.candidates[0]).toMatchObject({ name: 'Cheap', vendorModelId: 'vendor/a', privacyTier: 'public', region: 'eu-central' });
    expect(out.candidates[0].blendedPricePerMTok).toBeCloseTo(1 * 0.75 + 3 * 0.25);
  });

  it('says why a model was rejected rather than leaving it out silently', async () => {
    const out = await makeService([cheap, dear]).preview('org', {
      objective: 'cheapest',
      privacyTier: 'local',
    });
    expect(out.candidates).toHaveLength(0);
    expect(out.rejected.length).toBeGreaterThan(0);
    for (const r of out.rejected) expect(r.reason.length).toBeGreaterThan(0);
  });

  it('never returns a provider row, because those carry credentials', async () => {
    const out = await makeService([cheap]).preview('org', {});
    expect(JSON.stringify(out)).not.toContain('sk-super-secret');
    expect(JSON.stringify(out)).not.toContain('apiKey');
    expect(out.candidates[0]).not.toHaveProperty('provider');
    expect(out.candidates[0]).not.toHaveProperty('card');
  });
});
