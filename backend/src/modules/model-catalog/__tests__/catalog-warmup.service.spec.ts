import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LlmProvidersService } from '../../llm-providers/llm-providers.service';
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
import { makeCredentialRefFake } from '../../../test/credential-ref.fake';
import { fakeRepository } from '../../../test/fake-repository';
import { FakeRedis } from '../../../test/fake-redis';
import { LlmProviderSecretsHelper } from '../../llm-providers/llm-provider-secrets.helper';
import { ToolExecutorService } from '../../tools/tool-executor.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AccessPolicyService } from '../../../common/authorization/access-policy.service';
import { LlmChatHelper } from '../../llm-providers/llm-chat.helper';
import { LlmStatsHelper } from '../../llm-providers/llm-stats.helper';
import { LlmChatRunnerHelper } from '../../llm-providers/llm-chat-runner.helper';
import { LlmModelsHelper } from '../../llm-providers/llm-models.helper';
import { DefaultModelResolver } from '../../llm-providers/default-model.resolver';
import { ModelCatalogService } from '../model-catalog.service';
import { ModelRouterService } from '../routing/model-router.service';
import { ModelCatalogController } from '../model-catalog.controller';
import { CatalogSyncProcessor } from '../catalog-sync.processor';
import { CATALOG_WARMUP_OPTIONS, CatalogWarmupService, WARM_CLAIM_PREFIX } from '../catalog-warmup.service';

/**
 * Providers that existed before connected providers shipped have never been
 * synced and never had their key checked under the readiness rule, so their
 * models are not usable. The boot sync (and, failing that, the sync before
 * each sweep and the one a page load starts) fixes that.
 *
 * The provider service, the catalog, the router and the warmup are the
 * real ones over truthful tables and a truthful Redis. The vendor is a
 * double that answers the way a vendor does: the right key gets the list
 * and an answer, any other key a 401, and while it is down a 503 for
 * everyone. The Postgres advisory lock is modelled below by its
 * documented semantics; the real one is exercised in
 * src/test/integration/catalog-boot-sync.integration.spec.ts.
 */
const GOOD_KEY = 'sk-good-key-123456';
const LISTS: Record<string, Array<{ id: string }>> = {
  openai: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }],
  anthropic: [{ id: 'claude-sonnet-5' }, { id: 'claude-haiku-5' }],
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function vendorError(status: number, message: string): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { error: { message } } },
  });
}

/**
 * Session advisory locks as Postgres keeps them: one holder per key, a
 * session may take a lock it holds again, the holder's unlock (or the end
 * of its session) frees it, and every call is a round trip.
 */
class FakeAdvisoryLocks {
  private readonly held = new Map<string, number>();
  private sessions = 0;

  dataSource(): DataSource {
    return { createQueryRunner: () => this.session() } as unknown as DataSource;
  }

  private session() {
    const id = ++this.sessions;
    const locks = this.held;
    return {
      connect: async () => tick(),
      query: async (sql: string, params: unknown[]) => {
        await tick();
        const key = String(params?.[0]);
        if (/pg_try_advisory_lock\(hashtext\(\$1\)\)/.test(sql)) {
          const holder = locks.get(key);
          if (holder !== undefined && holder !== id) return [{ locked: false }];
          locks.set(key, id);
          return [{ locked: true }];
        }
        if (/pg_advisory_unlock\(hashtext\(\$1\)\)/.test(sql)) {
          if (locks.get(key) !== id) return [{ pg_advisory_unlock: false }];
          locks.delete(key);
          return [{ pg_advisory_unlock: true }];
        }
        throw new Error(`FakeAdvisoryLocks does not model: ${sql}`);
      },
      release: async () => {
        await tick();
        for (const [key, holder] of [...locks]) if (holder === id) locks.delete(key);
      },
    };
  }
}

