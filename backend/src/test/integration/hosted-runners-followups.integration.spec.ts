import * as crypto from 'crypto';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { Agent, AgentStatus } from '../../entities/agent.entity';
import { AgentExecution } from '../../entities/agent-execution.entity';
import { AgentRun, AgentRunStatus } from '../../entities/agent-run.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { AuditLog, AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { Environment } from '../../entities/environment.entity';
import { HostedModelToken } from '../../entities/hosted-model-token.entity';
import { HostedRunner } from '../../entities/hosted-runner.entity';
import { Organization } from '../../entities/organization.entity';
import { RetentionPolicy } from '../../entities/retention-policy.entity';
import { RunnerEnrollmentToken } from '../../entities/runner-enrollment-token.entity';
import { RunnerSession } from '../../entities/runner-session.entity';
import { RunnerUsageInterval } from '../../entities/runner-usage-interval.entity';
import { Runner } from '../../entities/runner.entity';
import { Team } from '../../entities/team.entity';
import { Tool } from '../../entities/tool.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { Workspace, WorkspaceStatus } from '../../entities/workspace.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { LlmProvider, LlmProviderStatus } from '../../entities/llm-provider.entity';
import { LlmProviderType } from '../../entities/llm-provider-type';

import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { RunnerService } from '../../modules/runner/runner.service';
import { RunnerCapabilityPublisher } from '../../modules/runner/runner-capability.publisher';
import { RunnerCredentialService, runnerSessionUser } from '../../modules/runner/runner-credential';
import { OrganizationsService } from '../../modules/organizations/organizations.service';
import { ResourceHandoverHelper } from '../../modules/organizations/resource-handover.helper';
import { ConnectionOffboardingService } from '../../modules/connections/connection-offboarding.service';
import { RetentionSweepService } from '../../modules/retention/retention-sweep.service';
import { ApiKeyStrategy } from '../../modules/auth/strategies/api-key.strategy';
import { AgentOpenAICompatController } from '../../modules/agents/agent-openai-compat.controller';
import { AgentAnthropicCompatController } from '../../modules/agents/agent-anthropic-compat.controller';
import { HostedAdapterRegistry } from '../../modules/hosted-runners/adapters/adapter.registry';
import { StubHostedAdapter } from '../../modules/hosted-runners/adapters/stub.adapter';
import { buildDeployment, buildSecret } from '../../modules/hosted-runners/adapters/kubernetes/manifests';
import { DEFAULT_HOSTED_RUNNER_SETTINGS, HostedRunnerSettingsService, deepMerge } from '../../modules/hosted-runners/hosted-runner-settings';
import { HostedRunnersService } from '../../modules/hosted-runners/hosted-runners.service';
import { HostedRunnersProcessor } from '../../modules/hosted-runners/hosted-runners.processor';
import { EnrollmentService } from '../../modules/hosted-runners/enrollment.service';
import { HostedUsageService } from '../../modules/hosted-runners/hosted-usage.service';
import { HostedModelTokenService } from '../../modules/hosted-runners/hosted-model-token.service';
import { WorkspaceLeaseService } from '../../modules/hosted-runners/workspace-lease.service';
import { EnvironmentHandoverService } from '../../modules/hosted-runners/environment-handover.service';
import { EnvironmentInsightsService } from '../../modules/hosted-runners/environment-insights.service';
import { EnvironmentsService } from '../../modules/hosted-runners/environments.service';
import { provisionExtensionsInPublic } from './test-db-extensions';
import { ModelPassThroughService } from '../../modules/agents/model-pass-through.service';
import { ModelPassThroughController } from '../../modules/agents/model-pass-through.controller';
import { HostedRunnerEnrollmentController } from '../../modules/hosted-runners/hosted-runner-enrollment.controller';
import { SpendService } from '../../modules/budgets/spend.service';
import { HostedModelCall } from '../../entities/hosted-model-call.entity';
import { Model } from '../../entities/model.entity';
import { callLlmProviderHttp } from '../../modules/llm-providers/providers/safe-request';

// The vendor's side of the model pass-through; everything of ours is real.
jest.mock('../../modules/llm-providers/providers/safe-request', () => ({
  ...jest.requireActual('../../modules/llm-providers/providers/safe-request'),
  callLlmProviderHttp: jest.fn(),
}));
const httpCall = callLlmProviderHttp as jest.Mock;

/**
 * The hosted-runner follow-ups of 2026-10-08 against a real Postgres, with
 * the stub adapter standing in for the cluster:
 *
 * - the pod-scoped model token: minted at pod start into the Secret only,
 *   accepted by the model endpoints, refused by the platform API, refused
 *   once the pod stops;
 * - one folder per person per environment: jobs on it run one after
 *   another, a job's helpers share its turn, a lone call holds it for the
 *   call only;
 * - the owner leaving (environments to the longest-standing owner, the
 *   leaver's pods stopped, files kept) and a team being deleted
 *   (environments shared with it private to their owner again);
 * - usage records kept 13 months (or the organization's own period), open
 *   ones never deleted.
 */
const describeIfDb = process.env.RUN_DB_INTEGRATION === '1' ? describe : describe.skip;
jest.setTimeout(180_000);

const SCHEMA = 'hosted_followups_test';
const connection = () => ({
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || '127.0.0.1',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'postgres',
  database: process.env.DATABASE_NAME || 'almyty_test',
});

const RUNTIME = { os: 'linux', arch: 'x64', hostname: 'pod', cpuCount: 1, memoryMb: 2048, runnerVersion: '1.5.3', binaries: {} };

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  return res;
}

