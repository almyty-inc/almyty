/**
 * Real-Postgres spec for the notices sent when models appear on a provider
 * connection or stop being usable (model-catalog/notices).
 *
 * What has to hold, against the real tables and the real notification
 * pipeline (only the mail transport and the vendor listing are doubles):
 *
 *  - the first import of a connection's list is not news; a model listed
 *    later is, once;
 *  - a model an agent uses that goes away is mailed at once, one email per
 *    person, to the connection's owner, the org's owners and admins and
 *    the agent's owner; a model nobody uses waits for the daily digest;
 *  - the in-app notice always arrives; the email follows each person's own
 *    setting;
 *  - a provider that drops a model and lists it again does not mail anyone
 *    twice in a day;
 *  - the digest sends one email per person, once, at 08:00 in that
 *    person's own time zone;
 *  - a new model a connection does not offer (new models not allowed
 *    automatically) is still announced, marked as not allowed there;
 *  - removing a connection agents use tells them like any lost model;
 *  - a private connection's changes reach its owner and nobody else;
 *  - the agent's banner names the model, the connection and why, and
 *    clears once the model is back.
 *
 * Gated behind RUN_DB_INTEGRATION=1 with the standard DATABASE_* env vars.
 */
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { User } from '../../entities/user.entity';
import { OrganizationRole, UserOrganization } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../entities/llm-provider.entity';
import { Model } from '../../entities/model.entity';
import { ModelVersion } from '../../entities/model-version.entity';
import { ModelDeployment } from '../../entities/model-deployment.entity';
import { ModelChangeEvent } from '../../entities/model-change-event.entity';
import { Agent } from '../../entities/agent.entity';
import { AgentRole } from '../../entities/agent-role.entity';
import { Notification } from '../../entities/notification.entity';
import { NotificationPreference } from '../../entities/notification-preference.entity';
import { ModelCatalogService } from '../../modules/model-catalog/model-catalog.service';
import { ModelRouterService } from '../../modules/model-catalog/routing/model-router.service';
import { ModelChangeNoticesService, UNAVAILABLE_NOTICE_WINDOW_MS } from '../../modules/model-catalog/notices/model-change-notices.service';
import { ModelUsageService } from '../../modules/model-catalog/notices/model-usage.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { ensureSchema } from './isolated-schema.helper';

const SHOULD_RUN = process.env.RUN_DB_INTEGRATION === '1';
const describeIfDb = SHOULD_RUN ? describe : describe.skip;
const SCHEMA = 'model_change_notices_test';

jest.setTimeout(120_000);

const connection = {
  type: 'postgres' as const,
  host: process.env.DATABASE_HOST || 'localhost',
  port: Number(process.env.DATABASE_PORT || 5432),
  username: process.env.DATABASE_USERNAME || 'postgres',
  password: process.env.DATABASE_PASSWORD || 'password',
  database: process.env.DATABASE_NAME || 'almyty_test',
};