describe('CatalogWarmupService', () => {
  let service: LlmProvidersService;
  let catalog: ModelCatalogService;
  let warmup: CatalogWarmupService;
  let providers: ReturnType<typeof fakeRepository<LlmProvider>>;
  let models: ReturnType<typeof fakeRepository<Model>>;
  let redis: FakeRedis;
  let locks: FakeAdvisoryLocks;
  let now: number;
  let vendorDown: boolean;
  let vendorCalls: Array<{ providerId: string; type: string; kind: 'chat' | 'list' }>;
  let inFlight: Map<string, number>;
  let maxInFlightPerVendor: number;
  let maxInFlight: number;
  let gate: Promise<void> | null;
  let buildWarmup: () => CatalogWarmupService;

  const member = (id: string) => ({ id, hasPermissionInOrganization: () => true });

  beforeEach(async () => {
    providers = fakeRepository<LlmProvider>({ make: () => new LlmProvider(), idPrefix: 'provider' });
    models = fakeRepository<Model>({ make: () => new Model(), idPrefix: 'model' });
    const store = makeCredentialRefFake();
    now = 1_000_000;
    redis = new FakeRedis(() => now);
    locks = new FakeAdvisoryLocks();
    vendorDown = false;
    vendorCalls = [];
    inFlight = new Map();
    maxInFlightPerVendor = 0;
    maxInFlight = 0;
    gate = null;

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
        CatalogWarmupService,
        { provide: CATALOG_WARMUP_OPTIONS, useValue: { concurrency: 2, vendorGapMs: 0, debounceMs: 10 * 60_000, loadWaitMs: 5_000 } },
        { provide: DataSource, useValue: locks.dataSource() },
        { provide: 'default_IORedisModuleConnectionToken', useValue: redis },
        { provide: EnvelopeCryptoService, useValue: makeEnvelopeCryptoMock() },
        { provide: CredentialRefResolver, useValue: store.resolver },
        { provide: getRepositoryToken(LlmProvider), useValue: providers },
        { provide: getRepositoryToken(Model), useValue: models },
        { provide: getRepositoryToken(ModelVersion), useValue: fakeRepository() },
        { provide: getRepositoryToken(ModelDeployment), useValue: fakeRepository() },
        { provide: getRepositoryToken(Conversation), useValue: fakeRepository() },
        { provide: getRepositoryToken(Message), useValue: fakeRepository() },
        { provide: getRepositoryToken(User), useValue: fakeRepository([member('user-a')] as any) },
        { provide: getRepositoryToken(Organization), useValue: fakeRepository([{ id: 'org-1' }, { id: 'org-2' }]) },
        { provide: getRepositoryToken(Gateway), useValue: fakeRepository() },
        { provide: getRepositoryToken(Tool), useValue: fakeRepository() },
        { provide: ToolExecutorService, useValue: {} },
        { provide: AuditLogService, useValue: { log: jest.fn().mockResolvedValue(null), logCreate: jest.fn().mockResolvedValue(null), logUpdate: jest.fn().mockResolvedValue(null), logDelete: jest.fn().mockResolvedValue(null) } },
        {
          provide: AccessPolicyService,
          useValue: {
            canAccess: jest.fn().mockResolvedValue({ allowed: true, reason: 'ok' }),
            applyListFilter: jest.fn().mockResolvedValue({ bypass: true, teamIds: [] }),
            assertCanScopeToTeam: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(LlmProvidersService);
    catalog = moduleRef.get(ModelCatalogService);
    warmup = moduleRef.get(CatalogWarmupService);
    // A second instance of the API: its own warmup over the same tables,
    // Redis and Postgres.
    buildWarmup = () =>
      new CatalogWarmupService(
        providers as any,
        models as any,
        catalog,
        service,
        locks.dataSource(),
        redis as any,
        { concurrency: 2, vendorGapMs: 0, debounceMs: 10 * 60_000, loadWaitMs: 5_000 },
      );

    const vendor = async (p: LlmProvider, kind: 'chat' | 'list') => {
      vendorCalls.push({ providerId: p.id, type: p.type, kind });
      inFlight.set(p.type, (inFlight.get(p.type) ?? 0) + 1);
      maxInFlightPerVendor = Math.max(maxInFlightPerVendor, inFlight.get(p.type)!);
      maxInFlight = Math.max(maxInFlight, [...inFlight.values()].reduce((a, b) => a + b, 0));
      try {
        await tick();
        if (gate) await gate;
        if (vendorDown) throw vendorError(503, 'The server is overloaded');
        if (p.getDecryptedApiKey() !== GOOD_KEY) throw vendorError(401, 'Incorrect API key provided');
      } finally {
        inFlight.set(p.type, inFlight.get(p.type)! - 1);
      }
    };
    const modelsHelper = moduleRef.get(LlmModelsHelper);
    jest.spyOn(modelsHelper, 'fetchModelsFromProvider').mockImplementation(async (p: LlmProvider) => {
      await vendor(p, 'list');
      return (LISTS[p.type] ?? []).map((m) => ({ ...m, name: m.id })) as any;
    });
    const runner = moduleRef.get(LlmChatRunnerHelper);
    jest.spyOn(runner, 'callLlmProvider').mockImplementation(async (p: LlmProvider, req: any) => {
      await vendor(p, 'chat');
      return { message: { role: 'assistant', content: 'hi' }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0, model: req.model, responseTime: 3 } as any;
    });
  });

  /**
   * A provider as one saved before connected providers shipped: a model it
   * listed back then still waiting on a check, no key check under the
   * readiness rule, never synced. `model` is set so the check probes it
   * without listing first.
   */
  async function legacyProvider(opts: { type?: LlmProviderType; key?: string; org?: string; synced?: boolean } = {}): Promise<LlmProvider> {
    const type = opts.type ?? LlmProviderType.OPENAI;
    const org = opts.org ?? 'org-1';
    const listed = LISTS[type][0].id;
    const provider = await service.createProvider(
      { name: `${type} ${providers.rows().length + 1}`, type, configuration: { apiKey: opts.key ?? GOOD_KEY, model: listed } } as any,
      org,
      'user-a',
      { checkInRequest: true },
    );
    await models.save(
      Object.assign(new Model(), {
        organizationId: org, providerId: provider.id, providerType: type, vendorModelId: listed, name: listed,
        capabilities: {}, privacyTier: 'public', pricingSource: 'unpriced', status: 'active', validationStatus: 'never',
        metadata: { syncedFrom: 'provider_list' },
      }),
    );
    if (opts.synced) await providers.update({ id: provider.id }, { modelsSyncedAt: new Date(now) });
    // Saving it probed the vendor with the key; that is not what is under test.
    vendorCalls = [];
    return (await providers.findOne({ where: { id: provider.id } }))!;
  }

  const cardsOf = async (providerId: string) => models.find({ where: { providerId } });
  const usable = async (providerId: string) => (await cardsOf(providerId)).filter((c) => c.isSelectable()).map((c) => c.vendorModelId).sort();
  const syncedAt = async (providerId: string) => (await providers.findOne({ where: { id: providerId } }))?.modelsSyncedAt ?? null;

  describe('boot', () => {
    it('checks and syncs only the providers that have never been synced, and their models become usable', async () => {
      const legacy = await legacyProvider();
      const synced = await legacyProvider({ type: LlmProviderType.ANTHROPIC, synced: true });

      const result = await warmup.syncNeverSynced('boot');

      expect(result).toMatchObject({ ran: true, providers: 1, synced: 1, keyRejected: 0, failed: 0 });
      expect(await usable(legacy.id)).toEqual(['gpt-5', 'gpt-5-mini']);
      expect(await syncedAt(legacy.id)).toBeInstanceOf(Date);
      // The provider already synced was not called at all.
      expect(vendorCalls.filter((c) => c.providerId === synced.id)).toEqual([]);
      expect(await usable(synced.id)).toEqual([]);
      // One check and one listing, not a second listing from the check's own hook.
      expect(vendorCalls.filter((c) => c.providerId === legacy.id).map((c) => c.kind).sort()).toEqual(['chat', 'list']);

      // Synced now, so the next boot leaves it alone.
      vendorCalls = [];
      now += 60 * 60_000;
      expect(await warmup.syncNeverSynced('boot')).toMatchObject({ ran: true, providers: 0 });
      expect(vendorCalls).toEqual([]);
    });

    it('a key the vendor refuses makes nothing usable and leaves the provider unsynced', async () => {
      const refused = await legacyProvider({ key: 'sk-revoked-000000' });

      const result = await warmup.syncNeverSynced('boot');

      expect(result).toMatchObject({ ran: true, providers: 1, synced: 0, keyRejected: 1, failed: 0 });
      expect(await usable(refused.id)).toEqual([]);
      expect((await cardsOf(refused.id)).map((c) => c.vendorModelId)).toEqual(['gpt-5']);
      expect(await syncedAt(refused.id)).toBeNull();
      // No listing after a refused check.
      expect(vendorCalls.filter((c) => c.kind === 'list')).toEqual([]);
    });

    it('an outage changes nothing, and the sync before the next sweep picks the provider up', async () => {
      const provider = await legacyProvider();
      const before = (await cardsOf(provider.id)).map((c) => ({ id: c.id, validationStatus: c.validationStatus, lastValidationError: c.lastValidationError ?? null }));
      vendorDown = true;

      const result = await warmup.syncNeverSynced('boot');

      expect(result).toMatchObject({ ran: true, providers: 1, synced: 0, keyRejected: 0, failed: 1 });
      expect((await cardsOf(provider.id)).map((c) => ({ id: c.id, validationStatus: c.validationStatus, lastValidationError: c.lastValidationError ?? null }))).toEqual(before);
      expect(await syncedAt(provider.id)).toBeNull();

      // The vendor is back; the periodic sweep runs after the debounce window.
      vendorDown = false;
      now += 6 * 60 * 60_000;
      const processor = new CatalogSyncProcessor({} as any, catalog, warmup);
      const sweep = await processor.handleSweep();
      expect(sweep.neverSynced).toMatchObject({ ran: true, providers: 1, synced: 1 });
      expect(await usable(provider.id)).toEqual(['gpt-5', 'gpt-5-mini']);
      expect(await syncedAt(provider.id)).toBeInstanceOf(Date);
    });

    it('runs once across two instances: the one holding the lock does the work, the other returns', async () => {
      const a = await legacyProvider();
      const b = await legacyProvider({ type: LlmProviderType.ANTHROPIC });
      let open!: () => void;
      gate = new Promise<void>((resolve) => (open = resolve));

      const first = warmup.syncNeverSynced('boot');
      // Let the first instance take the lock and reach the vendor.
      while (vendorCalls.length === 0) await tick();
      const second = await buildWarmup().syncNeverSynced('boot');
      open();
      const done = await first;

      expect(done).toMatchObject({ ran: true, providers: 2, synced: 2 });
      expect(second).toEqual({ ran: false, providers: 0, vendors: 0, synced: 0, keyRejected: 0, failed: 0, skipped: 0 });
      expect(vendorCalls.filter((c) => c.kind === 'chat').map((c) => c.providerId).sort()).toEqual([a.id, b.id].sort());
      // The second instance never even claimed a provider.
      expect(redis.commands.filter((c) => c.name === 'set')).toHaveLength(2);

      // The lock is free again once the first run is over.
      expect(await buildWarmup().syncNeverSynced('boot')).toMatchObject({ ran: true, providers: 0 });
    });

    it('works one provider of a vendor at a time, and a bounded number of vendors at once', async () => {
      for (let i = 0; i < 3; i++) await legacyProvider();
      for (let i = 0; i < 2; i++) await legacyProvider({ type: LlmProviderType.ANTHROPIC });
      // A third vendor, whose key is refused.
      LISTS.groq = [{ id: 'llama-5' }];
      for (let i = 0; i < 2; i++) await legacyProvider({ type: LlmProviderType.GROQ, key: 'sk-other-000000' });

      const result = await warmup.syncNeverSynced('boot');

      expect(result).toMatchObject({ ran: true, providers: 7, vendors: 3, synced: 5, keyRejected: 2 });
      expect(maxInFlightPerVendor).toBe(1);
      expect(maxInFlight).toBeLessThanOrEqual(2);
      expect(maxInFlight).toBe(2);
      delete LISTS.groq;
    });
  });

  describe('page load', () => {
    it('an org with providers and no usable model gets them synced before the list answers', async () => {
      const provider = await legacyProvider();
      const controller = new ModelCatalogController(catalog, {} as any, warmup);
      const req = { user: { id: 'user-a', currentOrganizationId: 'org-1' } };

      const first = await controller.list(req, { providerId: provider.id } as any);

      expect(first.data.filter((m: any) => m.selectable).map((m: any) => m.vendorModelId).sort()).toEqual(['gpt-5', 'gpt-5-mini']);
      expect(await syncedAt(provider.id)).toBeInstanceOf(Date);
    });

    it('is debounced per provider across instances, and tries again once the window has passed', async () => {
      const refused = await legacyProvider({ key: 'sk-revoked-000000' });

      expect(await warmup.warmOnLoad('org-1', 'user-a')).toBe(false);
      expect(vendorCalls.filter((c) => c.kind === 'chat')).toHaveLength(1);
      expect(redis.pttlNow(`${WARM_CLAIM_PREFIX}${refused.id}`)).toBeGreaterThan(0);

      // Loads inside the window, on this instance and another one, call nobody.
      now += 5 * 60_000;
      expect(await warmup.warmOnLoad('org-1', 'user-a')).toBe(false);
      expect(await buildWarmup().warmOnLoad('org-1', 'user-a', refused.id)).toBe(false);
      expect(vendorCalls.filter((c) => c.kind === 'chat')).toHaveLength(1);
      expect(await usable(refused.id)).toEqual([]);

      now += 6 * 60_000;
      await warmup.warmOnLoad('org-1', 'user-a');
      expect(vendorCalls.filter((c) => c.kind === 'chat')).toHaveLength(2);
    });

    it('does nothing when something is usable already, or for another org', async () => {
      const provider = await legacyProvider();
      await warmup.syncNeverSynced('boot');
      vendorCalls = [];
      now += 60 * 60_000;

      expect(await warmup.warmOnLoad('org-1', 'user-a')).toBe(false);
      expect(await warmup.warmOnLoad('org-2', 'user-a')).toBe(false);
      expect(vendorCalls).toEqual([]);
      expect(await usable(provider.id)).toHaveLength(2);
    });
  });
});
