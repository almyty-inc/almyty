/**
 * Real-Postgres cross-tenant isolation test suite.
 *
 * Every mocked service spec in this repo stubs the underlying
 * repository and asserts `expect(repo.findOne).toHaveBeenCalledWith({
 * where: { id, organizationId } })`. That mock theatre proves only
 * that the test mirrors the implementation. A missing
 * `organizationId` in the WHERE clause, a typo, a bad alias in a
 * `createQueryBuilder` — any of these silent bugs — would pass the
 * mocked tests and leak cross-tenant data in production.
 *
 * This spec closes that gap. For each of the eight tenant-scoped
 * services it:
 *
 *   1. Spins up a real Postgres DataSource with `synchronize: true`
 *      so the schema is an exact reflection of the entity decorators.
 *   2. Seeds TWO organizations, A and B, plus an owner user in each
 *      (TypeORM FK + audit log writes need a real user row).
 *   3. Creates a tenant-scoped row in both orgs.
 *   4. Runs every public service method as org A with org B's id
 *      and asserts the method refuses the lookup — typically by
 *      throwing `NotFoundException`, or by returning null/undefined/
 *      an empty collection.
 *
 * A regression like "forgot to add `organizationId` to the WHERE
 * clause" will fail these tests loudly because the unscoped query
 * will happily return org B's row to org A.
 *
 * Gated behind RUN_DB_INTEGRATION=1 so the default `npm test` run
 * (which may not have a Postgres reachable) stays mock-only.
 * `npm run test:db` is the canonical way to run it.
 */
import { DataSource } from 'typeorm';
import { NotFoundException, ForbiddenException } from '@nestjs/common';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Api, ApiType, ApiStatus } from '../../entities/api.entity';
import { ApiSchema } from '../../entities/api-schema.entity';
import { Operation } from '../../entities/operation.entity';
import { Resource } from '../../entities/resource.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { Gateway, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { LlmProvider, LlmProviderType, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
// Legacy Memory entity removed — see canonical-memory.entity for v1.
import { ApiKey } from '../../entities/api-key.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';

import { ApisService } from '../../modules/apis/apis.service';
import { ToolsService } from '../../modules/tools/tools.service';
import { AgentsService } from '../../modules/agents/agents.service';
import { CredentialsService } from '../../modules/credentials/credentials.service';
import { GatewaysService } from '../../modules/gateways/gateways.service';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
// Legacy MemoryService removed — canonical service in canonical/.

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;

jest.setTimeout(60_000);

// ─── Test harness: DB + two-org seed ────────────────────────────

interface TwoOrgFixture {
  ds: DataSource;
  orgA: Organization;
  orgB: Organization;
  userA: User;
  userB: User;
}

async function setupTwoOrgFixture(): Promise<TwoOrgFixture> {
  // TypeORM's dropSchema+synchronize flow tries to CREATE TABLE in
  // the named schema before re-creating the schema itself, so on a
  // fresh DB the spec dies with `schema "cross_tenant_test" does
  // not exist`. Pre-create via a throwaway connection.
  const bootstrap = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
  });
  await bootstrap.initialize();
  await bootstrap.query('CREATE SCHEMA IF NOT EXISTS cross_tenant_test');
  await bootstrap.destroy();

  // Each integration spec uses its own Postgres schema so that
  // parallel Jest workers running different DB specs at the same
  // time don't step on each other's table creation / drop cycles.
  // `dropSchema: true` + `schema: 'cross_tenant_test'` means
  // TypeORM drops only that schema (not public), then synchronizes
  // all our entities into it.
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || '127.0.0.1',
    port: Number(process.env.DATABASE_PORT || 5432),
    username: process.env.DATABASE_USERNAME || 'postgres',
    password: process.env.DATABASE_PASSWORD || '',
    database: process.env.DATABASE_NAME || 'almyty_test',
    schema: 'cross_tenant_test',
    synchronize: true,
    dropSchema: true,
    entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
    logging: false,
  });
  await ds.initialize();

  const orgRepo = ds.getRepository(Organization);
  const userRepo = ds.getRepository(User);

  const orgA = await orgRepo.save(
    orgRepo.create({
      name: 'Cross-Tenant Test Org A',
      slug: 'cross-tenant-a',
      plan: 'free',
      isActive: true,
    }),
  );
  const orgB = await orgRepo.save(
    orgRepo.create({
      name: 'Cross-Tenant Test Org B',
      slug: 'cross-tenant-b',
      plan: 'free',
      isActive: true,
    }),
  );

  const userA = (await userRepo.save(
    userRepo.create({
      email: 'owner-a@example.com',
      firstName: 'Owner',
      lastName: 'A',
      passwordHash: 'hashed',
      isActive: true,
      isVerified: true,
    }),
  )) as User;
  const userB = (await userRepo.save(
    userRepo.create({
      email: 'owner-b@example.com',
      firstName: 'Owner',
      lastName: 'B',
      passwordHash: 'hashed',
      isActive: true,
      isVerified: true,
    }),
  )) as User;

  // Wire owner memberships so quota / audit log writes don't
  // explode with "User has no role in organization".
  const uoRepo = ds.getRepository(UserOrganization);
  await uoRepo.save(
    uoRepo.create({
      userId: userA.id,
      organizationId: orgA.id,
      role: OrganizationRole.OWNER,
      isActive: true,
    }),
  );
  await uoRepo.save(
    uoRepo.create({
      userId: userB.id,
      organizationId: orgB.id,
      role: OrganizationRole.OWNER,
      isActive: true,
    }),
  );

  return { ds, orgA: orgA as Organization, orgB: orgB as Organization, userA, userB };
}