describeIfDb('hosted runners follow-ups (real Postgres)', () => {
  let ds: DataSource;
  let settings: HostedRunnerSettingsService;
  let stub: StubHostedAdapter;
  let hosted: HostedRunnersService;
  let processor: HostedRunnersProcessor;
  let enrollment: EnrollmentService;
  let runners: RunnerService;
  let credentials: RunnerCredentialService;
  let modelTokens: HostedModelTokenService;
  let leases: WorkspaceLeaseService;
  let audit: AuditLogService;
  let orgs: OrganizationsService;
  let notifications: { emit: jest.Mock };
  let queue: { add: jest.Mock; getRepeatableJobs: jest.Mock };
  const previousProvider = process.env.HOSTED_RUNNERS_PROVIDER;
  let seq = 0;

  const repo = <T extends object>(entity: new () => T) => ds.getRepository(entity);

  beforeAll(async () => {
    process.env.HOSTED_RUNNERS_PROVIDER = 'stub';
    const bootstrap = new DataSource(connection());
    await bootstrap.initialize();
    await bootstrap.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await bootstrap.query(`CREATE SCHEMA "${SCHEMA}"`);
    await provisionExtensionsInPublic((sql, params) => bootstrap.query(sql, params as any[]));
    await bootstrap.destroy();
    ds = new DataSource({
      ...connection(),
      schema: SCHEMA,
      extra: { options: `-c search_path=${SCHEMA},public` },
      entities: [join(__dirname, '..', '..', 'entities', '*.entity{.ts,.js}')],
      migrations: [join(__dirname, '..', '..', 'migrations', '*{.ts,.js}')],
      migrationsTransactionMode: 'all',
      logging: false,
    });
    await ds.initialize();
    await ds.runMigrations();

    // A short queue wait, so a busy workspace answers within the test.
    settings = new HostedRunnerSettingsService(
      deepMerge(DEFAULT_HOSTED_RUNNER_SETTINGS, { apiUrl: 'https://api.almyty.test', workspaceQueue: { waitSeconds: 1, pollSeconds: 1 } }),
      { HOSTED_RUNNERS_ENABLED: 'true' },
    );
    const accessPolicy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    notifications = { emit: jest.fn(async () => undefined) };
    queue = { add: jest.fn(async () => undefined), getRepeatableJobs: jest.fn(async () => []) };
    audit = new AuditLogService(repo(AuditLog), repo(User));
    leases = new WorkspaceLeaseService(repo(Workspace), settings, repo(AgentRun), repo(AgentExecution));
    hosted = new HostedRunnersService(
      repo(HostedRunner), repo(Environment), repo(Workspace), repo(Runner), queue as any, ds, settings, accessPolicy,
      { capacityFor: async () => ({ maxConcurrentRunners: 10, maxWorkspaces: 50, resourceClasses: null }) },
      undefined, undefined, audit, notifications as any, leases,
    );
    credentials = new RunnerCredentialService();
    enrollment = new EnrollmentService(repo(RunnerEnrollmentToken), repo(HostedRunner), repo(Runner), credentials, settings);
    modelTokens = new HostedModelTokenService(repo(HostedModelToken), repo(HostedRunner), repo(Workspace), repo(Environment), repo(User), settings, audit);
    stub = new StubHostedAdapter();
    const registry = new HostedAdapterRegistry();
    registry.register(stub);
    processor = new HostedRunnersProcessor(
      queue as any, repo(HostedRunner), repo(Environment), repo(Workspace), repo(Runner), registry, hosted, enrollment,
      new HostedUsageService(repo(RunnerUsageInterval)), settings, modelTokens,
    );
    const publisher = new RunnerCapabilityPublisher(repo(Tool));
    runners = new RunnerService(repo(Runner), repo(RunnerSession), repo(Workspace), publisher, accessPolicy);
    const offboarding = new ConnectionOffboardingService(repo(Credential), { revokeAtProvider: async () => ({ attempted: false }) } as any, audit);
    const handover = new ResourceHandoverHelper(audit, runners, offboarding, new EnvironmentHandoverService(audit, hosted, notifications as any));
    orgs = new OrganizationsService(
      repo(Organization), repo(UserOrganization), repo(Team), repo(UserTeam), repo(User),
      {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, handover, audit,
    );
  });

  afterAll(async () => {
    if (previousProvider === undefined) delete process.env.HOSTED_RUNNERS_PROVIDER;
    else process.env.HOSTED_RUNNERS_PROVIDER = previousProvider;
    if (ds?.isInitialized) await ds.destroy();
  });

  async function org(label: string): Promise<string> {
    const [row] = await ds.query(`INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id`, [`fu-${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}`]);
    return row.id;
  }

  async function member(organizationId: string, label: string, role: OrganizationRole, joinedAt = new Date()): Promise<string> {
    const [user] = await ds.query(
      `INSERT INTO users (email, "passwordHash", "firstName", "lastName", "isActive") VALUES ($1, 'x', $2, 'T', true) RETURNING id`,
      [`${label}-${++seq}-${crypto.randomUUID().slice(0, 6)}@followups.test`, label],
    );
    await ds.query(
      `INSERT INTO user_organizations ("userId", "organizationId", role, "isActive", "inviteAccepted", "joinedAt") VALUES ($1, $2, $3, true, true, $4)`,
      [user.id, organizationId, role, joinedAt],
    );
    return user.id;
  }

  async function environment(organizationId: string, ownerUserId: string, scope: { visibility?: 'private' | 'team' | 'org'; teamId?: string | null } = {}): Promise<Environment> {
    const env = await repo(Environment).save(repo(Environment).create({
      organizationId,
      ownerUserId,
      visibility: scope.visibility ?? 'private',
      teamId: scope.teamId ?? null,
      name: `env-${++seq}`,
      description: null,
      repo: null,
      image: { base: 'standard', ref: 'almyty/runner-env:standard' },
      setupScript: null,
      envBindings: [],
      cache: { paths: [] },
      egress: { allowHosts: [] },
      resourceClass: 'small',
      idleTimeoutMinutes: 15,
      clusterConnectionId: null,
      allowVendorKeys: false,
      version: 1,
    }));
    await new RunnerCapabilityPublisher(repo(Tool)).publishEnvironment(env);
    return env;
  }

  /** A pod that starts: enrolls with its Secret's token, connects, heartbeats; the loop sees it ready. */
  async function ready(hostedRunnerId: string): Promise<void> {
    await processor.reconcile(hostedRunnerId);
    const enrolled = await enrollment.enroll({ token: stub.pods.get(hostedRunnerId)!.secretEnv!.ALMYTY_ENROLLMENT_TOKEN, runtimeInfo: RUNTIME as any });
    expect(await runners.isOwnedBy(enrolled.runnerId, (await repo(HostedRunner).findOneByOrFail({ id: hostedRunnerId })).organizationId, runnerSessionUser(enrolled.runnerId))).toBe(true);
    await runners.onSessionConnect(enrolled.runnerId, `sess-${crypto.randomUUID()}`);
    await runners.heartbeat(enrolled.runnerId);
    await processor.reconcile(hostedRunnerId);
    expect((await repo(HostedRunner).findOneByOrFail({ id: hostedRunnerId })).state).toBe('ready');
  }

  async function run(organizationId: string, userId: string, parentRunId: string | null = null): Promise<string> {
    const agent = await repo(Agent).save(repo(Agent).create({
      organizationId, name: `agent ${++seq}`, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] }, createdBy: userId, visibility: 'org',
    } as any));
    const saved = await repo(AgentRun).save(repo(AgentRun).create({ agentId: (agent as any).id, organizationId, userId, status: AgentRunStatus.RUNNING, parentRunId } as any));
    return (saved as any).id;
  }

  describe('the pod-scoped model token', () => {
    let organizationId: string;
    let owner: string;
    let env: Environment;
    let hostedRunnerId: string;
    let token: string;

    beforeAll(async () => {
      organizationId = await org('token');
      owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      env = await environment(organizationId, owner);
      const first = await hosted.resolveTarget(env.id, { organizationId, callerUserId: owner });
      hostedRunnerId = first.hostedRunnerId;
    });

    it('is minted at pod start into the Secret only, under the names the images read, with just its hash stored', async () => {
      await processor.reconcile(hostedRunnerId);
      const secret = stub.pods.get(hostedRunnerId)!.secretEnv!;
      token = secret.ALMYTY_MODEL_TOKEN;
      expect(token).toMatch(/^almyty_pod_/);
      expect(new Date(secret.ALMYTY_MODEL_TOKEN_EXPIRES_AT).getTime()).toBeGreaterThan(Date.now());
      // The CLIs never get it: no vendor key names carry it.
      expect(secret.ANTHROPIC_API_KEY).toBeUndefined();
      expect(secret.OPENAI_API_KEY).toBeUndefined();
      const rows = await repo(HostedModelToken).findBy({ hostedRunnerId });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ tokenHash: crypto.createHash('sha256').update(token).digest('hex'), ownerUserId: owner, environmentId: env.id, revokedAt: null });
      expect(rows[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(settings.minutes(settings.current.modelAccess.tokenTtlMinutes));
      expect(JSON.stringify(await ds.query(`SELECT * FROM hosted_model_tokens`))).not.toContain(token);

      // The pod spec names the runner's model proxy and the Secret by
      // reference; the token itself is only in the Secret.
      const hr = await repo(HostedRunner).findOneByOrFail({ id: hostedRunnerId });
      const req = await processor.provisionRequest(hr, env);
      expect(req.env).toMatchObject({ ALMYTY_API_URL: 'https://api.almyty.test', ALMYTY_MODEL_PROXY_PORT: String(settings.current.modelAccess.localProxyPort), ALMYTY_MODEL_RENEW_PATH: '/runners/hosted/model-token' });
      const layout = settings.current.cluster;
      expect(JSON.stringify(buildDeployment(req, layout, 1))).not.toContain(token);
      expect(JSON.stringify(req)).not.toContain(token);
      expect(JSON.stringify(buildSecret(req, secret, layout))).toContain(token);
    });

    it('is refused until the machine is ready', async () => {
      await expect(modelTokens.authenticate(token)).rejects.toThrow(/not valid/);
    });

    it('reaches models through the pass-through only: organization-wide providers, recorded as spend, never an agent', async () => {
      await ready(hostedRunnerId);
      const key: any = await modelTokens.authenticate(token);
      expect(key).toMatchObject({ organizationId, userId: owner, hostedModelToken: { hostedRunnerId, environmentId: env.id } });

      // An organization-wide Anthropic provider with one validated model,
      // and the owner's private one with the same model: only the first may answer.
      const shared = await repo(LlmProvider).save(repo(LlmProvider).create({ organizationId, visibility: 'org', name: `shared ${++seq}`, type: LlmProviderType.ANTHROPIC, configuration: {}, status: LlmProviderStatus.ACTIVE } as any)) as any;
      const mine = await repo(LlmProvider).save(repo(LlmProvider).create({ organizationId, visibility: 'private', ownerUserId: owner, name: `mine ${++seq}`, type: LlmProviderType.ANTHROPIC, configuration: {}, status: LlmProviderStatus.ACTIVE } as any)) as any;
      await ds.query(
        `INSERT INTO models ("organizationId", name, "providerId", "providerType", "vendorModelId", status, "validationStatus", pricing, "createdAt")
         VALUES ($1, 'claude-sonnet-4-5', $2, 'anthropic', 'claude-sonnet-4-5', 'active', 'passed', '{"inPerMTok":3,"outPerMTok":15,"currency":"USD"}', now() - interval '1 minute'),
                ($1, 'claude-sonnet-4-5', $3, 'anthropic', 'claude-sonnet-4-5', 'active', 'passed', '{"inPerMTok":3,"outPerMTok":15,"currency":"USD"}', now())`,
        [organizationId, mine.id, shared.id],
      );
      const passThrough = new ModelPassThroughService(
        repo(Model), repo(LlmProvider), repo(HostedModelCall),
        { withResolvedSecrets: async (p: any) => Object.assign(p, { getDecryptedApiKey: () => 'fake-vendor-key-for-tests' }) } as any,
        { enforceForOrganization: async () => undefined } as any, undefined, audit, settings,
      );
      httpCall.mockResolvedValue({ status: 200, data: { id: 'msg_1', type: 'message', content: [], usage: { input_tokens: 1000, output_tokens: 100 } }, headers: {} });

      const agents = { findAllActive: jest.fn(async () => []), findByName: jest.fn(async () => null), getAgent: jest.fn() };
      const allow = { canExecute: jest.fn(async () => ({ allowed: true })) };
      const anthropic = new AgentAnthropicCompatController(agents as any, {} as any, repo(ApiKey), undefined, allow as any, undefined, modelTokens, passThrough);
      const answered = fakeRes();
      const tools = [{ name: 'Bash', input_schema: { type: 'object' } }];
      await anthropic.messages({ model: 'claude-sonnet-4-5', max_tokens: 16, tools, messages: [{ role: 'user', content: 'hi' }] } as any, undefined as any, token, { headers: {}, on: () => undefined, off: () => undefined } as any, answered);
      expect(answered.statusCode).toBe(200);
      expect(httpCall.mock.calls[0][0].data.tools).toEqual(tools);
      expect(answered.headers).toMatchObject({ 'X-Almyty-Hosted-Runner': hostedRunnerId, 'X-Almyty-Route-Provider': shared.id });
      expect(agents.findByName).not.toHaveBeenCalled();

      const [call] = await repo(HostedModelCall).findBy({ hostedRunnerId });
      expect(call).toMatchObject({ providerId: shared.id, agentId: null, userId: owner, inputTokens: 1000, outputTokens: 100, status: 200 });
      expect(call.totalCost).toBeCloseTo((1000 * 3 + 100 * 15) / 1_000_000, 10);
      // The organization's spend, which its budgets are measured against, includes it.
      const spend = new SpendService(repo(AgentRun), repo(AgentExecution), repo(HostedModelCall));
      expect(await spend.periodToDateCents({ organizationId, from: new Date(Date.now() - 60_000) })).toBe(Math.round(call.totalCost * 100));

      // A pod lists the shared provider's models, not agents.
      const openai = new AgentOpenAICompatController(agents as any, {} as any, repo(ApiKey), {} as any, undefined, allow as any, undefined, modelTokens, passThrough);
      const listed = fakeRes();
      await openai.listModels(`Bearer ${token}`, listed, {} as any);
      expect(listed.body.data.map((m: any) => m.id)).toEqual(['claude-sonnet-4-5']);
      expect(agents.findAllActive).not.toHaveBeenCalled();

      // A refused pod token is a 401, never a fall-through to another key path.
      const refused = fakeRes();
      await openai.listModels(`Bearer almyty_pod_plainly-fake-unknown-token`, refused, {} as any);
      expect(refused.statusCode).toBe(401);
      // And /v1/responses takes nothing but a pod token.
      const responses = new ModelPassThroughController(passThrough, modelTokens);
      const keyed = fakeRes();
      await responses.responses({ model: 'gpt-5', input: 'hi' }, 'Bearer ak_live_not_a_pod_token', { headers: {} } as any, keyed);
      expect(keyed.statusCode).toBe(401);
    });

    it('is renewed with itself while the pod runs; the old one stops at once', async () => {
      const controller = new HostedRunnerEnrollmentController({} as any, modelTokens);
      const renewed = (await controller.renewModelToken(`Bearer ${token}`)).data;
      expect(renewed.token).not.toBe(token);
      await expect(modelTokens.authenticate(token)).rejects.toThrow(/not valid/);
      await expect(controller.renewModelToken(`Bearer ${token}`)).rejects.toThrow(/not valid/);
      expect(await modelTokens.authenticate(renewed.token)).toMatchObject({ userId: owner });
      token = renewed.token;
    });

    it('is refused by the platform API and the runner surface', async () => {
      const strategy = new ApiKeyStrategy({ validateApiKey: (hash: string) => repo(ApiKey).findOne({ where: { keyHash: hash } }) } as any);
      await expect(strategy.validate({ headers: { authorization: `Bearer ${token}` }, query: {} } as any)).rejects.toThrow(/Invalid API key/);
      expect(credentials.verify(token)).toBeNull();
    });

    it('stops working the moment the pod is asked to stop, and a new start mints a new one', async () => {
      await repo(HostedRunner).update({ id: hostedRunnerId }, { lastActiveAt: new Date(Date.now() - settings.minutes(env.idleTimeoutMinutes + 1)) });
      await hosted.suspendIdle(new Date());
      await processor.reconcile(hostedRunnerId);
      await expect(modelTokens.authenticate(token)).rejects.toThrow(/not valid/);
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      expect((await repo(HostedModelToken).findOneByOrFail({ tokenHash: hash })).revokedReason).toBe('pod_stopped');
      expect(await audit['auditLogRepository'].countBy({ action: AuditAction.HOSTED_MODEL_TOKEN_REVOKED, resourceId: hostedRunnerId })).toBe(1);
      // A stopped pod's token cannot be renewed either.
      await expect(modelTokens.renew(token)).rejects.toThrow(/not valid/);

      await processor.reconcile(hostedRunnerId);
      await hosted.resolveTarget(env.id, { organizationId, callerUserId: owner });
      await processor.reconcile(hostedRunnerId);
      const next = stub.pods.get(hostedRunnerId)!.secretEnv!.ALMYTY_MODEL_TOKEN;
      expect(next).not.toBe(token);
      // The first, its renewal, and the new start's.
      expect(await repo(HostedModelToken).countBy({ hostedRunnerId })).toBe(3);
    });
  });

  describe('what the Hosted tab reads', () => {
    let insights: EnvironmentInsightsService;

    beforeAll(() => {
      const accessPolicy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
      const environments = new EnvironmentsService(
        repo(Environment), repo(Credential), accessPolicy, settings, hosted, new RunnerCapabilityPublisher(repo(Tool)),
      );
      insights = new EnvironmentInsightsService(settings, hosted, environments, accessPolicy, ds);
    });

    it('tells the list each caller\'s own machine, and whether anything asked for its pod', async () => {
      const organizationId = await org('mine');
      const owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      const used = await environment(organizationId, owner);
      const untouched = await environment(organizationId, owner);
      const target = await hosted.resolveTarget(used.id, { organizationId, callerUserId: owner });
      const mine = await insights.machines(owner, organizationId, [used.id, untouched.id]);
      expect(mine[untouched.id]).toBeNull();
      expect(mine[used.id]).toMatchObject({ workspaceId: target.workspaceId, status: WorkspaceStatus.SUSPENDED, machine: { id: target.hostedRunnerId, state: 'pending', desired: { replicas: 1 } } });
      const [row] = await hosted.listWorkspaces(used.id, owner, organizationId);
      expect(row.machine).toMatchObject({ desired: { replicas: 1 } });
    });

    it('offers the install\'s images, sizes, idle-timeout bounds and file keep days', async () => {
      const organizationId = await org('options');
      const options = await insights.options(organizationId);
      expect(options.images).toEqual(Object.keys(settings.current.images));
      expect(options.idleTimeoutMinutes).toEqual(settings.current.idleTimeoutMinutes);
      expect(options.suspendedRetention).toEqual(settings.current.suspendedRetention);
      expect(options.resourceClasses.map((c) => c.name)).toEqual(Object.keys(settings.current.resourceClasses));
      expect(options).toMatchObject({ enabled: true, defaultResourceClass: settings.current.defaultResourceClass, usageRetentionMonths: 13 });
    });

    it('counts runner minutes this month per environment, and for the organization to its admins only', async () => {
      const organizationId = await org('usage');
      const owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      const peer = await member(organizationId, 'peer', OrganizationRole.MEMBER);
      const env = await environment(organizationId, owner);
      const now = new Date();
      const minute = 60_000;
      const add = (startedAt: Date, endedAt: Date | null) =>
        ds.query(
          `INSERT INTO runner_usage_intervals ("organizationId", "hostedRunnerId", "environmentId", "workspaceId", "resourceClass", "startedAt", "endedAt") VALUES ($1, $2, $3, $4, 'small', $5, $6)`,
          [organizationId, crypto.randomUUID(), env.id, crypto.randomUUID(), startedAt, endedAt],
        );
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      await add(new Date(monthStart.getTime() - 60 * minute), new Date(monthStart.getTime() + 30 * minute)); // 30 of it this month
      await add(new Date(now.getTime() - 10 * minute), null); // open: 10 so far
      await add(new Date(monthStart.getTime() - 120 * minute), new Date(monthStart.getTime() - 90 * minute)); // last month only

      const period = insights.period(undefined, undefined, now);
      const mine = await insights.usage(owner, organizationId, period.from, period.to);
      const row = mine.environments.find((e) => e.environmentId === env.id)!;
      expect(row.minutes).toBeCloseTo(40, 0);
      expect(row.byClass.small).toBeCloseTo(40, 0);
      expect(mine.organization!.minutes).toBeCloseTo(40, 0);

      // A member who cannot see the private environment sees neither it nor the totals.
      const theirs = await insights.usage(peer, organizationId, period.from, period.to);
      expect(theirs.environments.map((e) => e.environmentId)).not.toContain(env.id);
      expect(theirs.organization).toBeNull();
      expect(() => insights.period('2026-10-08', '2026-10-01')).toThrow(/before/);
    });

    it('lists the runs of agents that use the environment: yours, or all of them for an admin', async () => {
      const organizationId = await org('runs');
      const owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      const peer = await member(organizationId, 'peer', OrganizationRole.MEMBER);
      const env = await environment(organizationId, owner, { visibility: 'org' });
      const onEnv = await repo(Agent).save(repo(Agent).create({
        organizationId, name: `on env ${++seq}`, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] }, createdBy: owner, visibility: 'org',
        agentConfig: { environmentId: env.id },
      } as any)) as any;
      const elsewhere = await repo(Agent).save(repo(Agent).create({
        organizationId, name: `elsewhere ${++seq}`, status: AgentStatus.ACTIVE, pipeline: { nodes: [], edges: [] }, createdBy: owner, visibility: 'org',
      } as any)) as any;
      const save = async (agentId: string, userId: string, parentRunId: string | null = null) =>
        ((await repo(AgentRun).save(repo(AgentRun).create({ agentId, organizationId, userId, status: AgentRunStatus.COMPLETED, parentRunId } as any))) as any).id;
      const ownerRun = await save(onEnv.id, owner);
      const peerRun = await save(onEnv.id, peer);
      await save(onEnv.id, owner, ownerRun); // a helper: part of its job, not listed apart
      await save(elsewhere.id, owner);
      const execution = ((await repo(AgentExecution).save(repo(AgentExecution).create({ agentId: onEnv.id, organizationId, userId: peer, status: 'completed', input: {} } as any))) as any).id;

      const all = await insights.runs(env.id, owner, organizationId);
      expect(all.map((r: any) => r.id).sort()).toEqual([ownerRun, peerRun, execution].sort());
      expect(all.find((r: any) => r.id === execution)).toMatchObject({ kind: 'execution', agentName: onEnv.name });
      const own = await insights.runs(env.id, peer, organizationId);
      expect(own.map((r: any) => r.id).sort()).toEqual([peerRun, execution].sort());
      expect(await insights.runs(env.id, owner, organizationId, 1)).toHaveLength(1);
    });
  });

  describe('a vendor key in a pod', () => {
    it('is refused unless the environment allows it, at save and at every start', async () => {
      const organizationId = await org('vendor');
      const owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      const common = { organizationId, visibility: 'org', teamId: null, isActive: true, ownerUserId: owner };
      const modelKey = await repo(Credential).save(repo(Credential).create({ ...common, name: `openai key ${++seq}`, type: CredentialType.API_KEY, config: { apiKey: 'plainly-fake' } } as any));
      const npmToken = await repo(Credential).save(repo(Credential).create({ ...common, name: `npm ${++seq}`, type: CredentialType.API_KEY, config: { apiKey: 'plainly-fake' } } as any));
      await repo(LlmProvider).save(repo(LlmProvider).create({
        organizationId, visibility: 'org', name: `prov ${++seq}`, type: LlmProviderType.OPENAI, configuration: { model: 'm' },
        status: LlmProviderStatus.ACTIVE, ownerUserId: owner, credentialId: (modelKey as any).id,
      } as any));

      expect(await hosted.vendorKeyConnections(organizationId, [(modelKey as any).id, (npmToken as any).id])).toEqual([(modelKey as any).id]);
      const bindings = [{ connectionId: (modelKey as any).id, field: 'apiKey', envVar: 'OPENAI_API_KEY' }];
      await expect(hosted.assertNoVendorKeys({ organizationId, allowVendorKeys: false, envBindings: bindings })).rejects.toMatchObject({ code: 'VENDOR_KEY_NOT_ALLOWED' });
      await expect(hosted.assertNoVendorKeys({ organizationId, allowVendorKeys: true, envBindings: bindings })).resolves.toBeUndefined();
      await expect(hosted.assertNoVendorKeys({ organizationId, allowVendorKeys: false, envBindings: [{ connectionId: (npmToken as any).id, field: 'apiKey', envVar: 'NPM_TOKEN' }] })).resolves.toBeUndefined();
    });
  });

  describe('one folder, one job at a time', () => {
    let organizationId: string;
    let owner: string;
    let env: Environment;
    let workspaceId: string;

    beforeAll(async () => {
      organizationId = await org('queue');
      owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      env = await environment(organizationId, owner);
      const first = await hosted.resolveTarget(env.id, { organizationId, callerUserId: owner });
      workspaceId = first.workspaceId;
      await ready(first.hostedRunnerId);
    });

    const call = (runId: string | null) => hosted.resolveTarget(env.id, { organizationId, callerUserId: owner, runId });
    const leaseOf = async () => (await repo(Workspace).findOneByOrFail({ id: workspaceId }));

    it('gives the workspace to one job; another job of the same person waits its turn', async () => {
      const jobA = await run(organizationId, owner);
      const jobB = await run(organizationId, owner);
      expect(await call(jobA)).toMatchObject({ kind: 'ready', workspaceId, lease: { holder: jobA, releaseAfterCall: false } });
      // The same job, and its helper runs, keep working in it.
      const helper = await run(organizationId, owner, jobA);
      expect(await call(helper)).toMatchObject({ kind: 'ready', lease: { holder: jobA } });
      const waited = await call(jobB);
      expect(waited).toMatchObject({ kind: 'busy', workspaceId, retryAfterMs: settings.current.workspaceQueue.retryAfterSeconds * 1000 });
      // A call with no run cannot cut in either.
      expect(await call(null)).toMatchObject({ kind: 'busy' });

      // Job A ends (its helper too): B gets the workspace next.
      await repo(AgentRun).update({ id: helper }, { status: AgentRunStatus.COMPLETED });
      expect(await call(jobB)).toMatchObject({ kind: 'busy' });
      await repo(AgentRun).update({ id: jobA }, { status: AgentRunStatus.COMPLETED });
      expect(await call(jobB)).toMatchObject({ kind: 'ready', lease: { holder: jobB } });
      expect(await leaseOf()).toMatchObject({ leaseHolder: jobB, leaseJob: true });
      await repo(AgentRun).update({ id: jobB }, { status: AgentRunStatus.COMPLETED });
    });

    it('lets two lone calls run one after the other, never at once', async () => {
      const [a, b] = await Promise.all([call(null), call(null)]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['busy', 'ready']);
      const winner = (a.kind === 'ready' ? a : b) as any;
      expect(winner.lease.releaseAfterCall).toBe(true);
      await hosted.releaseLease(workspaceId, winner.lease.holder);
      expect(await leaseOf()).toMatchObject({ leaseHolder: null, leaseJob: false, leaseUntil: null });
      expect(await call(null)).toMatchObject({ kind: 'ready' });
    });

    it('a holder that crashed does not block forever: its lease runs out', async () => {
      const stuck = await run(organizationId, owner);
      await ds.query(`UPDATE workspaces SET "leaseHolder" = $1, "leaseJob" = true, "leaseUntil" = now() - interval '1 minute' WHERE id = $2`, [stuck, workspaceId]);
      const next = await run(organizationId, owner);
      expect(await call(next)).toMatchObject({ kind: 'ready', lease: { holder: next } });
    });
  });

  describe('the owner leaves the organization', () => {
    let organizationId: string;
    let founder: string;
    let admin: string;
    let leaver: string;
    let env: Environment;
    let target: { workspaceId: string; hostedRunnerId: string };
    let podToken: string;

    beforeAll(async () => {
      organizationId = await org('leave');
      founder = await member(organizationId, 'founder', OrganizationRole.OWNER, new Date('2024-01-01'));
      await member(organizationId, 'late-owner', OrganizationRole.OWNER, new Date('2025-06-01'));
      admin = await member(organizationId, 'admin', OrganizationRole.ADMIN, new Date('2023-01-01'));
      leaver = await member(organizationId, 'leaver', OrganizationRole.MEMBER, new Date('2024-05-01'));
      env = await environment(organizationId, leaver, { visibility: 'org' });
      const first = await hosted.resolveTarget(env.id, { organizationId, callerUserId: leaver });
      target = { workspaceId: first.workspaceId, hostedRunnerId: first.hostedRunnerId };
      await ready(target.hostedRunnerId);
      podToken = stub.pods.get(target.hostedRunnerId)!.secretEnv!.ALMYTY_MODEL_TOKEN;
      queue.add.mockClear();
      notifications.emit.mockClear();
    });

    it('hands every environment of theirs to the longest-standing owner, audited, visibility and files kept', async () => {
      await orgs.removeMember(organizationId, leaver, admin);

      const after = await repo(Environment).findOneByOrFail({ id: env.id });
      // The longest-standing owner, not the remover and not an admin who joined earlier.
      expect(after).toMatchObject({ ownerUserId: founder, visibility: 'org', deletedAt: null });
      const tools = await repo(Tool).find({ where: { organizationId } });
      const envTools = tools.filter((t: any) => t.runnerConfig?.environmentId === env.id);
      expect(envTools.length).toBeGreaterThan(0);
      for (const t of envTools) expect(t.createdBy).toBe(founder);

      const transfers = await repo(AuditLog).findBy({ organizationId, action: AuditAction.OWNERSHIP_TRANSFER, resourceType: AuditResource.ENVIRONMENT, resourceId: env.id });
      expect(transfers).toHaveLength(1);
      expect(transfers[0].details).toMatchObject({ reason: 'member_removed', fromUserId: leaver, toUserId: founder, filesKept: true });
      expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'environments.handed_over', userIds: [founder] }));
      // The leaver's pod is stopped by the reconcile loop, woken for it once this committed.
      expect(queue.add).toHaveBeenCalledWith(expect.anything(), { hostedRunnerId: target.hostedRunnerId }, expect.anything());
    });

    it('stops their pod now, revokes its model token, and keeps the workspace and its volume for the new owner', async () => {
      const ws = await repo(Workspace).findOneByOrFail({ id: target.workspaceId });
      expect(ws).toMatchObject({ ownerUserId: founder, kind: 'persistent' });
      expect([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]).toContain(ws.status);
      const hr = await repo(HostedRunner).findOneByOrFail({ id: target.hostedRunnerId });
      expect(hr.desired).toMatchObject({ replicas: 0 });
      expect(hr.desired.teardownRequested).toBeFalsy();
      // The hosted runner is not deregistered with the leaver's own machines.
      expect(await repo(Runner).findOneBy({ id: ws.runnerId })).toMatchObject({ kind: 'hosted', ownerUserId: founder });
      await expect(modelTokens.authenticate(podToken)).rejects.toThrow(/not valid/);
      expect((await repo(HostedModelToken).findOneByOrFail({ hostedRunnerId: target.hostedRunnerId })).revokedReason).toBe('owner_left');

      await processor.reconcile(target.hostedRunnerId);
      await processor.reconcile(target.hostedRunnerId);
      expect((await repo(HostedRunner).findOneByOrFail({ id: target.hostedRunnerId })).state).toBe('suspended');
      expect(stub.pods.get(target.hostedRunnerId)).toMatchObject({ volume: true });
      expect(stub.calls).not.toContain(`teardown:${target.hostedRunnerId}:delete`);
    });

    it('gives the receiver both workspaces when they already had one there: the leaver\'s read-only, with the normal retention and notice', async () => {
      const org2 = await org('both');
      const boss = await member(org2, 'boss', OrganizationRole.OWNER, new Date('2023-01-01'));
      const gone = await member(org2, 'gone', OrganizationRole.MEMBER, new Date('2024-01-01'));
      const shared = await environment(org2, boss, { visibility: 'org' });
      const own = await hosted.resolveTarget(shared.id, { organizationId: org2, callerUserId: boss });
      const theirs = await hosted.resolveTarget(shared.id, { organizationId: org2, callerUserId: gone });
      notifications.emit.mockClear();

      await orgs.removeMember(org2, gone, boss);

      const kept = await repo(Workspace).findOneByOrFail({ id: theirs.workspaceId });
      expect(kept).toMatchObject({ ownerUserId: boss, readOnly: true, inheritedFromUserId: gone, expiryNoticeAt: null });
      expect([WorkspaceStatus.ACTIVE, WorkspaceStatus.SUSPENDED]).toContain(kept.status);
      expect((await repo(Workspace).findOneByOrFail({ id: own.workspaceId })).readOnly).toBe(false);
      const [transfer] = await repo(AuditLog).findBy({ organizationId: org2, action: AuditAction.OWNERSHIP_TRANSFER, resourceType: AuditResource.HOSTED_RUNNER, resourceId: theirs.hostedRunnerId });
      expect(transfer.details).toMatchObject({ readOnly: true, toUserId: boss, filesKept: true });
      expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'environments.handed_over', userIds: [boss], email: expect.objectContaining({ params: expect.objectContaining({ readOnlyKept: 1 }) }) }));

      // The boss's calls go to their own workspace; one that names the kept
      // one works there, and its pod mounts the volume read-only.
      expect((await hosted.resolveTarget(shared.id, { organizationId: org2, callerUserId: boss })).workspaceId).toBe(own.workspaceId);
      expect((await hosted.resolveTarget(shared.id, { organizationId: org2, callerUserId: boss, workspaceId: theirs.workspaceId })).workspaceId).toBe(theirs.workspaceId);
      const hr = await repo(HostedRunner).findOneByOrFail({ id: theirs.hostedRunnerId });
      const req = await processor.provisionRequest(hr, shared, kept);
      expect(req.readOnlyWorkspace).toBe(true);
      const mount = buildDeployment(req, settings.current.cluster, 1).spec.template.spec.containers[0].volumeMounts.find((m: any) => m.name === 'workspace');
      expect(mount).toMatchObject({ readOnly: true });
      // Nobody else can name it.
      const other = await member(org2, 'other', OrganizationRole.MEMBER);
      const theirsNow = await hosted.resolveTarget(shared.id, { organizationId: org2, callerUserId: other, workspaceId: theirs.workspaceId });
      expect(theirsNow.workspaceId).not.toBe(theirs.workspaceId);

      // Unused, it gets the notice on the notice day, to the boss, and then expires.
      const day = settings.minutes(24 * 60);
      await repo(Workspace).update({ id: kept.id }, { status: WorkspaceStatus.SUSPENDED, lastActiveAt: new Date(Date.now() - (settings.current.suspendedRetention.noticeDay + 1) * day) });
      notifications.emit.mockClear();
      await hosted.sweepSuspended(new Date());
      expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'environments.workspace_expiring', userIds: [boss] }));
      await repo(Workspace).update({ id: kept.id }, { lastActiveAt: new Date(Date.now() - (settings.current.suspendedRetention.keepDays + 1) * day) });
      await hosted.sweepSuspended(new Date());
      expect((await repo(Workspace).findOneByOrFail({ id: kept.id })).status).toBe(WorkspaceStatus.EXPIRED);
    });

    it('falls back to the longest-standing admin when no other owner is left to receive', async () => {
      const lone = await org('lone');
      const soleOwner = await member(lone, 'sole', OrganizationRole.OWNER, new Date('2022-01-01'));
      const firstAdmin = await member(lone, 'first-admin', OrganizationRole.ADMIN, new Date('2023-01-01'));
      await member(lone, 'later-admin', OrganizationRole.ADMIN, new Date('2024-01-01'));
      const handover = new EnvironmentHandoverService(audit, hosted);
      expect(await ds.transaction((m) => handover.receiverFor(m, lone, soleOwner))).toBe(firstAdmin);
    });
  });

  describe('a team is deleted', () => {
    it('makes environments shared with it private to their owner, audited, and tells the owner', async () => {
      const organizationId = await org('team');
      const owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      const sharer = await member(organizationId, 'sharer', OrganizationRole.MEMBER);
      const team = await repo(Team).save(repo(Team).create({ name: 'Platform', organizationId, isActive: true, isDefault: false }));
      const env = await environment(organizationId, sharer, { visibility: 'team', teamId: team.id });
      notifications.emit.mockClear();

      await orgs.deleteTeam(organizationId, team.id, owner);

      expect(await repo(Environment).findOneByOrFail({ id: env.id })).toMatchObject({ visibility: 'private', teamId: null, ownerUserId: sharer });
      const envTools = (await repo(Tool).find({ where: { organizationId } })).filter((t: any) => t.runnerConfig?.environmentId === env.id);
      expect(envTools.length).toBeGreaterThan(0);
      for (const t of envTools) expect(t).toMatchObject({ visibility: 'private', teamId: null, createdBy: sharer });
      const changes = await repo(AuditLog).findBy({ organizationId, action: AuditAction.VISIBILITY_CHANGE, resourceType: AuditResource.ENVIRONMENT, resourceId: env.id });
      expect(changes).toHaveLength(1);
      expect(changes[0].details).toMatchObject({ reason: 'team_deleted', teamName: 'Platform', ownerUserId: sharer });
      expect(notifications.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'environments.unshared', userIds: [sharer] }));
    });

    it('does the same on a delete that bypasses the service (the trigger)', async () => {
      const organizationId = await org('raw');
      const owner = await member(organizationId, 'owner', OrganizationRole.OWNER);
      const team = await repo(Team).save(repo(Team).create({ name: 'Raw', organizationId, isActive: true, isDefault: false }));
      const env = await environment(organizationId, owner, { visibility: 'team', teamId: team.id });
      await ds.query(`DELETE FROM teams WHERE id = $1`, [team.id]);
      expect(await repo(Environment).findOneByOrFail({ id: env.id })).toMatchObject({ visibility: 'private', teamId: null, ownerUserId: owner });
    });
  });

  describe('usage records are kept for the retention window', () => {
    function sweep(): RetentionSweepService {
      return new RetentionSweepService(
        repo(RetentionPolicy), repo(AgentRun), {} as any, {} as any, {} as any, {} as any, repo(AuditLog), undefined as any, undefined as any,
        audit, undefined, undefined, undefined, undefined, repo(RunnerUsageInterval), settings,
      );
    }
    const day = 24 * 60 * 60 * 1000;
    const monthsAgo = (n: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return d; };

    async function interval(organizationId: string, startedAt: Date, endedAt: Date | null): Promise<string> {
      const [row] = await ds.query(
        `INSERT INTO runner_usage_intervals ("organizationId", "hostedRunnerId", "environmentId", "workspaceId", "resourceClass", "startedAt", "endedAt")
         VALUES ($1, $2, $3, $4, 'small', $5, $6) RETURNING id`,
        [organizationId, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), startedAt, endedAt],
      );
      return row.id;
    }
    const exists = async (id: string) => (await repo(RunnerUsageInterval).countBy({ id })) === 1;

    it('keeps 13 months by default, the policy period where one is set, and never an open interval', async () => {
      const noPolicy = await org('ret-default');
      const old = await interval(noPolicy, monthsAgo(15), monthsAgo(14));
      const recent = await interval(noPolicy, monthsAgo(13), monthsAgo(12));
      const open = await interval(noPolicy, monthsAgo(20), null);

      const short = await org('ret-policy');
      await repo(RetentionPolicy).save(repo(RetentionPolicy).create({ organizationId: short, enabled: true, runnerUsageDays: 30 }));
      const pastPolicy = await interval(short, new Date(Date.now() - 41 * day), new Date(Date.now() - 40 * day));
      const withinPolicy = await interval(short, new Date(Date.now() - 11 * day), new Date(Date.now() - 10 * day));
      const openToo = await interval(short, new Date(Date.now() - 400 * day), null);

      // A disabled policy is not swept by its own numbers: the install default applies.
      const disabled = await org('ret-disabled');
      await repo(RetentionPolicy).save(repo(RetentionPolicy).create({ organizationId: disabled, enabled: false, runnerUsageDays: 30 }));
      const keptByDefault = await interval(disabled, new Date(Date.now() - 41 * day), new Date(Date.now() - 40 * day));

      const deleted = await sweep().sweepRunnerUsage(new Date());

      expect(await exists(old)).toBe(false);
      expect(await exists(recent)).toBe(true);
      expect(await exists(open)).toBe(true);
      expect(await exists(pastPolicy)).toBe(false);
      expect(await exists(withinPolicy)).toBe(true);
      expect(await exists(openToo)).toBe(true);
      expect(await exists(keptByDefault)).toBe(true);
      expect(deleted.get(noPolicy)).toBe(1);
      expect(deleted.get(short)).toBe(1);
      expect(deleted.has(disabled)).toBe(false);

      const [entry] = await repo(AuditLog).findBy({ organizationId: short, action: AuditAction.RETENTION_SWEEP });
      expect(entry.details).toMatchObject({ runnerUsageIntervals: 1, source: 'policy' });
    });

    it('keeps pods\' model calls for the same window', async () => {
      const orgId = await org('ret-calls');
      const call = async (createdAt: Date) => {
        const [row] = await ds.query(
          `INSERT INTO hosted_model_calls ("organizationId", "hostedRunnerId", "environmentId", "workspaceId", "vendorModelId", protocol, status, "createdAt")
           VALUES ($1, $2, $3, $4, 'claude-sonnet-4-5', 'anthropic_messages', 200, $5) RETURNING id`,
          [orgId, crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), createdAt],
        );
        return row.id as string;
      };
      const old = await call(monthsAgo(14));
      const recent = await call(monthsAgo(12));
      await sweep().sweepRunnerUsage(new Date());
      expect(await repo(HostedModelCall).countBy({ id: old })).toBe(0);
      expect(await repo(HostedModelCall).countBy({ id: recent })).toBe(1);
      const [entry] = await repo(AuditLog).findBy({ organizationId: orgId, action: AuditAction.RETENTION_SWEEP });
      expect(entry.details).toMatchObject({ hostedModelCalls: 1, source: 'install_default' });
    });
  });
});
