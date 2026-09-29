/**
 * Real-Postgres spec for provider connections: several connections of one
 * provider in one organization, each a named credential, and the models a
 * connection hides.
 *
 * Every model is allowed by default and unticking hides one. The switch
 * "Allow new models automatically" decides what a model the vendor lists
 * later does: on, it is allowed and the unticked ones are a hidden list;
 * off, only the ticked ones are allowed ("this Hugging Face key serves
 * Llama 70B and nothing else"). What that has to hold, against the real
 * tables:
 *
 *  - two connections of the same provider live side by side, each with its
 *    own key row named like the connection, and renaming a connection
 *    renames its key (the data migration renames keys made before);
 *  - the model list every chooser reads (GET /models) marks a hidden model
 *    not allowed and not usable, and still lists the other connection's
 *    copy of the same model id as usable;
 *  - the router never plans a hidden model, not even one a policy pins;
 *  - a role that names a hidden model is refused, and so is a direct call;
 *  - a call that names no model falls back to an allowed one;
 *  - a model the vendor lists later is allowed where the switch is on and
 *    stays off where it is off.
 *
 * The vendor is a double (no network here): the listing returns fixed ids
 * and the wire call is replaced on the runner. The catalog, the router,
 * the key store and the tables are real.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env vars.
 */
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Credential } from '../../entities/credential.entity';
import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { Tool } from '../../entities/tool.entity';
import { Conversation } from '../../entities/conversation.entity';
import { MessageRole } from '../../entities/message.entity';
import { ModelCatalogService } from '../../modules/model-catalog/model-catalog.service';
import { view } from '../../modules/model-catalog/model-catalog.controller';
import { ModelRouterService } from '../../modules/model-catalog/routing/model-router.service';
import { CredentialRefResolver } from '../../modules/credentials/credential-ref.resolver';
import { LlmProviderSecretsHelper } from '../../modules/llm-providers/llm-provider-secrets.helper';
import { LlmChatRunnerHelper } from '../../modules/llm-providers/llm-chat-runner.helper';
import { DefaultModelResolver } from '../../modules/llm-providers/default-model.resolver';
import { ProviderConnectionAllowedModels1750813733170 } from '../../migrations/1750813733170-ProviderConnectionAllowedModels';
import { makeEnvelopeCryptoMock } from '../envelope-crypto.mock';
import { ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'provider_connections_test';

jest.setTimeout(120_000);

const connection = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'password',
  database: process.env.DATABASE_NAME || 'almyty_test',
};

const LLAMA = 'meta-llama/Llama-3.3-70B-Instruct';
const QWEN = 'Qwen/Qwen3-32B';
const LISTED = [LLAMA, QWEN, 'deepseek-ai/DeepSeek-V3'];