// A throw-away AuditLogService stub. The real service writes to
// its own repository; for these tests we don't care whether the
// audit row was written — we care about the tenant check, not
// the side-effect. Everything else in the service layer already
// treats audit log failures as non-fatal, so this is safe.
const stubAuditLog = () => ({
  log: jest.fn().mockResolvedValue(undefined),
  logCreate: jest.fn().mockResolvedValue(undefined),
  logUpdate: jest.fn().mockResolvedValue(undefined),
  logDelete: jest.fn().mockResolvedValue(undefined),
  logAccess: jest.fn().mockResolvedValue(undefined),
  logAction: jest.fn().mockResolvedValue(undefined),
  logAgentUpdate: jest.fn().mockResolvedValue(undefined),
  logAgentExecution: jest.fn().mockResolvedValue(undefined),
  logAgentRollback: jest.fn().mockResolvedValue(undefined),
});

// ────────────────────────────────────────────────────────────────

describeIfDb('Cross-tenant isolation (real Postgres)', () => {
  let fx: TwoOrgFixture;

  beforeAll(async () => {
    fx = await setupTwoOrgFixture();
  });

  afterAll(async () => {
    if (fx?.ds?.isInitialized) await fx.ds.destroy();
  });

  // ─── ApisService ──────────────────────────────────────────────

  describe('ApisService', () => {
    let service: ApisService;
    let apiA: Api;
    let apiB: Api;

    beforeAll(async () => {
      service = new ApisService(
        fx.ds.getRepository(Api),
        fx.ds.getRepository(ApiSchema),
        fx.ds.getRepository(Operation),
        fx.ds.getRepository(Resource),
        fx.ds.getRepository(Organization),
        {} as any, // SchemaParserService — not touched by isolation tests
        {} as any, // ToolsService — not touched by isolation tests
        stubAuditLog() as any,
        fx.ds, // DataSource for transaction support
      );

      const apiRepo = fx.ds.getRepository(Api);
      apiA = await apiRepo.save(
        apiRepo.create({
          name: 'API-A',
          description: 'belongs to org A',
          baseUrl: 'https://api-a.example.com',
          type: ApiType.HTTP,
          status: ApiStatus.ACTIVE,
          organizationId: fx.orgA.id,
          version: '1.0.0',
        }),
      );
      apiB = await apiRepo.save(
        apiRepo.create({
          name: 'API-B',
          description: 'belongs to org B',
          baseUrl: 'https://api-b.example.com',
          type: ApiType.HTTP,
          status: ApiStatus.ACTIVE,
          organizationId: fx.orgB.id,
          version: '1.0.0',
        }),
      );
    });

    it('findOne(B.id, orgA) returns null (no cross-tenant leak)', async () => {
      const result = await service.findOne(apiB.id, fx.orgA.id);
      expect(result).toBeNull();
    });

    it('findOne(A.id, orgA) returns the row', async () => {
      const result = await service.findOne(apiA.id, fx.orgA.id);
      expect(result?.id).toBe(apiA.id);
    });

    it('update(B.id, …, orgA) throws NotFoundException', async () => {
      await expect(
        service.update(apiB.id, { name: 'hacked' }, fx.orgA.id),
      ).rejects.toThrow(NotFoundException);

      // Paranoid: reload and confirm the row wasn't mutated.
      const reloaded = await fx.ds.getRepository(Api).findOne({ where: { id: apiB.id } });
      expect(reloaded?.name).toBe('API-B');
    });

    it('remove(B.id, orgA) throws NotFoundException and does NOT delete', async () => {
      await expect(service.remove(apiB.id, fx.orgA.id)).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Api).findOne({ where: { id: apiB.id } });
      expect(reloaded).not.toBeNull();
    });

    it('updateStatus(B.id, …, orgA) throws NotFoundException', async () => {
      await expect(
        service.updateStatus(apiB.id, ApiStatus.INACTIVE, fx.orgA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Api).findOne({ where: { id: apiB.id } });
      expect(reloaded?.status).toBe(ApiStatus.ACTIVE);
    });

    it('generateToolsFromApi(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.generateToolsFromApi(apiB.id, fx.orgA.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('testApiConnection(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.testApiConnection(apiB.id, fx.orgA.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('getApiOperations(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.getApiOperations(apiB.id, fx.orgA.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('getApiResources(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.getApiResources(apiB.id, fx.orgA.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('getApiSchemas(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.getApiSchemas(apiB.id, fx.orgA.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('findAllByOrganization(orgA) only returns org-A rows', async () => {
      const { apis } = await service.findAllByOrganization(fx.orgA.id);
      expect(apis.every((a) => a.organizationId === fx.orgA.id)).toBe(true);
      expect(apis.map((a) => a.id)).not.toContain(apiB.id);
    });
  });

  // ─── ToolsService ─────────────────────────────────────────────

  describe('ToolsService', () => {
    let service: ToolsService;
    let toolA: Tool;
    let toolB: Tool;

    beforeAll(async () => {
      service = new ToolsService(
        fx.ds.getRepository(Tool),
        {} as any, // ToolVersion repo
        {} as any, // ToolCategory repo
        {} as any, // ToolExecution repo
        fx.ds.getRepository(Api),
        fx.ds.getRepository(Operation),
        {} as any, // ApiSchema repo
        fx.ds.getRepository(User),
        fx.ds.getRepository(Organization),
        stubAuditLog() as any,
      );

      const toolRepo = fx.ds.getRepository(Tool);
      toolA = await toolRepo.save(
        toolRepo.create({
          name: 'tool-A',
          description: 'org A tool',
          type: ToolType.API,
          status: ToolStatus.ACTIVE,
          organizationId: fx.orgA.id,
        }),
      );
      toolB = await toolRepo.save(
        toolRepo.create({
          name: 'tool-B',
          description: 'org B tool',
          type: ToolType.API,
          status: ToolStatus.ACTIVE,
          organizationId: fx.orgB.id,
        }),
      );
    });

    it('getTool(B.id, orgA) throws NotFoundException', async () => {
      await expect(service.getTool(toolB.id, fx.orgA.id, false)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('getTools({orgA}) only returns org-A rows', async () => {
      const { tools } = await service.getTools({ organizationId: fx.orgA.id } as any);
      expect(tools.every((t) => t.organizationId === fx.orgA.id)).toBe(true);
      expect(tools.map((t) => t.id)).not.toContain(toolB.id);
    });

    it('updateTool(B.id, …, orgA) throws NotFoundException', async () => {
      await expect(
        service.updateTool(toolB.id, { name: 'hacked' } as any, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Tool).findOne({ where: { id: toolB.id } });
      expect(reloaded?.name).toBe('tool-B');
    });

    it('deleteTool(B.id, orgA) throws NotFoundException and does NOT delete', async () => {
      await expect(
        service.deleteTool(toolB.id, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Tool).findOne({ where: { id: toolB.id } });
      expect(reloaded).not.toBeNull();
    });

    it('activateTool(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.activateTool(toolB.id, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
    });

    it('findByName("tool-B", orgA) returns null (scoped by org)', async () => {
      const result = await service.findByName('tool-B', fx.orgA.id);
      expect(result).toBeNull();
    });
  });

  // ─── AgentsService ────────────────────────────────────────────

  describe('AgentsService', () => {
    let service: AgentsService;
    let agentA: Agent;
    let agentB: Agent;

    beforeAll(async () => {
      service = new AgentsService(
        fx.ds.getRepository(Agent),
        fx.ds.getRepository(AgentExecution),
        fx.ds.getRepository(Organization),
        fx.ds.getRepository(User),
        { appendAudit: jest.fn().mockResolvedValue(undefined) } as any,
      );

      const agentRepo = fx.ds.getRepository(Agent);
      agentA = (await agentRepo.save({
        name: 'agent-A',
        description: 'org A agent',
        status: AgentStatus.ACTIVE,
        organizationId: fx.orgA.id,
        createdBy: fx.userA.id,
        pipeline: { nodes: [], edges: [] } as any,
      } as any)) as Agent;
      agentB = (await agentRepo.save({
        name: 'agent-B',
        description: 'org B agent',
        status: AgentStatus.ACTIVE,
        organizationId: fx.orgB.id,
        createdBy: fx.userB.id,
        pipeline: { nodes: [], edges: [] } as any,
      } as any)) as Agent;
    });

    it('getAgent(B.id, orgA) throws NotFoundException', async () => {
      await expect(service.getAgent(agentB.id, fx.orgA.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('getAgent(A.id, orgA) returns the row', async () => {
      const result = await service.getAgent(agentA.id, fx.orgA.id);
      expect(result.id).toBe(agentA.id);
    });

    it('getAgents({orgA}) only returns org-A rows', async () => {
      const { data } = await service.getAgents({ organizationId: fx.orgA.id } as any);
      expect(data.every((a) => a.organizationId === fx.orgA.id)).toBe(true);
      expect(data.map((a) => a.id)).not.toContain(agentB.id);
    });

    it('updateAgent(B.id, …, orgA) throws NotFoundException', async () => {
      await expect(
        service.updateAgent(agentB.id, { name: 'hacked' } as any, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Agent).findOne({ where: { id: agentB.id } });
      expect(reloaded?.name).toBe('agent-B');
    });

    it('deleteAgent(B.id, orgA) throws NotFoundException and does NOT delete', async () => {
      await expect(
        service.deleteAgent(agentB.id, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Agent).findOne({ where: { id: agentB.id } });
      expect(reloaded).not.toBeNull();
    });

    it('findByName("agent-B", orgA) returns null', async () => {
      const result = await service.findByName('agent-B', fx.orgA.id);
      expect(result).toBeNull();
    });
  });

  // ─── CredentialsService ───────────────────────────────────────

  describe('CredentialsService', () => {
    let service: CredentialsService;
    let credA: Credential;
    let credB: Credential;

    beforeAll(async () => {
      service = new CredentialsService(
        fx.ds.getRepository(Credential),
        fx.ds.getRepository(ApiKey),
        fx.ds.getRepository(LlmProvider),
        fx.ds.getRepository(Api),
        fx.ds.getRepository(Gateway),
        fx.ds.getRepository(Agent),
        stubAuditLog() as any,
      );

      const credRepo = fx.ds.getRepository(Credential);
      credA = await credRepo.save(
        credRepo.create({
          name: 'cred-A',
          type: CredentialType.API_KEY,
          organizationId: fx.orgA.id,
          config: { apiKey: 'org-a-secret' },
          isActive: true,
        }),
      );
      credB = await credRepo.save(
        credRepo.create({
          name: 'cred-B',
          type: CredentialType.API_KEY,
          organizationId: fx.orgB.id,
          config: { apiKey: 'org-b-secret' },
          isActive: true,
        }),
      );
    });

    it('findById(B.id, orgA) throws NotFoundException', async () => {
      await expect(service.findById(credB.id, fx.orgA.id)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('findAll(orgA) only returns org-A rows', async () => {
      const result = await service.findAll(fx.orgA.id);
      expect(result.every((r: any) => r.organizationId === fx.orgA.id)).toBe(true);
      expect(result.map((r: any) => r.id)).not.toContain(credB.id);
    });

    it('delete(B.id, orgA) throws NotFoundException and does NOT delete', async () => {
      await expect(service.delete(credB.id, fx.orgA.id)).rejects.toThrow(
        NotFoundException,
      );
      const reloaded = await fx.ds
        .getRepository(Credential)
        .findOne({ where: { id: credB.id } });
      expect(reloaded).not.toBeNull();
    });
  });

  // ─── GatewaysService ──────────────────────────────────────────

  describe('GatewaysService', () => {
    let service: GatewaysService;
    let gwA: Gateway;
    let gwB: Gateway;

    beforeAll(async () => {
      service = new GatewaysService(
        fx.ds.getRepository(Gateway),
        fx.ds.getRepository(GatewayTool),
        fx.ds.getRepository(GatewayAuth),
        fx.ds.getRepository(User),
        fx.ds.getRepository(Organization),
        fx.ds.getRepository(UsageMetric),
        stubAuditLog() as any,
      );

      const gwRepo = fx.ds.getRepository(Gateway);
      gwA = (await gwRepo.save({
        name: 'gw-A',
        description: 'org A gateway',
        type: GatewayType.MCP,
        status: GatewayStatus.ACTIVE,
        organizationId: fx.orgA.id,
        endpoint: '/gateways/gw-a',
        configuration: {},
      } as any)) as Gateway;
      gwB = (await gwRepo.save({
        name: 'gw-B',
        description: 'org B gateway',
        type: GatewayType.MCP,
        status: GatewayStatus.ACTIVE,
        organizationId: fx.orgB.id,
        endpoint: '/gateways/gw-b',
        configuration: {},
      } as any)) as Gateway;
    });

    it('getGateway(B.id, orgA) throws NotFoundException', async () => {
      await expect(service.getGateway(gwB.id, fx.orgA.id, false)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('getGateways({orgA}) only returns org-A rows', async () => {
      const { gateways } = await service.getGateways({ organizationId: fx.orgA.id } as any);
      expect(gateways.every((g) => g.organizationId === fx.orgA.id)).toBe(true);
      expect(gateways.map((g) => g.id)).not.toContain(gwB.id);
    });

    it('updateGateway(B.id, …, orgA) throws NotFoundException', async () => {
      await expect(
        service.updateGateway(gwB.id, { name: 'hacked' } as any, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Gateway).findOne({ where: { id: gwB.id } });
      expect(reloaded?.name).toBe('gw-B');
    });

    it('deleteGateway(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.deleteGateway(gwB.id, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds.getRepository(Gateway).findOne({ where: { id: gwB.id } });
      expect(reloaded).not.toBeNull();
    });
  });

  // ─── LlmProvidersService ──────────────────────────────────────

  describe('LlmProvidersService', () => {
    let service: LlmProvidersService;
    let provA: LlmProvider;
    let provB: LlmProvider;

    beforeAll(async () => {
      service = new LlmProvidersService(
        fx.ds.getRepository(LlmProvider),
        fx.ds.getRepository(Conversation),
        fx.ds.getRepository(Message),
        fx.ds.getRepository(User),
        fx.ds.getRepository(Organization),
        fx.ds.getRepository(Gateway),
        fx.ds.getRepository(Tool),
        {} as any, // ToolExecutorService — unused for isolation tests
        stubAuditLog() as any,
      );

      const provRepo = fx.ds.getRepository(LlmProvider);
      provA = (await provRepo.save({
        name: 'provider-A',
        type: LlmProviderType.OPENAI,
        status: LlmProviderStatus.ACTIVE,
        organizationId: fx.orgA.id,
        configuration: { apiKey: 'org-a-key', model: 'gpt-4o-mini' } as any,
      } as any)) as LlmProvider;
      provB = (await provRepo.save({
        name: 'provider-B',
        type: LlmProviderType.OPENAI,
        status: LlmProviderStatus.ACTIVE,
        organizationId: fx.orgB.id,
        configuration: { apiKey: 'org-b-key', model: 'gpt-4o-mini' } as any,
      } as any)) as LlmProvider;
    });

    it('getProvider(B.id, orgA) throws NotFoundException', async () => {
      await expect(service.getProvider(provB.id, fx.orgA.id, false)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('getProviders({orgA}) only returns org-A rows', async () => {
      const { providers } = await service.getProviders({
        organizationId: fx.orgA.id,
      } as any);
      expect(providers.every((p) => p.organizationId === fx.orgA.id)).toBe(true);
      expect(providers.map((p) => p.id)).not.toContain(provB.id);
    });

    it('updateProvider(B.id, …, orgA) throws NotFoundException', async () => {
      await expect(
        service.updateProvider(
          provB.id,
          { name: 'hacked' } as any,
          fx.orgA.id,
          fx.userA.id,
        ),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds
        .getRepository(LlmProvider)
        .findOne({ where: { id: provB.id } });
      expect(reloaded?.name).toBe('provider-B');
    });

    it('deleteProvider(B.id, orgA) throws NotFoundException', async () => {
      await expect(
        service.deleteProvider(provB.id, fx.orgA.id, fx.userA.id),
      ).rejects.toThrow(NotFoundException);
      const reloaded = await fx.ds
        .getRepository(LlmProvider)
        .findOne({ where: { id: provB.id } });
      expect(reloaded).not.toBeNull();
    });
  });

  // The legacy MemoryService isolation suite has been superseded by
  // the canonical schema's scope-based design — cross-scope read
  // safety is asserted in
  // `src/modules/memory/canonical/__tests__/canonical-memory.integration.spec.ts`
  // against real Postgres + pgvector. The legacy `Memory` entity,
  // service, and `organizationId` filter are removed.
});
