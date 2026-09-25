import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { LlmProvidersService } from '../llm-providers.service';
import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { Model } from '../../../entities/model.entity';
import { ModelVersion } from '../../../entities/model-version.entity';
import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { Conversation } from '../../../entities/conversation.entity';
import { Message } from '../../../entities/message.entity';
import { User } from '../../../entities/user.entity';
import { Organization } from '../../../entities/organization.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { Tool } from '../../../entities/tool.entity';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { FakeCredentialStore, makeCredentialRefFake } from '../../../test/credential-ref.fake';
import { fakeRepository } from '../../../test/fake-repository';
import { LlmProviderSecretsHelper } from '../llm-provider-secrets.helper';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { LlmChatHelper } from '../llm-chat.helper';
import { LlmStatsHelper } from '../llm-stats.helper';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmModelsHelper } from '../llm-models.helper';
import { DefaultModelResolver } from '../default-model.resolver';
import { ModelCatalogService } from '../../model-catalog/model-catalog.service';
import { ModelRouterService } from '../../model-catalog/routing/model-router.service';
import { providerListsModels } from '../provider-profile';

/**
 * Connect a provider: one request that saves it, checks the key with a real
 * call and lists its models. The provider service, the catalog and the
 * router are the real ones over truthful tables; only the vendor is a
 * double, and it answers the way a vendor does: the right key gets the
 * list and an answer, any other key gets a 401.
 */
const GOOD_KEY = 'sk-good-key-123456';
const VENDOR_MODELS = [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'o4-mini' }];
/** What the other vendors used below list; three models each, like the first. */
const OTHER_VENDORS: Record<string, Array<{ id: string }>> = {
  anthropic: [{ id: 'claude-sonnet-5' }, { id: 'claude-opus-5' }, { id: 'claude-haiku-5' }],
  groq: [{ id: 'llama-4.1-70b-versatile' }, { id: 'qwen3-32b' }, { id: 'deepseek-r2-distill' }],
  // Qwen serves no list on this surface.
  qwen: [],
};

function vendorRefusal(): Error {
  // What axios throws for a refused key: the status on `response`, the
  // words in `message`.
  return Object.assign(new Error('Request failed with status code 401'), {
    response: { status: 401, data: { error: { message: 'Incorrect API key provided' } } },
  });
}

