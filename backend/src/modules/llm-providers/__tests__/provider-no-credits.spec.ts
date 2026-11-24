import { Model } from '../../../entities/model.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';
import { fakeRepository } from '../../../test/fake-repository';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { NO_CREDITS_REASON, PROVIDER_NO_CREDITS, ProviderOutOfCreditsError, isKeyRejection, isOutOfCredits, isOutOfCreditsResponse, withNoCreditsReason } from '../model-errors';
import { ModelRouterService } from '../../model-catalog/routing/model-router.service';
import { ModelCatalogService } from '../../model-catalog/model-catalog.service';
import { GONE_REASONS } from '../../model-catalog/notices/model-change';
import { AgentVerifierHelper, NO_CREDITS_RULE, UNAVAILABLE_RULE } from '../../agents/agent-verifier.helper';
import { unverifiedLine, unverifiedReason } from '../../agents/unverified-answer';

/**
 * Founder's associate demo, staging 2026-11-24 (run daf10ea8): Gemini was
 * offered as a usable answer-check reviewer, but its account had no
 * credits. Google answered 402 "Your prepayment credits are depleted", and
 * the run said only "the checker could not give a verdict". A payment
 * refusal takes the provider's models out of the lists, the way a refused
 * key does (docs/models.md, Readiness), and the run says why.
 */
const GOOGLE_402 = {
  response: {
    status: 402,
    data: { error: { code: 402, message: 'Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billing.', status: 'PAYMENT_REQUIRED' } },
  },
};
const PROVIDER = '3f1c2a4e-0b7d-4c1e-9a55-2d6f8e1b0c9a';

