import { readFileSync } from 'fs';
import { join } from 'path';

import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmModelsHelper } from '../llm-models.helper';

/**
 * A call is priced on the model that went on the wire.
 *
 * Provider implementations send `requireModel(request, provider)` —
 * `request.model` first, the provider's configured model second — but
 * `calculateProviderCost` read only `provider.configuration.model`. So a
 * routed call, an `llm_call` node naming its own model, and every
 * OpenAI-compatible request were all priced at whatever the provider row
 * happened to be configured with, and a provider with no configured model
 * (the supported "let the vendor's list decide" flow) was priced at
 * exactly zero.
 *
 * That number is real money: it is `response.cost`, which lands on the
 * `model_routed` audit row's `cost` column, on the session and provider
 * spend counters (x100, in cents), and in `AgentRun.totalCost`, which
 * `checkRunLimits` compares against `maxCostCents`. Priced at zero, the
 * run cost ceiling can never trip.
 */
function providerWith(model?: string): LlmProvider {
  const p = new LlmProvider();
  p.id = 'p-1';
  p.type = LlmProviderType.OPENAI;
  p.configuration = { model } as any;
  return p;
}

describe('calculateProviderCost prices the model that was actually called', () => {
  let helper: LlmModelsHelper;

  beforeEach(() => {
    // No price feed: the offline seed table answers, which is the same
    // lookup shape the feed uses and keeps the numbers stable here.
    helper = new LlmModelsHelper(undefined as any);
  });

  it('uses the requested model over the provider s configured one', () => {
    const provider = providerWith('gpt-4o-mini');
    // 1M in, 1M out. gpt-4 is $30/$60 per million; gpt-4o-mini is $0.15/$0.60.
    const asConfigured = helper.calculateProviderCost(provider, 1_000_000, 1_000_000);
    const asCalled = helper.calculateProviderCost(provider, 1_000_000, 1_000_000, 'gpt-4');
    expect(asConfigured).toBeCloseTo(0.75, 6);
    expect(asCalled).toBeCloseTo(90, 6);
    // The whole point: routing to gpt-4 must not be billed at mini prices.
    expect(asCalled).toBeGreaterThan(asConfigured * 100);
  });

  it('prices a provider that has no configured model from the requested one', () => {
    const provider = providerWith(undefined);
    expect(helper.calculateProviderCost(provider, 1_000_000, 1_000_000)).toBe(0);
    expect(helper.calculateProviderCost(provider, 1_000_000, 1_000_000, 'gpt-4o')).toBeCloseTo(12.5, 6);
  });

  it('still honours metadata pricing for the provider s own configured model', () => {
    const provider = providerWith('gpt-4o-mini');
    provider.metadata = { modelInfo: { inputTokenCost: 1, outputTokenCost: 2 } };
    expect(helper.calculateProviderCost(provider, 1000, 1000, 'gpt-4o-mini')).toBeCloseTo(3, 6);
    expect(helper.calculateProviderCost(provider, 1000, 1000)).toBeCloseTo(3, 6);
  });

  it('does not apply that metadata pricing to a different model', () => {
    const provider = providerWith('gpt-4o-mini');
    provider.metadata = { modelInfo: { inputTokenCost: 1, outputTokenCost: 2 } };
    // gpt-4 at 1000/1000 tokens: 0.03 + 0.06, not the provider-level 3.
    expect(helper.calculateProviderCost(provider, 1000, 1000, 'gpt-4')).toBeCloseTo(0.09, 6);
  });
});

/**
 * Source-reading guard.
 *
 * The behaviour above passes with the fourth argument present and nothing
 * passing it — which is exactly the shape of defect the project has hit
 * nine times. These assert the two call sites where the cost function is
 * built, because that is the wiring a behavioural test cannot see.
 */
describe('guard: every dispatch site prices on the request s model', () => {
  const read = (file: string) => readFileSync(join(__dirname, '..', file), 'utf8');

  it('the runner s dispatch passes request.model into the cost function', () => {
    const source = read('llm-chat-runner.helper.ts');
    const dispatch = source.slice(source.indexOf('async dispatchProviderCall'), source.indexOf('withCallTimeout<T>'));
    expect(dispatch).toMatch(/const costFn =[\s\S]{0,400}?calculateProviderCost\([^)]*request\.model\)/);
    // A bare bind() cannot carry the request, so it is the shape to refuse.
    expect(dispatch).not.toContain('calculateProviderCost.bind(');
  });

  it('the streaming path passes request.model into the cost function', () => {
    const source = read('llm-chat.helper.ts');
    expect(source).toMatch(/const costFn =[\s\S]{0,400}?calculateProviderCost\([^)]*request\.model\)/);
    expect(source).not.toContain('calculateProviderCost.bind(');
  });
});

/**
 * Source-reading guard for the routed non-streaming fallback.
 *
 * `chatStream` erases `request.routing` and pins `request.model` to the
 * head of the plan before it decides whether the provider can stream. A
 * provider that cannot (Gemini, a custom endpoint) fell back to `chat()`
 * with that mutated request and an undefined providerId, so chat() replanned
 * with an EMPTY policy — privacyTier, regions, capabilities and the price
 * ceiling all silently dropped — and none of the three routing stamps
 * (response, node result, audit row) was written. The safety net six lines
 * below had always passed `originalRequest`; this branch had not.
 */
describe('guard: the routed streaming fallback keeps the caller s policy', () => {
  const source = readFileSync(join(__dirname, '..', 'llm-chat.helper.ts'), 'utf8');

  it('hands the original request to chat() when the provider cannot stream', () => {
    const branch = source.slice(source.indexOf('if (!supportsStreaming)'));
    const call = branch.slice(0, branch.indexOf('\n      }') + 1);
    expect(call).toContain('this.chat(providerId, originalRequest, organizationId, userId)');
  });

  it('never hands it the request whose routing policy was erased', () => {
    // Only after `originalRequest` is captured: the early no-onChunk
    // return above that line is handed the request untouched and is fine.
    const afterCapture = source.slice(source.indexOf('const originalRequest = request;'));
    expect(afterCapture).not.toContain('this.chat(providerId, request, organizationId, userId)');
  });
});
