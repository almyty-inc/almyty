import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { Team } from '../../entities/team.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Model } from '../../entities/model.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { Conversation } from '../../entities/conversation.entity';
import { Message } from '../../entities/message.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Tool, ToolStatus, ToolType } from '../../entities/tool.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { Api, ApiType } from '../../entities/api.entity';
import { McpSource, McpSourceStatus } from '../../entities/mcp-source.entity';
import { ConnectionGrant } from '../../entities/connection-grant.entity';
import { Agent } from '../../entities/agent.entity';
import { Workspace } from '../../entities/workspace.entity';
import { SpendBudget } from '../../entities/spend-budget.entity';
import { GrantsService } from '../../modules/connections/grants/grants.service';
import { GrantsUsePolicy } from '../../modules/connections/grants/grants-use.policy';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import {
  ExecutionAccessService,
  ExecutionPrincipal,
  gatewayPrincipal,
  userPrincipal,
} from '../../common/authorization/execution-access.service';
import { ModelRouterService } from '../../modules/model-catalog/routing/model-router.service';
import { LlmProvidersService } from '../../modules/llm-providers/llm-providers.service';
import { LlmChatHelper } from '../../modules/llm-providers/llm-chat.helper';
import { CredentialRefResolver } from '../../modules/credentials/credential-ref.resolver';
import { ToolAuthService } from '../../modules/tools/services/tool-auth.service';
import { McpSourcesService } from '../../modules/mcp-sources/mcp-sources.service';
import { makeEnvelopeCryptoMock } from '../envelope-crypto.mock';

/**
 * "Team only is team only; the scope is inherited." A run executes as its
 * inherited ExecutionPrincipal -- a user, or the gateway it came through --
 * and everything the run reaches is judged by that principal, not by the
 * user on the run row (a gateway run has none):
 *
 * 1. the LLM path: a provider named by id, a routed or role-named model
 *    card, and the tools a model turn is offered;
 * 2. credentials resolved for a call: a plain (non-connector) team
 *    credential bound to an org-wide API, an MCP source's credential, a
 *    connection -- the team rule applies at resolve time, given the
 *    principal, and a call that acts for nobody is refused a team row.
 *
 * Org owners and admins pass team checks, as everywhere
 * AccessPolicyService.canAccess decides. Real Postgres (migrations, the
 * real team-membership join). Gated on RUN_DB_INTEGRATION=1, isolated in
 * its own schema.
 */
const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'team_scope_principal_test';

jest.setTimeout(120_000);