describeIfDb('model change notices (real Postgres)', () => {
  let ds: DataSource;
  let orgId: string;
  let catalog: ModelCatalogService;
  let notices: ModelChangeNoticesService;
  let notifications: NotificationsService;
  let usage: ModelUsageService;
  const mail = { sendTemplate: jest.fn(async (..._args: any[]) => true) };
  const users: Record<'owner' | 'admin' | 'connOwner' | 'agentOwner' | 'bystander', string> = {} as any;
  let listed: string[] = [];
  let seq = 0;

  const repo = <T extends ObjectLiteral>(entity: EntityTarget<T>) => ds.getRepository(entity);
  const save = async <T extends ObjectLiteral>(entity: EntityTarget<T>, data: Record<string, unknown>): Promise<T> =>
    (await repo(entity).save(repo(entity).create(data as any) as any)) as T;

  const person = async (role: OrganizationRole) => {
    const user = await save(User, { email: `p${++seq}@notices.test`, passwordHash: 'x', firstName: `P${seq}`, lastName: 'T' });
    await save(UserOrganization, { userId: (user as any).id, organizationId: orgId, role, isActive: true, inviteAccepted: true, joinedAt: new Date() });
    return (user as any).id as string;
  };
  const connect = async (name: string, fields: Partial<LlmProvider> = {}) => {
    const row = await save(LlmProvider, {
      name,
      type: LlmProviderType.OPENAI,
      status: LlmProviderStatus.ACTIVE,
      organizationId: orgId,
      configuration: {},
      isHealthy: true,
      lastHealthCheckAt: new Date(),
      ownerUserId: users.connOwner,
      ...fields,
    });
    return row as LlmProvider;
  };
  const emailOf = async (userId: string) => (await repo(User).findOneByOrFail({ id: userId })).email;
  const sentTo = async (template: string) => {
    const byEmail = new Map<string, number>();
    for (const call of mail.sendTemplate.mock.calls) if (call[1] === template) byEmail.set(call[0], (byEmail.get(call[0]) ?? 0) + 1);
    const out: Record<string, number> = {};
    for (const [key, id] of Object.entries(users)) {
      const n = byEmail.get(await emailOf(id));
      if (n) out[key] = n;
    }
    return out;
  };
  const bells = async (type: string) => {
    const rows = await repo(Notification).find({ where: { organizationId: orgId, type } });
    const out: Record<string, number> = {};
    for (const [key, id] of Object.entries(users)) {
      const n = rows.filter((r) => r.userId === id).length;
      if (n) out[key] = n;
    }
    return out;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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

    const policy = new AccessPolicyService(repo(UserOrganization), repo(UserTeam));
    notifications = new NotificationsService(repo(Notification), repo(NotificationPreference), repo(User), repo(UserOrganization), repo(UserTeam), mail as any);
    usage = new ModelUsageService(repo(Agent), repo(AgentRole), repo(Model), policy);
    notices = new ModelChangeNoticesService(
      repo(ModelChangeEvent), repo(LlmProvider), repo(Model), repo(Agent), repo(AgentRole), repo(User), repo(UserOrganization),
      ds, usage, notifications, mail as any, policy,
    );
    const listing = { fetchModelsFromProvider: async () => listed.map((id) => ({ id, name: id })) };
    const router = new ModelRouterService(repo(Model), repo(LlmProvider), repo(ModelDeployment), undefined, undefined, policy, notices);
    catalog = new ModelCatalogService(repo(Model), repo(ModelVersion), repo(LlmProvider), router, {} as any, listing as any, undefined, undefined, undefined, policy, notices);

    orgId = ((await save(Organization, { name: 'notices', slug: `notices-${Date.now()}`, plan: 'free', isActive: true })) as any).id;
    users.owner = await person(OrganizationRole.OWNER);
    users.admin = await person(OrganizationRole.ADMIN);
    users.connOwner = await person(OrganizationRole.MEMBER);
    users.agentOwner = await person(OrganizationRole.MEMBER);
    users.bystander = await person(OrganizationRole.MEMBER);
    // 08:00 falls at 06:00 UTC for the owner, 08:00 UTC for the connection's
    // owner (no time zone set: UTC) and 12:00 UTC for the admin. Fixed
    // offsets, so the test does not move with daylight saving.
    await repo(User).update({ id: users.owner }, { timezone: 'Etc/GMT-2' });
    await repo(User).update({ id: users.admin }, { timezone: 'Etc/GMT+4' });
  });

  /** The next time it is `hour`:00 UTC, within a day of now. */
  const nextUtc = (hour: number, minute = 0) => {
    const at = new Date();
    at.setUTCHours(hour, minute, 0, 0);
    if (at.getTime() <= Date.now()) at.setUTCDate(at.getUTCDate() + 1);
    return at;
  };

  afterAll(async () => {
    if (ds?.isInitialized) await ds.destroy();
  });

  let conn: LlmProvider;
  let agent: Agent;

  it('the first import of a connection is not news; a model listed later is, in the app at once and by email only in the digest', async () => {
    conn = await connect('OpenAI - main');
    listed = ['m-used', 'm-unused'];
    await catalog.syncFromProvider(orgId, conn.id);
    expect(await repo(ModelChangeEvent).count()).toBe(0);
    agent = (await save(Agent, {
      name: 'Support bot',
      organizationId: orgId,
      pipeline: { nodes: [], edges: [] },
      createdBy: users.agentOwner,
      modelConfig: { providerId: conn.id, model: 'm-used' },
    })) as Agent;

    listed = ['m-used', 'm-unused', 'm-new'];
    await catalog.syncFromProvider(orgId, conn.id);
    await settle();
    expect(await bells('models.new')).toEqual({ owner: 1, admin: 1, connOwner: 1 });
    expect(await sentTo('models.new')).toEqual({});
    expect(await sentTo('models.digest')).toEqual({});
    // Listed again: not new a second time.
    await catalog.syncFromProvider(orgId, conn.id);
    expect(await repo(ModelChangeEvent).count({ where: { kind: 'new' } })).toBe(1);
  });

  it('a model an agent uses that goes away is mailed at once, once per person, and the email follows each person\'s setting', async () => {
    await notifications.updatePreferences(users.admin, { 'models.unavailable': { email: false, inApp: false } });
    mail.sendTemplate.mockClear();
    listed = ['m-new'];
    await catalog.syncFromProvider(orgId, conn.id);
    await settle();
    // In the app: everyone concerned, one notice each, the admin included
    // (in-app cannot be turned off), and not the bystander.
    expect(await bells('models.unavailable')).toEqual({ owner: 1, admin: 1, connOwner: 1, agentOwner: 1 });
    // By email at once: everyone but the admin, who turned it off.
    expect(await sentTo('models.unavailable')).toEqual({ owner: 1, connOwner: 1, agentOwner: 1 });
    // Only the model the agent uses is in the immediate email.
    const params = mail.sendTemplate.mock.calls.filter((c) => c[1] === 'models.unavailable').map((c) => c[2]);
    for (const p of params) expect(p.models.map((m: any) => m.name)).toEqual(['m-used']);
    // The agent is named to its owner only.
    const agentOwnerEmail = await emailOf(users.agentOwner);
    const ownerEmail = await emailOf(users.owner);
    expect(mail.sendTemplate.mock.calls.find((c) => c[0] === agentOwnerEmail)![2].yourAgents).toEqual([{ name: 'Support bot', url: expect.stringContaining(`/agents/${agent.id}`) }]);
    expect(mail.sendTemplate.mock.calls.find((c) => c[0] === ownerEmail)![2]).toMatchObject({ yourAgents: [], otherAgents: 1 });
    const rows = await repo(ModelChangeEvent).find({ where: { kind: 'unavailable' } });
    expect(rows.find((r) => r.vendorModelId === 'm-used')).toMatchObject({ agentIds: [agent.id], notifiedAt: expect.any(Date) });
    expect(rows.find((r) => r.vendorModelId === 'm-unused')).toMatchObject({ agentIds: [], notifiedAt: null });
  });

  it('the agent\'s banner says which model, from which connection, and why; it clears when the model is back', async () => {
    const issues = await notices.agentModelIssues(orgId, agent.id, users.agentOwner);
    expect(issues).toEqual([expect.objectContaining({ model: 'm-used', connectionName: 'OpenAI - main', reason: 'The provider no longer lists it.', where: ['model'] })]);
    await expect(notices.agentModelIssues(orgId, agent.id, 'b6d1a2c0-0000-4000-8000-000000000000')).rejects.toThrow(/Agent not found/);
  });

  it('a provider that drops a model and lists it again does not mail anyone twice in a day', async () => {
    mail.sendTemplate.mockClear();
    const before = await repo(Notification).count({ where: { type: 'models.unavailable' } });
    listed = ['m-new', 'm-used', 'm-unused'];
    await catalog.syncFromProvider(orgId, conn.id);
    expect(await notices.agentModelIssues(orgId, agent.id, users.agentOwner)).toEqual([]);
    listed = ['m-new'];
    await catalog.syncFromProvider(orgId, conn.id);
    await settle();
    expect(mail.sendTemplate).not.toHaveBeenCalled();
    expect(await repo(Notification).count({ where: { type: 'models.unavailable' } })).toBe(before);
    expect(await repo(ModelChangeEvent).count({ where: { kind: 'unavailable' } })).toBe(2);

    // A day later the same drop is news again.
    await ds.query(`UPDATE "model_change_events" SET "createdAt" = "createdAt" - make_interval(secs => $1) WHERE "vendorModelId" = 'm-used'`, [UNAVAILABLE_NOTICE_WINDOW_MS / 1000 + 60]);
    listed = ['m-new', 'm-used'];
    await catalog.syncFromProvider(orgId, conn.id);
    listed = ['m-new'];
    await catalog.syncFromProvider(orgId, conn.id);
    await settle();
    expect(await sentTo('models.unavailable')).toEqual({ owner: 1, connOwner: 1, agentOwner: 1 });
  });

  it('the digest reaches each person at 08:00 their own time, once, with the rest, following their settings', async () => {
    const adminEmail = await emailOf(users.admin);
    const ownerEmail = await emailOf(users.owner);
    const byEmail = (email: string) => mail.sendTemplate.mock.calls.find((c) => c[1] === 'models.digest' && c[0] === email)![2];

    // 06:00 UTC is 08:00 for the owner only.
    mail.sendTemplate.mockClear();
    const sixUtc = nextUtc(6);
    expect((await notices.sendDigest(sixUtc)).emails).toBe(1);
    await settle();
    expect(await sentTo('models.digest')).toEqual({ owner: 1 });
    expect(byEmail(ownerEmail)).toMatchObject({ fresh: [expect.objectContaining({ models: 'm-new', count: 1, notOfferedCount: 0 })], gone: [expect.objectContaining({ models: 'm-unused' })] });

    // Later that hour, or on another instance: not twice.
    mail.sendTemplate.mockClear();
    expect((await notices.sendDigest(new Date(sixUtc.getTime() + 30 * 60 * 1000))).emails).toBe(0);
    expect(mail.sendTemplate).not.toHaveBeenCalled();

    // 08:00 UTC: the connection's owner, who set no time zone.
    mail.sendTemplate.mockClear();
    await notices.sendDigest(new Date(sixUtc.getTime() + 2 * 60 * 60 * 1000));
    await settle();
    expect(await sentTo('models.digest')).toEqual({ connOwner: 1 });

    // 12:00 UTC: the admin, who turned unavailable-model emails off: new models only.
    mail.sendTemplate.mockClear();
    await notices.sendDigest(new Date(sixUtc.getTime() + 6 * 60 * 60 * 1000));
    await settle();
    expect(await sentTo('models.digest')).toEqual({ admin: 1 });
    expect(byEmail(adminEmail)).toMatchObject({ fresh: [expect.objectContaining({ connection: 'OpenAI - main', models: 'm-new' })], gone: [] });
  });

  it('a new model a connection does not offer is still announced, as not allowed there, so it can be ticked', async () => {
    const pinned = await connect('OpenAI - gpt-4o only', { allowNewModels: false, allowedModels: ['gpt-4o'] } as any);
    listed = ['gpt-4o'];
    await catalog.syncFromProvider(orgId, pinned.id);
    listed = ['gpt-4o', 'gpt-5'];
    await catalog.syncFromProvider(orgId, pinned.id);
    await settle();
    const row = await repo(ModelChangeEvent).findOneByOrFail({ providerId: pinned.id, vendorModelId: 'gpt-5' });
    expect(row).toMatchObject({ kind: 'new', offered: false });
    const bell = await repo(Notification).findOneByOrFail({ userId: users.connOwner, type: 'models.new', title: 'New model on OpenAI - gpt-4o only: gpt-5' });
    expect(bell.body).toContain('not allowed on OpenAI - gpt-4o only');
    expect(bell.link).toBe(`/credentials/providers/${pinned.id}`);
    // The catalog marks it new.
    expect((await notices.recentlyNew(orgId)).has(row.modelId!)).toBe(true);

    // In the owner's next digest, as not allowed there. (The digest above
    // ran at a time still ahead of now; start the owner's clock over.)
    await repo(User).update({ id: users.owner }, { modelDigestSentAt: null });
    mail.sendTemplate.mockClear();
    await notices.sendDigest(nextUtc(6));
    await settle();
    const digest = mail.sendTemplate.mock.calls.find((c) => c[1] === 'models.digest' && c[0] === 'p1@notices.test')?.[2];
    expect(digest?.fresh).toEqual(expect.arrayContaining([expect.objectContaining({ connection: 'OpenAI - gpt-4o only', count: 0, notOffered: 'gpt-5', notOfferedCount: 1 })]));
  });

  it('removing a connection an agent uses names the agent first, then tells everyone the models are gone', async () => {
    const doomed = await connect('Mistral - old');
    listed = ['mistral-large'];
    await catalog.syncFromProvider(orgId, doomed.id);
    const user = (await save(Agent, {
      name: 'Report writer',
      organizationId: orgId,
      pipeline: { nodes: [{ id: 'n1', type: 'llm_call', data: { label: 'Draft', providerId: doomed.id, model: 'mistral-large' } }], edges: [] },
      createdBy: users.agentOwner,
    })) as Agent;
    expect(await usage.agentsUsingConnection(orgId, doomed.id)).toEqual([user.id]);
    expect(await usage.forViewer(orgId, [user.id], users.agentOwner)).toEqual({ agents: [{ id: user.id, name: 'Report writer' }], others: 0 });

    mail.sendTemplate.mockClear();
    await catalog.retireProviderCards(orgId, doomed.id);
    await repo(LlmProvider).delete({ id: doomed.id });
    await settle();
    const row = await repo(ModelChangeEvent).findOneByOrFail({ providerId: doomed.id, vendorModelId: 'mistral-large' });
    expect(row).toMatchObject({ kind: 'unavailable', reason: 'Its connection was removed.', agentIds: [user.id] });
    const agentOwnerEmail = await emailOf(users.agentOwner);
    expect(mail.sendTemplate.mock.calls.find((c) => c[1] === 'models.unavailable' && c[0] === agentOwnerEmail)?.[2]).toMatchObject({ connectionName: 'Mistral - old' });
    const banner = await notices.agentModelIssues(orgId, user.id, users.agentOwner);
    expect(banner).toEqual([expect.objectContaining({ model: 'mistral-large', reason: 'Its connection was removed.', where: ['step Draft'] })]);
  });

  it('a refused key takes every model away, and a private connection tells its owner and nobody else', async () => {
    mail.sendTemplate.mockClear();
    const mine = await connect('My own OpenAI', { visibility: 'private', ownerUserId: users.bystander } as any);
    listed = ['p-1', 'p-2'];
    await catalog.syncFromProvider(orgId, mine.id);
    await catalog.applyProviderCheck(orgId, mine.id, { passed: false, keyRejected: true, error: '401' });
    await settle();
    const rows = await repo(ModelChangeEvent).find({ where: { providerId: mine.id } });
    expect(rows.map((r) => [r.vendorModelId, r.reason])).toEqual(
      expect.arrayContaining([['p-1', "The provider refused the connection's key."], ['p-2', "The provider refused the connection's key."]]),
    );
    const notes = await repo(Notification).find({ where: { type: 'models.unavailable' } });
    const aboutMine = notes.filter((n) => n.title.includes('My own OpenAI'));
    expect(aboutMine.map((n) => n.userId)).toEqual([users.bystander]);
  });
});