describe('a provider whose account has no credits', () => {
  describe('recognising the answer', () => {
    it.each([
      ['Google 402', 402, GOOGLE_402.response.data],
      ['OpenAI insufficient_quota', 429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.' } }],
      ['Anthropic credit balance', 400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }],
    ])('%s is out of credits', (_name, status, body) => {
      expect(isOutOfCreditsResponse(status, body)).toBe(true);
      expect(isOutOfCredits({ response: { status, data: body } })).toBe(true);
    });

    it('a per-minute rate limit, a refused key or an outage is not', () => {
      expect(isOutOfCreditsResponse(429, { error: { message: 'Rate limit reached for requests per minute' } })).toBe(false);
      expect(isOutOfCredits({ response: { status: 401, data: { error: { message: 'Incorrect API key provided' } } } })).toBe(false);
      expect(isOutOfCredits({ response: { status: 503 } })).toBe(false);
    });

    it('says the reason once, also over the typed error a key check reads back (staging, 2026-11-24)', () => {
      const typed = new ProviderOutOfCreditsError(PROVIDER, 'google', 'Your prepayment credits are depleted.').message;
      expect(withNoCreditsReason(typed)).toBe(typed);
      expect(withNoCreditsReason('Your prepayment credits are depleted.')).toBe(`${NO_CREDITS_REASON} Your prepayment credits are depleted.`);
      expect(withNoCreditsReason('')).toBe(NO_CREDITS_REASON);
    });
    it('the typed error says it in plain words and is not read as a refused key', () => {
      const err = new ProviderOutOfCreditsError(PROVIDER, 'google', 'Your prepayment credits are depleted.');
      expect(err.code).toBe(PROVIDER_NO_CREDITS);
      expect(err.message.startsWith("The provider's account has no credits")).toBe(true);
      expect(isOutOfCredits(err)).toBe(true);
      expect(isKeyRejection(err)).toBe(false);
    });
  });

  describe('a real call', () => {
    function build(dispatch: jest.Mock) {
      const router = { markProviderOutOfCredits: jest.fn().mockResolvedValue(undefined), markModelNotFound: jest.fn() };
      const runner = new LlmChatRunnerHelper(
        {} as any, {} as any, {} as any,
        { warmOrg: jest.fn().mockResolvedValue(undefined) } as any,
        { resolve: jest.fn(), invalidate: jest.fn() } as any,
        router as any,
      );
      runner.dispatchProviderCall = dispatch as any;
      runner.sleep = jest.fn().mockResolvedValue(undefined);
      return { runner, router };
    }
    const provider = Object.assign(new LlmProvider(), { id: PROVIDER, organizationId: 'org', type: LlmProviderType.GOOGLE, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: { model: 'gemini-2.5-pro' } });
    const session = { id: 'conv', organizationId: 'org' } as any;

    it('throws the typed error and takes the provider out, without retrying', async () => {
      const dispatch = jest.fn().mockRejectedValue(GOOGLE_402);
      const { runner, router } = build(dispatch);
      await expect(runner.callWithRetries(provider, { messages: [], model: 'gemini-2.5-pro' }, session, [])).rejects.toBeInstanceOf(ProviderOutOfCreditsError);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(router.markProviderOutOfCredits).toHaveBeenCalledWith('org', PROVIDER, expect.stringContaining('prepayment credits are depleted'));
    });

    it('a 429 insufficient_quota is not retried as a rate limit', async () => {
      const dispatch = jest.fn().mockRejectedValue({ response: { status: 429, data: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } } });
      const { runner } = build(dispatch);
      await expect(runner.callWithRetries(provider, { messages: [], model: 'gpt-5' }, session, [])).rejects.toMatchObject({ code: PROVIDER_NO_CREDITS });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });

  describe('readiness', () => {
    const card = (over: Partial<Model>): Partial<Model> => ({
      organizationId: 'org', name: 'card', providerId: PROVIDER, providerType: 'google', endpointRef: null, capabilities: {}, privacyTier: 'public',
      status: 'active', validationStatus: 'passed', metadata: { checkedBy: 'provider_check' }, ...over,
    });

    it('a call refused for payment marks every checked model of the provider unavailable, with the reason', async () => {
      const models = fakeRepository<Model>({
        make: () => new Model(),
        seed: [
          card({ id: 'pro', vendorModelId: 'gemini-2.5-pro' }),
          card({ id: 'flash', vendorModelId: 'gemini-2.5-flash' }),
          card({ id: 'own-failure', vendorModelId: 'gemini-old', validationStatus: 'failed', status: 'error', metadata: {} }),
          card({ id: 'other-org', organizationId: 'org2', vendorModelId: 'gemini-2.5-pro' }),
        ],
      });
      const providers = fakeRepository<LlmProvider>({
        make: () => new LlmProvider(),
        seed: [{ id: PROVIDER, organizationId: 'org', name: 'Gemini', type: LlmProviderType.GOOGLE, status: LlmProviderStatus.ACTIVE, isHealthy: true, lastHealthCheckAt: new Date(), configuration: {} } as any],
      });
      const changes = { modelsChanged: jest.fn().mockResolvedValue(undefined) };
      const audit = { log: jest.fn().mockResolvedValue(null) };
      const router = new ModelRouterService(models as any, providers as any, fakeRepository() as any, audit as any, undefined, undefined, changes as any);

      await router.markProviderOutOfCredits('org', PROVIDER, 'Your prepayment credits are depleted.');

      for (const id of ['pro', 'flash']) {
        const m = models.row(id)!;
        expect(m.isSelectable()).toBe(false);
        expect(m.lastValidationError).toBe(`${NO_CREDITS_REASON} Your prepayment credits are depleted.`);
        expect(m.metadata?.unavailableReason).toBe('no_credits');
      }
      expect(models.row('own-failure')!.validationStatus).toBe('failed');
      expect(models.row('other-org')!.isSelectable()).toBe(true);
      const row = providers.row(PROVIDER)!;
      expect(row.isHealthy).toBe(false);
      expect(row.lastError).toContain(NO_CREDITS_REASON);
      expect(changes.modelsChanged).toHaveBeenCalledWith(expect.objectContaining({ gone: expect.arrayContaining([expect.objectContaining({ reason: GONE_REASONS.noCredits })]) }));
    });

    it('a key check refused for payment does the same; the next passing check restores them', async () => {
      const models = fakeRepository<Model>({ make: () => new Model(), seed: [card({ id: 'pro', vendorModelId: 'gemini-2.5-pro' })] });
      const providers = fakeRepository<LlmProvider>({ make: () => new LlmProvider(), seed: [{ id: PROVIDER, organizationId: 'org', name: 'Gemini', type: LlmProviderType.GOOGLE, status: LlmProviderStatus.ACTIVE, isHealthy: true, configuration: {} } as any] });
      const svc = new ModelCatalogService(models as any, fakeRepository() as any, providers as any, {} as any, {} as any, {} as any, { lookup: jest.fn() } as any);

      expect(await svc.applyProviderCheck('org', PROVIDER, { passed: false, outOfCredits: true, error: 'Your prepayment credits are depleted.' })).toBe(1);
      expect(models.row('pro')!.isSelectable()).toBe(false);
      expect(models.row('pro')!.lastValidationError).toBe(`${NO_CREDITS_REASON} Your prepayment credits are depleted.`);

      await svc.applyProviderCheck('org', PROVIDER, { passed: true });
      expect(models.row('pro')!.isSelectable()).toBe(true);
      expect(models.row('pro')!.metadata?.unavailableReason).toBeUndefined();
    });
  });

  describe('the run', () => {
    it('says the checker could not give a verdict because its provider has no credits', async () => {
      const chat = jest.fn().mockRejectedValue(new ProviderOutOfCreditsError(PROVIDER, 'google', 'Your prepayment credits are depleted.'));
      const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'brief', checkers: [{ name: 'checker_1', providerId: PROVIDER }], evidence: 'REQUEST:\nx' }, 'org');
      expect(panel.unavailable).toBe(true);
      expect(panel.failures[0]).toMatchObject({ rule: NO_CREDITS_RULE, code: 'verification_unavailable' });
      expect(unverifiedReason(panel.failures)).toBe(NO_CREDITS_RULE);
      expect(unverifiedLine(panel.failures)).toBe(`Note: this answer could not be checked: ${NO_CREDITS_RULE}.`);
    });

    it('a checker that failed for another reason keeps the plain wording', async () => {
      const chat = jest.fn().mockRejectedValue({ response: { status: 503, data: { error: { message: 'overloaded' } } } });
      const panel = await new AgentVerifierHelper({ chat } as any).runPanel({ target: 'brief', checkers: [{ name: 'c', providerId: PROVIDER }] }, 'org');
      expect(panel.failures[0].rule).toBe(UNAVAILABLE_RULE);
      expect(unverifiedReason(panel.failures)).toBe(UNAVAILABLE_RULE);
    });
  });
});
