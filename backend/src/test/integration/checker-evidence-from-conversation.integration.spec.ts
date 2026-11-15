import { DataSource } from 'typeorm';

import { AgentStepProcessor } from '../../modules/agents/agent-step-processor';
import { capPersistedPayload } from '../../modules/agents/persist-cap';
import { Conversation } from '../../entities/conversation.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Message } from '../../entities/message.entity';
import { Model } from '../../entities/model.entity';
import { Organization } from '../../entities/organization.entity';

/**
 * The answer checker reads the tool results the writer read, from the
 * run's conversation in the database, not the copies stored on the steps
 * (shortened for storage). A step resumed on another worker has nothing
 * in memory from the step that ran the tool: this reads with a processor
 * that has only the database. It also reads the checker's model card,
 * whose most output tokens (migration ModelMaxOutputTokens) sets the
 * checker's output budget. Real Postgres; RUN_DB_INTEGRATION=1.
 */
const describeIfDb = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
const SCHEMA = 'checker_evidence_it';

describeIfDb('the checker reads the run conversation (real Postgres)', () => {
  let ds: DataSource;
  const connection = {
    type: 'postgres' as const,
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || 'postgres',
    database: process.env.DATABASE_NAME || 'almyty_test',
  };

  beforeAll(async () => {
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.destroy();
    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      migrationsTransactionMode: 'each',
      dropSchema: true,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      logging: false,
    });
    await ds.initialize();
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  it('builds the evidence from the whole tool results and sizes the checker from its card', async () => {
    const org = await ds.getRepository(Organization).save({ name: 'checker-evidence', slug: `checker-evidence-${Date.now()}`, plan: 'free', isActive: true } as any);
    const provider = await ds.getRepository(LlmProvider).save(
      ds.getRepository(LlmProvider).create({ name: 'anthropic', type: LlmProviderType.ANTHROPIC, status: LlmProviderStatus.ACTIVE, organizationId: org.id, configuration: {} } as Partial<LlmProvider>),
    );
    await ds.getRepository(Model).save(
      ds.getRepository(Model).create({
        organizationId: org.id,
        name: 'Claude Haiku 4.5',
        providerId: provider.id,
        providerType: 'anthropic',
        vendorModelId: 'claude-haiku-4-5',
        contextLength: 200_000,
        maxOutputTokens: 64_000,
      } as Partial<Model>),
    );
    const conversation = await ds.getRepository(Conversation).save({ organizationId: org.id, title: 'digest' } as any);

    const works = {
      meta: { count: 10 },
      results: Array.from({ length: 10 }, (_, i) => ({
        id: `https://openalex.org/W7${i}`,
        title: `Work ${i}`,
        abstract: `${'long abstract text '.repeat(300)}END-${i}`,
        authorships: [{ author: { id: `https://openalex.org/A${i}`, display_name: `Author ${i}` } }],
        primary_location: { source: { display_name: `Journal ${i}` } },
      })),
    };
    const raw = JSON.stringify(works);
    const runId = '5f990f9e-891a-4274-be29-346d160babbb';
    const messages = ds.getRepository(Message);
    const callMsg = Message.createToolCallMessage(conversation.id, [{ id: 'toolu_1', name: 'openalex_search_works', parameters: { search: 'rag' } }]);
    callMsg.runId = runId;
    await messages.save(callMsg);
    const resultMsg = Message.createToolResultMessage(conversation.id, 'toolu_1', raw);
    resultMsg.runId = runId;
    await messages.save(resultMsg);
    // Another run's result in the same conversation is not this run's evidence.
    const other = Message.createToolResultMessage(conversation.id, 'toolu_other', 'OTHER-RUN');
    other.runId = '00000000-0000-0000-0000-000000000000';
    await messages.save(other);

    const run = {
      id: runId,
      organizationId: org.id,
      conversationId: conversation.id,
      input: { message: 'rag, since 2026-11-01' },
      steps: [{ type: 'tool_call', input: { tool: 'openalex_search_works', parameters: { search: 'rag' } }, output: capPersistedPayload(raw) }],
    };
    const resumed = Object.assign(Object.create(AgentStepProcessor.prototype), {
      s: { toolRepository: { manager: ds.manager }, messageRepository: messages, logger: { warn: jest.fn() } },
    });
    const prepared = await resumed.prepareCheck(run, { instructions: 'Name the first author.' }, [{ providerId: provider.id, model: 'claude-haiku-4-5' }], 'answer');

    expect(prepared.evidence).toContain(`openalex_search_works {"search":"rag"}:\n${raw}`);
    expect(prepared.evidence).not.toContain('[result shortened');
    expect(prepared.evidence).not.toContain('OTHER-RUN');
    expect(prepared.evidence).toContain('END-9');
    expect(prepared.rules).toBe('Name the first author.');
    expect(prepared.checkers[0].maxTokens).toBe(8_192);
  });
});