describeIfDb('the run principal decides team scope on the execution path (real Postgres)', () => {
  let ds: DataSource;
  let policy: AccessPolicyService;
  let gate: ExecutionAccessService;
  let resolver: CredentialRefResolver;
  let organizationId: string;
  let teamId: string;
  let otherTeamId: string;
  // teammate: on Payments. outsider: org member on no team. admin: org admin.
  const users: Record<'teammate' | 'outsider' | 'admin', string> = {} as any;

  let teamProvider: LlmProvider;
  let orgProvider: LlmProvider;
  let teamCard: Model;
  let orgCard: Model;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);
  const insert = async <T extends object>(entity: new () => T, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as unknown as T)) as T;
  const none = undefined as any;
  const notFound = { response: { code: 'CREDENTIAL_NOT_FOUND' } };

  // The gateways a run can come through. Ids only: the principal is what decides.
  const gateway = (visibility: 'org' | 'team' | 'private', over: Record<string, any> = {}): ExecutionPrincipal =>
    gatewayPrincipal({ id: `00000000-0000-4000-8000-00000000000${visibility.length}`, organizationId, visibility, ...over });
  const paymentsGateway = () => gateway('team', { teamId });
  const otherTeamGateway = () => gateway('team', { teamId: otherTeamId });
  const orgGateway = () => gateway('org');
  const as = (who: keyof typeof users) => userPrincipal(users[who]);

  beforeAll(async () => {
    const connection = {
      type: 'postgres' as const,
      host: process.env.DATABASE_HOST || '127.0.0.1',
      port: Number(process.env.DATABASE_PORT || 5432),
      username: process.env.DATABASE_USERNAME || 'postgres',
      password: process.env.DATABASE_PASSWORD || '',
      database: process.env.DATABASE_NAME || 'almyty_test',
    };
    const bootstrap = new DataSource(connection);
    await bootstrap.initialize();
    await bootstrap.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await bootstrap.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public`);
    await bootstrap.destroy();

    ds = new DataSource({
      ...connection,
      schema: SCHEMA,
      entities: [__dirname + '/../../entities/*.entity{.ts,.js}'],
      extra: { options: `-c search_path=${SCHEMA},public` },
      migrations: [__dirname + '/../../migrations/*{.ts,.js}'],
      migrationsRun: true,
      dropSchema: true,
    });
    await ds.initialize();
    policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    gate = new ExecutionAccessService(policy);
    resolver = new CredentialRefResolver(repo(Credential), makeEnvelopeCryptoMock(), undefined, undefined, gate);

    organizationId = (await insert(Organization, { name: 'Principal Org', slug: 'principal-org' }) as any).id;
    const roles: Array<[keyof typeof users, OrganizationRole]> = [
      ['teammate', OrganizationRole.MEMBER],
      ['outsider', OrganizationRole.MEMBER],
      ['admin', OrganizationRole.ADMIN],
    ];
    for (const [name, role] of roles) {
      const user = await insert(User, { email: `${name}@principal.test`, passwordHash: 'x', firstName: name, lastName: 'P' });
      users[name] = (user as any).id;
      await insert(UserOrganization, { userId: users[name], organizationId, role, isActive: true, inviteAccepted: true });
    }
    teamId = (await insert(Team, { name: 'Payments', organizationId }) as any).id;
    otherTeamId = (await insert(Team, { name: 'Growth', organizationId }) as any).id;
    await insert(UserTeam, { userId: users.teammate, teamId, role: TeamRole.MEMBER, isActive: true });

    const providerBase = {
      type: LlmProviderType.OPENAI, organizationId, configuration: { model: 'gpt-x' },
      status: LlmProviderStatus.ACTIVE, isHealthy: true,
    };
    teamProvider = await insert(LlmProvider, { ...providerBase, name: 'Payments OpenAI', visibility: 'team', teamId, ownerUserId: users.teammate });
    orgProvider = await insert(LlmProvider, { ...providerBase, name: 'Shared OpenAI', visibility: 'org', teamId: null });
    const cardBase = { organizationId, providerType: 'openai', status: 'active', validationStatus: 'passed' };
    teamCard = await insert(Model, { ...cardBase, name: 'Payments model', providerId: teamProvider.id, vendorModelId: 'gpt-team' });
    orgCard = await insert(Model, { ...cardBase, name: 'Shared model', providerId: orgProvider.id, vendorModelId: 'gpt-org' });
  });

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  // ── 1. the LLM path ────────────────────────────────────────────────

  describe('a team provider on the LLM path', () => {
    let providers: LlmProvidersService;
    let router: ModelRouterService;

    beforeAll(() => {
      providers = new LlmProvidersService(
        repo(LlmProvider), repo(Conversation), repo(Message), repo(User), repo(Organization), repo(Gateway), repo(Tool),
        none, { log: jest.fn(), logUpdate: jest.fn(), logDelete: jest.fn(), logCreate: jest.fn() } as any,
        none, none, none, none, none, policy, { warmOrg: jest.fn() } as any, none,
      );
      router = new ModelRouterService(repo(Model), repo(LlmProvider), repo(ModelDeployment), none, resolver, policy);
    });

    it('is usable by a run through a gateway of its own team, which has no user', async () => {
      await expect(providers.getProvider(teamProvider.id, organizationId, true, paymentsGateway()))
        .resolves.toMatchObject({ id: teamProvider.id });
      expect((await router.plan(organizationId, {}, paymentsGateway())).candidates.map((c) => c.modelId))
        .toEqual(expect.arrayContaining([teamCard.id, orgCard.id]));
      await expect(router.providerForModelId(organizationId, teamCard.id, paymentsGateway()))
        .resolves.toMatchObject({ provider: { id: teamProvider.id } });
    });

    it("is refused to an org-wide gateway and to another team's gateway, with the 404 naming the gateway", async () => {
      for (const principal of [orgGateway(), otherTeamGateway()]) {
        const refusal = await providers.getProvider(teamProvider.id, organizationId, true, principal).catch((e) => e);
        expect(refusal).toBeInstanceOf(NotFoundException);
        expect(refusal.getResponse()).toMatchObject({ code: 'PROVIDER_NOT_USABLE' });
        expect(refusal.message).toContain(`gateway ${(principal as any).gatewayId}`);
        expect((await router.plan(organizationId, {}, principal)).candidates.map((c) => c.modelId)).toEqual([orgCard.id]);
        expect(await router.providerFor(teamCard, principal)).toBeNull();
      }
    });

    it("a gateway private to a member is judged as that member", async () => {
      await expect(providers.getProvider(teamProvider.id, organizationId, true, gateway('private', { ownerUserId: users.teammate })))
        .resolves.toMatchObject({ id: teamProvider.id });
      await expect(providers.getProvider(teamProvider.id, organizationId, true, gateway('private', { ownerUserId: users.outsider })))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('a user principal is still judged as that user, and nobody gets org providers only', async () => {
      await expect(providers.getProvider(teamProvider.id, organizationId, true, as('teammate'))).resolves.toMatchObject({ id: teamProvider.id });
      await expect(providers.getProvider(teamProvider.id, organizationId, true, as('admin'))).resolves.toMatchObject({ id: teamProvider.id });
      await expect(providers.getProvider(teamProvider.id, organizationId, true, as('outsider'))).rejects.toBeInstanceOf(NotFoundException);
      await expect(providers.getProvider(teamProvider.id, organizationId, true, userPrincipal(null))).rejects.toBeInstanceOf(NotFoundException);
      await expect(providers.getProvider(orgProvider.id, organizationId, true, userPrincipal(null))).resolves.toMatchObject({ id: orgProvider.id });
    });

    describe('a chat turn made for a run (LlmChatHelper.chat)', () => {
      let runner: { callLlmProvider: jest.Mock; prepareTools: jest.Mock; executeToolCalls: jest.Mock; headProviderForRoute: jest.Mock };
      let chat: LlmChatHelper;
      let teamTool: Tool;
      let orgTool: Tool;

      beforeAll(async () => {
        const toolBase = { organizationId, type: ToolType.FUNCTION, status: ToolStatus.ACTIVE, parameters: {} };
        teamTool = await insert(Tool, { ...toolBase, name: 'payments_refund', visibility: 'team', teamId, createdBy: users.teammate });
        orgTool = await insert(Tool, { ...toolBase, name: 'shared_lookup', visibility: 'org', teamId: null, createdBy: users.admin });
      });

      beforeEach(() => {
        runner = {
          callLlmProvider: jest.fn().mockResolvedValue({
            message: { role: 'assistant', content: 'ok' },
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            cost: 0,
            model: 'gpt-x',
          }),
          prepareTools: jest.fn().mockResolvedValue([]),
          executeToolCalls: jest.fn(),
          headProviderForRoute: jest.fn(),
        };
        chat = new LlmChatHelper(
          repo(LlmProvider), repo(Conversation), repo(Message), repo(Tool),
          {} as any, { log: jest.fn() } as any, { calculateProviderCost: () => 0 } as any,
          providers,
          { bumpSessionStats: jest.fn().mockResolvedValue(undefined), bumpProviderStats: jest.fn().mockResolvedValue(undefined) } as any,
          runner as any, { resolve: jest.fn() } as any, { warmOrg: jest.fn() } as any,
          gate,
        );
      });

      const turn = (principal: ExecutionPrincipal) =>
        chat.chat(teamProvider.id, { messages: [{ role: 'user' as any, content: 'hi' }], toolIds: [teamTool.id, orgTool.id] } as any, organizationId, principal);

      it("reaches the team provider for a run through the team's gateway, and hands the principal down", async () => {
        await expect(turn(paymentsGateway())).resolves.toMatchObject({ message: { content: 'ok' } });
        const [provider, , , tools, principal] = runner.callLlmProvider.mock.calls[0];
        expect(provider.id).toBe(teamProvider.id);
        expect(principal).toEqual(paymentsGateway());
        expect(tools.map((t: Tool) => t.id).sort()).toEqual([teamTool.id, orgTool.id].sort());
      });

      it('is refused, as a missing provider, for a principal outside the team', async () => {
        for (const principal of [as('outsider'), orgGateway(), otherTeamGateway(), userPrincipal(null)]) {
          await expect(turn(principal)).rejects.toMatchObject({ response: { code: 'PROVIDER_NOT_USABLE' } });
        }
        expect(runner.callLlmProvider).not.toHaveBeenCalled();
      });

      it("offers the model only the tools the principal may run: a team tool's schema stays with its team", async () => {
        await chat.chat(orgProvider.id, { messages: [{ role: 'user' as any, content: 'hi' }], toolIds: [teamTool.id, orgTool.id] } as any, organizationId, as('outsider'));
        expect(runner.callLlmProvider.mock.calls[0][3].map((t: Tool) => t.id)).toEqual([orgTool.id]);
      });
    });
  });

  // ── 2. credentials resolved for a call ─────────────────────────────

  describe('a plain team credential resolved for a call', () => {
    let teamCredential: Credential;
    let teamConnector: Credential;

    beforeAll(async () => {
      const base = { type: CredentialType.BEARER_TOKEN, organizationId, isActive: true, visibility: 'team', teamId, ownerUserId: null };
      teamCredential = await insert(Credential, { ...base, name: 'Payments upstream token', config: { token: 'team-secret' } });
      teamConnector = await insert(Credential, { ...base, name: 'Payments OpenAI key', connectorKey: 'openai', type: CredentialType.API_KEY, config: { apiKey: 'sk-team' } });
    });

    it('resolves for the team, for org admins and for a gateway of the team', async () => {
      for (const principal of [{ id: users.teammate }, { id: users.admin }, as('teammate'), paymentsGateway(), gateway('private', { ownerUserId: users.teammate })]) {
        await expect(resolver.resolve(organizationId, teamCredential.id, { principal }))
          .resolves.toMatchObject({ config: { token: 'team-secret' } });
      }
    });

    it('is not found for a member outside the team, an org-wide or other-team gateway, and nobody', async () => {
      for (const principal of [{ id: users.outsider }, as('outsider'), orgGateway(), otherTeamGateway(), userPrincipal(null), null]) {
        await expect(resolver.resolve(organizationId, teamCredential.id, { principal })).rejects.toMatchObject(notFound);
        expect(await resolver.tryResolve(organizationId, teamCredential.id, { principal })).toBeNull();
      }
    });

    it('a system path with no principal is refused a team connector key too (the grants policy let it through)', async () => {
      await expect(resolver.resolve(organizationId, teamConnector.id, { principal: null, context: { purpose: 'backfill' } }))
        .rejects.toMatchObject(notFound);
    });

    it('the system acting for a resource of the same team reaches it; for any other resource it does not', async () => {
      const payments = { organizationId, visibility: 'team' as const, teamId };
      await expect(resolver.resolve(organizationId, teamCredential.id, { principal: null, systemFor: payments })).resolves.toBeDefined();
      for (const actor of [
        { organizationId, visibility: 'org' as const, teamId: null },
        { organizationId, visibility: 'team' as const, teamId: otherTeamId },
        { organizationId, visibility: 'private' as const, ownerUserId: users.outsider },
      ]) {
        await expect(resolver.resolve(organizationId, teamCredential.id, { principal: null, systemFor: actor })).rejects.toMatchObject(notFound);
      }
      // A private resource of a team member acts as that member.
      await expect(resolver.resolve(organizationId, teamCredential.id, {
        principal: null, systemFor: { organizationId, visibility: 'private', ownerUserId: users.teammate },
      })).resolves.toBeDefined();
    });

    describe('bound to an org-wide API (ToolAuthService.applyApiAuth)', () => {
      let toolAuth: ToolAuthService;
      let api: Api;

      beforeAll(async () => {
        toolAuth = new ToolAuthService(repo(Credential), { get: () => undefined } as any, makeEnvelopeCryptoMock(), resolver);
        api = await insert(Api, { organizationId, name: 'Ledger', type: ApiType.OPENAPI, baseUrl: 'https://ledger.example.com', visibility: 'org', teamId: null });
        await insert(Credential, {
          type: CredentialType.BEARER_TOKEN, organizationId, isActive: true, visibility: 'team', teamId, ownerUserId: null,
          name: 'Ledger token (Payments)', config: { token: 'ledger-team-token' }, apiId: api.id,
        });
      });

      const call = async (principal: ExecutionPrincipal) => {
        const config: any = { headers: {} };
        await toolAuth.applyApiAuth(config, api, { organizationId, principal } as any);
        return config.headers.Authorization;
      };

      it('signs the call for the team and for a gateway of the team', async () => {
        for (const principal of [as('teammate'), as('admin'), paymentsGateway()]) {
          expect(await call(principal)).toBe('Bearer ledger-team-token');
        }
      });

      it('is not sent for anyone outside the team: the call fails as not found rather than going out', async () => {
        for (const principal of [as('outsider'), orgGateway(), otherTeamGateway(), userPrincipal(null)]) {
          const config: any = { headers: {} };
          await expect(toolAuth.applyApiAuth(config, api, { organizationId, principal } as any)).rejects.toMatchObject(notFound);
          expect(config.headers.Authorization).toBeUndefined();
        }
      });

      it('a team connection named on an org-wide API is held to its team as well', async () => {
        const viaConnection = { ...api, authentication: { type: 'bearer', config: { connectionId: teamCredential.id } } } as any;
        const signed: any = { headers: {} };
        await toolAuth.applyApiAuth(signed, viaConnection, { organizationId, principal: paymentsGateway() } as any);
        expect(signed.headers.Authorization).toBe('Bearer team-secret');
        await expect(toolAuth.applyApiAuth({ headers: {} } as any, viaConnection, { organizationId, principal: as('outsider') } as any))
          .rejects.toMatchObject(notFound);
      });
    });

    describe("an MCP source's credential (McpSourcesService.executeToolCall)", () => {
      let mcp: McpSourcesService;
      let callTool: jest.Mock;
      let source: McpSource;

      beforeAll(async () => {
        callTool = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
        mcp = new McpSourcesService(repo(McpSource), repo(Tool), { callTool } as any, makeEnvelopeCryptoMock(), resolver);
        source = await insert(McpSource, {
          name: 'payments-mcp', url: 'https://mcp.example.com', authType: 'bearer', authConfig: null,
          credentialId: teamCredential.id, status: McpSourceStatus.ACTIVE, organizationId, toolCount: 0,
        });
      });

      beforeEach(() => callTool.mockClear());

      it('calls the server with the team credential for the team and its gateway', async () => {
        for (const principal of [as('teammate'), paymentsGateway()]) {
          await mcp.executeToolCall(organizationId, { sourceId: source.id, remoteName: 'refund' }, {}, { principal });
        }
        expect(callTool).toHaveBeenCalledTimes(2);
        expect(callTool.mock.calls[0][0].headers.Authorization).toBe('Bearer team-secret');
      });

      it('never sends it for anyone outside the team', async () => {
        for (const principal of [as('outsider'), orgGateway(), userPrincipal(null)]) {
          await expect(mcp.executeToolCall(organizationId, { sourceId: source.id, remoteName: 'refund' }, {}, { principal }))
            .rejects.toMatchObject(notFound);
        }
        expect(callTool).not.toHaveBeenCalled();
      });
    });
  });

  // ── 3. grants and org governance see the principal ────────────────

  describe('the grants policy and org governance judge a gateway run as the gateway', () => {
    let grants: GrantsService;
    let governed: CredentialRefResolver;
    let beforeUse: jest.Mock;
    let orgConnection: Credential;
    let teamConnection: Credential;
    let budgetId: string;
    const denied = { response: { code: 'CONNECTION_NOT_GRANTED' } };
    const use = (connection: Credential, principal: ExecutionPrincipal | null, context: Record<string, string> = {}) =>
      governed.resolve(organizationId, connection.id, { principal, context: { purpose: 'llm_call', ...context } as any });

    beforeAll(async () => {
      const audit = { log: jest.fn() } as any;
      grants = new GrantsService(
        repo(ConnectionGrant), repo(Credential), repo(UserOrganization), repo(UserTeam), repo(Team),
        repo(Agent), repo(Workspace), repo(SpendBudget), audit,
      );
      beforeUse = jest.fn().mockResolvedValue(undefined);
      governed = new CredentialRefResolver(
        repo(Credential), makeEnvelopeCryptoMock(), new GrantsUsePolicy(grants), { beforeConnect: jest.fn(), beforeUse } as any, gate,
      );
      const base = { organizationId, isActive: true, type: CredentialType.API_KEY, connectorKey: 'openai' };
      orgConnection = await insert(Credential, { ...base, name: 'Org OpenAI', config: { apiKey: 'sk-org' }, visibility: 'org', teamId: null, ownerUserId: null });
      teamConnection = await insert(Credential, { ...base, name: 'Payments OpenAI conn', config: { apiKey: 'sk-pay' }, visibility: 'team', teamId, ownerUserId: null });
      budgetId = (await insert(SpendBudget, { organizationId, limitCents: 100 }) as any).id;
    });

    beforeEach(() => beforeUse.mockClear());

    it('a gateway with no grant is refused an org connection; it is not the system', async () => {
      for (const principal of [orgGateway(), paymentsGateway()]) {
        await expect(use(orgConnection, principal)).rejects.toMatchObject(denied);
      }
      // A resolve with nobody behind it is still the system path.
      await expect(use(orgConnection, null)).resolves.toBeDefined();
      // An org admin holds connections:manage; a member does not.
      await expect(use(orgConnection, as('admin'))).resolves.toBeDefined();
      await expect(use(orgConnection, as('outsider'))).rejects.toMatchObject(denied);
    });

    it("a team grant reaches the team's gateway (as its team), and no other gateway", async () => {
      await insert(ConnectionGrant, { organizationId, connectionId: orgConnection.id, principalType: 'team', principalId: teamId, permission: 'use', budgetId });
      grants.invalidate(orgConnection.id);
      await expect(use(orgConnection, paymentsGateway())).resolves.toBeDefined();
      await expect(use(orgConnection, as('teammate'))).resolves.toBeDefined();
      for (const principal of [orgGateway(), otherTeamGateway(), as('outsider')]) {
        await expect(use(orgConnection, principal)).rejects.toMatchObject(denied);
      }
    });

    it('an agent grant reaches any gateway running that agent', async () => {
      const agentId = '00000000-0000-4000-8000-00000000a9e7';
      await insert(ConnectionGrant, { organizationId, connectionId: teamConnection.id, principalType: 'agent', principalId: agentId, permission: 'use' });
      grants.invalidate(teamConnection.id);
      await expect(use(teamConnection, paymentsGateway(), { resourceType: 'agent', resourceId: agentId })).resolves.toBeDefined();
      // Without the agent's grant: refused. A gateway holds no connections:read,
      // so a team connection it holds no grant on reads as missing.
      await expect(use(teamConnection, paymentsGateway())).rejects.toMatchObject({ response: { code: 'CONNECTION_NOT_FOUND' } });
      // The team rule still comes first: another team's gateway does not see it at all.
      await expect(use(teamConnection, otherTeamGateway(), { resourceType: 'agent', resourceId: agentId })).rejects.toMatchObject(notFound);
    });

    it('governance receives the gateway, its team, and the grant (with its budget) that allowed the use', async () => {
      await use(orgConnection, paymentsGateway());
      expect(beforeUse).toHaveBeenCalledTimes(1);
      const [org, connection, principal, context, decision] = beforeUse.mock.calls[0];
      expect(org).toBe(organizationId);
      expect(connection.id).toBe(orgConnection.id);
      expect(principal).toMatchObject({ userId: undefined, gatewayId: (paymentsGateway() as any).gatewayId, teamIds: [teamId] });
      expect(context).toMatchObject({ purpose: 'llm_call', principalKinds: ['team'] });
      expect(decision).toMatchObject({ via: 'grant', grant: { principalType: 'team', principalId: teamId, budgetId } });

      beforeUse.mockClear();
      await use(orgConnection, as('teammate'));
      const [, , userPrincipalSeen, userContext] = beforeUse.mock.calls[0];
      expect(userPrincipalSeen).toMatchObject({ userId: users.teammate });
      expect(userPrincipalSeen.gatewayId).toBeUndefined();
      expect(userContext.principalKinds).toBeUndefined();
    });
  });
});