describeIfDb('provider connections: several per provider, hidden models (real Postgres)', () => {
  let ds: DataSource;
  let orgId: string;
  let catalog: ModelCatalogService;
  let router: ModelRouterService;
  let secrets: LlmProviderSecretsHelper;
  let runner: LlmChatRunnerHelper;
  let pinned: LlmProvider;
  let open: LlmProvider;
  let noQwen: LlmProvider;
  const wire: Array<{ providerId: string; model: string }> = [];
  const listed = [...LISTED];

  const listing = { fetchModelsFromProvider: async () => listed.map((id) => ({ id, name: id })) };

  beforeAll(async () => {
    await ensureSchema(SCHEMA);
    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
      logging: false,
    });
    await ds.initialize();

    const envelope = makeEnvelopeCryptoMock();
    const resolver = new CredentialRefResolver(ds.getRepository(Credential), envelope);
    secrets = new LlmProviderSecretsHelper(resolver);
    router = new ModelRouterService(ds.getRepository(Model), ds.getRepository(LlmProvider), ds.getRepository(ModelDeployment), undefined, resolver);
    catalog = new ModelCatalogService(ds.getRepository(Model), ds.getRepository(ModelVersion), ds.getRepository(LlmProvider), router, {} as any, listing as any);
    runner = new LlmChatRunnerHelper(ds.getRepository(Tool), {} as any, listing as any, envelope, new DefaultModelResolver(listing as any), router, secrets);
    // The wire call is the only double on the call path.
    (runner as any).dispatchProviderCall = async (provider: LlmProvider, request: { model: string }) => {
      wire.push({ providerId: provider.id, model: request.model });
      return { message: { role: MessageRole.ASSISTANT, content: 'ok' }, model: request.model, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: 0, responseTime: 5 };
    };

    const org = await ds.getRepository(Organization).save(
      ds.getRepository(Organization).create({ name: 'connections', slug: `connections-${Date.now()}`, plan: 'free', isActive: true } as Partial<Organization>),
    );
    orgId = org.id;

    const connect = async (name: string, key: string, access: Partial<Pick<LlmProvider, 'allowNewModels' | 'hiddenModels' | 'allowedModels'>>) => {
      const repo = ds.getRepository(LlmProvider);
      const row = await repo.save(
        repo.create({
          name,
          type: LlmProviderType.HUGGINGFACE,
          status: LlmProviderStatus.ACTIVE,
          organizationId: orgId,
          configuration: {},
          isHealthy: true,
          lastHealthCheckAt: new Date(),
          ...access,
        } as Partial<LlmProvider>),
      );
      await secrets.applyKey(row, 'inference', { plaintext: key });
      await repo.save(row);
      await catalog.syncFromProvider(orgId, row.id);
      return repo.findOneOrFail({ where: { id: row.id } });
    };
    pinned = await connect('HF - Llama 70B only', 'hf_pinned_key_0000000000', { allowNewModels: false, allowedModels: [LLAMA], hiddenModels: [QWEN] });
    open = await connect('HF - everything', 'hf_open_key_00000000000000', {});
    noQwen = await connect('HF - no Qwen', 'hf_noqwen_key_000000000000', { allowNewModels: true, hiddenModels: [QWEN], allowedModels: [LLAMA] });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('keeps two connections of one provider, each with its own key named like the connection', async () => {
    const rows = await ds.getRepository(LlmProvider).find({ where: { organizationId: orgId, type: LlmProviderType.HUGGINGFACE } });
    expect(rows.map((r) => r.name).sort()).toEqual(['HF - Llama 70B only', 'HF - everything', 'HF - no Qwen']);
    expect(new Set(rows.map((r) => r.credentialId)).size).toBe(3);
    const keys = await ds.getRepository(Credential).find({ where: { organizationId: orgId } });
    expect(keys.map((k) => k.name).sort()).toEqual(['HF - Llama 70B only', 'HF - everything', 'HF - no Qwen']);
    expect(rows.find((r) => r.id === pinned.id)!.getDecryptedApiKey()).toBe('hf_pinned_key_0000000000');
    expect(rows.find((r) => r.id === open.id)!.getDecryptedApiKey()).toBe('hf_open_key_00000000000000');
  });

  it('renames the key with the connection', async () => {
    const row = await ds.getRepository(LlmProvider).findOneOrFail({ where: { id: open.id } });
    row.name = 'HF - team sandbox';
    await ds.getRepository(LlmProvider).save(row);
    await secrets.syncManagedName(row);
    expect((await ds.getRepository(Credential).findOneOrFail({ where: { id: row.credentialId! } })).name).toBe('HF - team sandbox');
  });

  it('the data migration names keys made before after their connection, and leaves shared ones alone', async () => {
    const managed = await ds.getRepository(Credential).findOneOrFail({ where: { id: pinned.credentialId! } });
    await ds.getRepository(Credential).update({ id: managed.id }, { name: 'HF - Llama 70B only API key' });
    const shared = await ds.getRepository(Credential).save(
      ds.getRepository(Credential).create({ name: 'Shared HF token', type: 'api_key', config: {}, organizationId: orgId } as any),
    );
    const other = await ds.getRepository(LlmProvider).save(
      ds.getRepository(LlmProvider).create({ name: 'HF via shared token', type: LlmProviderType.HUGGINGFACE, organizationId: orgId, configuration: {}, credentialId: (shared as any).id } as Partial<LlmProvider>),
    );
    const runnerQ = ds.createQueryRunner();
    await new ProviderConnectionAllowedModels1750813733170().up(runnerQ);
    await runnerQ.release();
    expect((await ds.getRepository(Credential).findOneOrFail({ where: { id: managed.id } })).name).toBe('HF - Llama 70B only');
    expect((await ds.getRepository(Credential).findOneOrFail({ where: { id: (shared as any).id } })).name).toBe('Shared HF token');
    await ds.getRepository(LlmProvider).delete({ id: other.id });
  });

  it('the model list every chooser reads hides what the connection hides, and only there', async () => {
    const cards = (await catalog.list(orgId, {}, null)).map(view);
    const of = (providerId: string) => cards.filter((c) => c.providerId === providerId);
    expect(of(pinned.id).map((c) => c.vendorModelId).sort()).toEqual([...LISTED].sort());
    expect(of(pinned.id).filter((c) => c.selectable).map((c) => c.vendorModelId)).toEqual([LLAMA]);
    expect(of(pinned.id).find((c) => c.vendorModelId === QWEN)).toMatchObject({ allowed: false, selectable: false });
    expect(of(open.id).every((c) => c.allowed && c.selectable)).toBe(true);
    // Switch on: only the unticked one is hidden. The allow list it also
    // carries (from an earlier "off") is kept but not read.
    expect(of(noQwen.id).filter((c) => !c.allowed).map((c) => c.vendorModelId)).toEqual([QWEN]);
    // selectable=true (the chooser's own filter) agrees.
    const usable = await catalog.list(orgId, { selectable: true }, null);
    expect(usable.filter((c) => c.providerId === pinned.id).map((c) => c.vendorModelId)).toEqual([LLAMA]);
  });

  it('the router never plans a hidden model, even one a policy pins', async () => {
    const plan = await router.plan(orgId, { objective: 'pinned', pinnedModel: QWEN }, null);
    expect(plan.candidates.some((c) => c.provider.id === pinned.id && c.vendorModelId !== LLAMA)).toBe(false);
    expect(plan.candidates.find((c) => c.vendorModelId === QWEN)?.provider.id).toBe(open.id);
    const hiddenCard = await ds.getRepository(Model).findOneOrFail({ where: { providerId: pinned.id, vendorModelId: QWEN } });
    expect(plan.rejected).toContainEqual({ modelId: hiddenCard.id, reason: expect.stringContaining('not allowed on the connection') });
  });

  it('a role naming a hidden model, and a direct call to one, are refused before anything is sent', async () => {
    const hiddenCard = await ds.getRepository(Model).findOneOrFail({ where: { providerId: pinned.id, vendorModelId: QWEN } });
    await expect(router.providerForModelId(orgId, hiddenCard.id, null)).rejects.toThrow(/does not allow/);

    wire.length = 0;
    const session = Conversation.createConversation({ providerId: pinned.id, organizationId: orgId, title: 't' });
    const provider = await ds.getRepository(LlmProvider).findOneOrFail({ where: { id: pinned.id } });
    await expect(
      runner.callLlmProvider(provider, { messages: [{ role: MessageRole.USER, content: 'hi' }], model: QWEN }, session, []),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_ALLOWED' });
    expect(wire).toEqual([]);
  });

  it('a call that names no model uses an allowed one', async () => {
    wire.length = 0;
    const session = Conversation.createConversation({ providerId: pinned.id, organizationId: orgId, title: 't' });
    const provider = await ds.getRepository(LlmProvider).findOneOrFail({ where: { id: pinned.id } });
    await runner.callLlmProvider(provider, { messages: [{ role: MessageRole.USER, content: 'hi' }] }, session, []);
    expect(wire).toEqual([{ providerId: pinned.id, model: LLAMA }]);
  });

  it('a model the vendor lists later is allowed where new models are, and stays off where they are not', async () => {
    listed.push('google/gemma-4-31b-it');
    for (const p of [pinned, open, noQwen]) await catalog.syncFromProvider(orgId, p.id);
    const cards = (await catalog.list(orgId, {}, null)).filter((c) => c.vendorModelId === 'google/gemma-4-31b-it');
    const allowedOn = (id: string) => cards.find((c) => c.providerId === id)?.allowed;
    expect(allowedOn(pinned.id)).toBe(false);
    expect(allowedOn(open.id)).toBe(true);
    expect(allowedOn(noQwen.id)).toBe(true);
  });

  it('a routed call answers from an allowed model and says which', async () => {
    wire.length = 0;
    const session = Conversation.createConversation({ organizationId: orgId, title: 't' });
    const response = await runner.callLlmProvider(
      undefined as any,
      { messages: [{ role: MessageRole.USER, content: 'hi' }], routing: { fallbackChain: [QWEN] } },
      session,
      [],
    );
    expect(wire[0]).toEqual({ providerId: open.id, model: QWEN });
    expect(response.routing).toMatchObject({ vendorModelId: QWEN, providerId: open.id, attempt: 1 });
  });
});