describe('connect a provider', () => {
  let service: LlmProvidersService;
  let catalog: ModelCatalogService;
  let providers: ReturnType<typeof fakeRepository<LlmProvider>>;
  let models: ReturnType<typeof fakeRepository<Model>>;
  let store: FakeCredentialStore;
  let audit: { logDelete: jest.Mock };
  let teamsOf: Record<string, string[]>;

  const member = (id: string) => ({ id, hasPermissionInOrganization: () => true });

  beforeEach(async () => {
    providers = fakeRepository<LlmProvider>({ make: () => new LlmProvider(), idPrefix: 'provider' });
    models = fakeRepository<Model>({ make: () => new Model(), idPrefix: 'model' });
    store = makeCredentialRefFake();
    teamsOf = { 'user-a': ['team-a'], 'user-b': [] };
    audit = { logDelete: jest.fn().mockResolvedValue(null) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LlmProvidersService,
        LlmProviderSecretsHelper,
        LlmModelsHelper,
        LlmChatHelper,
        LlmStatsHelper,
        LlmChatRunnerHelper,
        DefaultModelResolver,
        ModelCatalogService,
        ModelRouterService,
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        { provide: CredentialRefResolver, useValue: store.resolver },
        { provide: getRepositoryToken(LlmProvider), useValue: providers },
        { provide: getRepositoryToken(Model), useValue: models },
        { provide: getRepositoryToken(ModelVersion), useValue: fakeRepository() },
        { provide: getRepositoryToken(ModelDeployment), useValue: fakeRepository() },
        { provide: getRepositoryToken(Conversation), useValue: fakeRepository() },
        { provide: getRepositoryToken(Message), useValue: fakeRepository() },
        { provide: getRepositoryToken(User), useValue: fakeRepository([member('user-a'), member('user-b')] as any) },
        { provide: getRepositoryToken(Organization), useValue: fakeRepository([{ id: 'org-1' }, { id: 'org-2' }]) },
        { provide: getRepositoryToken(Gateway), useValue: fakeRepository() },
        { provide: getRepositoryToken(Tool), useValue: fakeRepository() },
        { provide: ToolExecutorService, useValue: {} },
        {
          provide: AuditLogService,
          useValue: { log: jest.fn().mockResolvedValue(null), logCreate: jest.fn().mockResolvedValue(null), logUpdate: jest.fn().mockResolvedValue(null), ...audit },
        },
        {
          // The access rule that matters here: a team scope is only for a
          // member of that team. Everything else is org-level and allowed.
          provide: AccessPolicyService,
          useValue: {
            canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
            applyListFilter: jest.fn().mockResolvedValue({ bypass: true, teamIds: [] }),
            assertCanScopeToTeam: jest.fn(async (userId: string, _org: string, visibility?: string, teamId?: string | null) => {
              if (visibility === 'team' && !(teamsOf[userId] ?? []).includes(teamId ?? '')) {
                throw new ForbiddenException('You are not a member of that team');
              }
            }),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(LlmProvidersService);
    catalog = moduleRef.get(ModelCatalogService);

    // The vendor. Listing and the probe call both need the right key.
    const modelsHelper = moduleRef.get(LlmModelsHelper);
    jest.spyOn(modelsHelper, 'fetchModelsFromProvider').mockImplementation(async (p: LlmProvider) => {
      if (p.getDecryptedApiKey() !== GOOD_KEY) throw vendorRefusal();
      return (OTHER_VENDORS[p.type] ?? VENDOR_MODELS).map((m) => ({ ...m, name: m.id })) as any;
    });
    const runner = moduleRef.get(LlmChatRunnerHelper);
    jest.spyOn(runner, 'callLlmProvider').mockImplementation(async (p: LlmProvider, req: any) => {
      if (p.getDecryptedApiKey() !== GOOD_KEY) throw vendorRefusal();
      return { message: { role: 'assistant', content: 'hi' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0, model: req.model, responseTime: 3 } as any;
    });
  });

  it('a key that checks out lists the provider models, every one of them usable', async () => {
    const result = await service.connectProvider({ type: LlmProviderType.OPENAI, configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a');

    expect(result.check.ok).toBe(true);
    // Named after the provider when no name is given; org-wide by default.
    expect(result.provider).toMatchObject({ name: 'OpenAI', type: 'openai', visibility: 'org', isHealthy: true });
    expect(result.models.map((m) => m.vendorModelId).sort()).toEqual(['gpt-5', 'gpt-5-mini', 'o4-mini']);
    expect(result.models.every((m) => m.isSelectable())).toBe(true);

    // What the rest of the app reads agrees: the catalog's selectable list.
    const selectable = await catalog.list('org-1', { selectable: true }, 'user-a');
    expect(selectable.map((m) => m.vendorModelId).sort()).toEqual(['gpt-5', 'gpt-5-mini', 'o4-mini']);
    // The key is a credential row, never a provider column.
    expect(providers.rows()[0].configuration.apiKey).toBeUndefined();
    expect(store.rows).toHaveLength(1);
  });

  it('a key the vendor refuses is reported plainly and leaves nothing behind', async () => {
    const attempt = service.connectProvider({ type: LlmProviderType.OPENAI, configuration: { apiKey: 'sk-wrong-key-000000' } }, 'org-1', 'user-a');

    await expect(attempt).rejects.toBeInstanceOf(BadRequestException);
    const response = await attempt.then(() => ({}) as Record<string, any>, (e: BadRequestException) => e.getResponse() as Record<string, any>);
    expect(response).toMatchObject({
      code: 'KEY_REJECTED',
      message: 'OpenAI rejected this key.',
      keyUrl: 'https://platform.openai.com/api-keys',
    });
    expect(response.detail).toContain('401');

    // Nothing saved, nothing selectable, the key row gone, the removal audited.
    expect(providers.rows()).toHaveLength(0);
    expect(models.rows()).toHaveLength(0);
    expect(await catalog.list('org-1', { selectable: true })).toEqual([]);
    expect(store.rows).toHaveLength(0);
    expect(audit.logDelete).toHaveBeenCalledTimes(1);
  });

  it('a vendor with no model list asks for the model before anything is saved or called', async () => {
    const response = await service
      .connectProvider({ type: LlmProviderType.QWEN, configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a')
      .then(() => ({}) as Record<string, any>, (e: BadRequestException) => e.getResponse() as Record<string, any>);

    expect(response).toMatchObject({ code: 'MODEL_REQUIRED', message: 'Qwen (QwenCloud) does not list its models. Enter the model you want to use.' });
    expect(providers.rows()).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
    // The list the connect page reads says which tiles need that field.
    expect(providerListsModels(LlmProviderType.QWEN)).toBe(false);
    expect(providerListsModels(LlmProviderType.VERTEX_AI)).toBe(false);
    expect(providerListsModels(LlmProviderType.OPENAI)).toBe(true);
    expect(providerListsModels(LlmProviderType.CUSTOM)).toBe(true);
  });

  it('a vendor with no model list shows the model the check called, usable', async () => {
    // A database is slower than a Map: the card for the probed model must
    // be written before connect reads the list back, not merely soon.
    const save = models.save.getMockImplementation()!;
    models.save.mockImplementation(async (entity: any) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return save(entity);
    });
    const result = await service.connectProvider(
      { type: LlmProviderType.QWEN, configuration: { apiKey: GOOD_KEY, model: 'qwen3-max' } },
      'org-1',
      'user-a',
    );

    expect(result.models.map((m) => m.vendorModelId)).toEqual(['qwen3-max']);
    expect(result.models[0].isSelectable()).toBe(true);
    expect(models.rows()).toHaveLength(1);
  });

  it('a failure that is not the key says it could not connect, not that the key was wrong', async () => {
    const runner = (service as any).runner as LlmChatRunnerHelper;
    (runner.callLlmProvider as jest.Mock).mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }));

    const response = await service
      .connectProvider({ type: LlmProviderType.ANTHROPIC, configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a')
      .then(() => ({}) as Record<string, any>, (e: BadRequestException) => e.getResponse() as Record<string, any>);

    expect(response).toMatchObject({ code: 'CHECK_FAILED', message: 'Could not connect to Anthropic.', detail: 'connect ETIMEDOUT' });
    expect(providers.rows()).toHaveLength(0);
  });

  it('a private provider and its models are its owner\'s alone', async () => {
    await service.connectProvider(
      { type: LlmProviderType.OPENAI, name: 'My OpenAI', visibility: 'private', configuration: { apiKey: GOOD_KEY } },
      'org-1',
      'user-a',
    );

    expect(providers.rows()[0]).toMatchObject({ name: 'My OpenAI', visibility: 'private', ownerUserId: 'user-a' });
    expect((await catalog.list('org-1', { selectable: true }, 'user-a')).length).toBe(3);
    expect(await catalog.list('org-1', { selectable: true }, 'user-b')).toEqual([]);
  });

  it('a team scope needs a member of that team, and an org-wide one is everyone\'s', async () => {
    await expect(
      service.connectProvider({ type: LlmProviderType.OPENAI, visibility: 'team', teamId: 'team-a', configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-b'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(providers.rows()).toHaveLength(0);

    await service.connectProvider({ type: LlmProviderType.OPENAI, visibility: 'team', teamId: 'team-a', configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a');
    expect(providers.rows()[0]).toMatchObject({ visibility: 'team', teamId: 'team-a' });

    await service.connectProvider({ type: LlmProviderType.GROQ, configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a');
    const groq = providers.rows().find((p) => p.type === LlmProviderType.GROQ)!;
    expect(groq.visibility).toBe('org');
    expect((await catalog.list('org-1', { providerId: groq.id, selectable: true }, 'user-b')).length).toBe(3);
  });

  it('models a provider stops listing are marked unavailable on the next sync', async () => {
    const { provider } = await service.connectProvider({ type: LlmProviderType.OPENAI, configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a');
    VENDOR_MODELS.splice(2, 1); // the vendor retires o4-mini
    try {
      await catalog.syncFromProvider('org-1', provider.id);
      const retired = models.rows().find((m) => m.vendorModelId === 'o4-mini')!;
      expect(retired.isSelectable()).toBe(false);
      expect(retired.metadata?.retiredReason).toBe('not listed by provider');
      expect((await catalog.list('org-1', { selectable: true })).map((m) => m.vendorModelId).sort()).toEqual(['gpt-5', 'gpt-5-mini']);
    } finally {
      VENDOR_MODELS.push({ id: 'o4-mini' });
    }
  });

  it('a key revoked after connecting takes the models out until a check passes again', async () => {
    const { provider } = await service.connectProvider({ type: LlmProviderType.OPENAI, configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a');
    const runner = (service as any).runner as LlmChatRunnerHelper;
    (runner.callLlmProvider as jest.Mock).mockRejectedValueOnce(vendorRefusal());

    const failed = await service.performHealthCheck(provider.id, 'org-1');
    expect(failed).toMatchObject({ isHealthy: false, keyRejected: true });
    expect(await catalog.list('org-1', { selectable: true })).toEqual([]);

    const passed = await service.performHealthCheck(provider.id, 'org-1');
    expect(passed.isHealthy).toBe(true);
    expect((await catalog.list('org-1', { selectable: true })).length).toBe(3);
  });

  it('an outage does not take the models out of the list', async () => {
    const { provider } = await service.connectProvider({ type: LlmProviderType.OPENAI, configuration: { apiKey: GOOD_KEY } }, 'org-1', 'user-a');
    const runner = (service as any).runner as LlmChatRunnerHelper;
    (runner.callLlmProvider as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } }));

    const failed = await service.performHealthCheck(provider.id, 'org-1');
    expect(failed).toMatchObject({ isHealthy: false, keyRejected: false });
    expect((await catalog.list('org-1', { selectable: true })).length).toBe(3);
  });
});
