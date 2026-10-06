import { randomUUID } from 'crypto';
import { BadRequestException } from '@nestjs/common';

import {
  actingUserId,
  agentPrincipal,
  asPrincipal,
  isExecutionPrincipal,
  principalOfRun,
} from '../../../common/authorization/execution-access.service';
import { runWithRequestContext } from '../../../common/request-context';
import { AgentStatus } from '../../../entities/agent.entity';
import { ConnectionGrant } from '../../../entities/connection-grant.entity';
import { Credential } from '../../../entities/credential.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { GrantsService } from '../../connections/grants/grants.service';
import { GrantsUsePolicy } from '../../connections/grants/grants-use.policy';
import { fakeAudit, fakeRepo } from '../../connections/__tests__/test-support';
import { EE_ENTITLEMENTS } from '../../licensing/license.constants';
import { usableProviders } from '../../llm-providers/private-provider';
import {
  AGENT_IDENTITY_NOT_INCLUDED,
  AgentIdentityService,
  runAsProblems,
  runUserOf,
  unattendedPrincipal,
} from '../agent-identity';
import { AgentSchedulerService } from '../agent-scheduler.service';
import { membershipFixture } from '../../../test/execution-access.fixture';
import { fakeRepository } from '../../../test/fake-repository';

/**
 * An agent that acts as itself (agent_identity, decision 11 of the
 * hosted-runners and always-on design): its own execution principal, the
 * connections granted to it and no one else's, and its own audit actor.
 */
const ORG = 'org-1';
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TEAM = '33333333-3333-4333-8333-333333333333';
const OTHER_TEAM = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const OTHER_AGENT = '66666666-6666-4666-8666-666666666666';

const orgAgent = { id: AGENT, organizationId: ORG, visibility: 'org' as const, teamId: null, createdBy: OWNER };
const teamAgent = { ...orgAgent, visibility: 'team' as const, teamId: TEAM };
const privateAgent = { ...orgAgent, visibility: 'private' as const };

describe('the agent execution principal', () => {
  const access = () => membershipFixture().executionAccess;

  it('may run the agent itself, and org-wide resources of its organization', async () => {
    const p = agentPrincipal(privateAgent);
    expect((await access().canExecute(p, { id: AGENT, ...privateAgent } as any)).allowed).toBe(true);
    expect((await access().canExecute(p, { organizationId: ORG, visibility: 'org' })).allowed).toBe(true);
    expect((await access().canExecute(p, { organizationId: 'org-2', visibility: 'org' })).allowed).toBe(false);
  });

  it('reaches a team resource only from its own team', async () => {
    expect((await access().canExecute(agentPrincipal(teamAgent), { organizationId: ORG, visibility: 'team', teamId: TEAM })).allowed).toBe(true);
    expect((await access().canExecute(agentPrincipal(teamAgent), { organizationId: ORG, visibility: 'team', teamId: OTHER_TEAM })).allowed).toBe(false);
    // An org-wide agent is no team's, whoever owns it.
    expect((await access().canExecute(agentPrincipal(orgAgent), { organizationId: ORG, visibility: 'team', teamId: TEAM })).allowed).toBe(false);
  });

  it('reaches a private resource only when the agent is private to the same owner', async () => {
    const mine = { organizationId: ORG, visibility: 'private' as const, ownerUserId: OWNER };
    expect((await access().canExecute(agentPrincipal(privateAgent), mine)).allowed).toBe(true);
    expect((await access().canExecute(agentPrincipal(orgAgent), mine)).allowed).toBe(false);
    expect((await access().canExecute(agentPrincipal(privateAgent), { ...mine, ownerUserId: OTHER })).allowed).toBe(false);
  });

  it('is never a person: no acting user, not even its owner', () => {
    expect(actingUserId(agentPrincipal(privateAgent))).toBeNull();
    expect(runUserOf(agentPrincipal(privateAgent))).toBeNull();
  });

  it('round-trips through a stored run and the ActingAs seam', () => {
    const stored = JSON.parse(JSON.stringify(agentPrincipal(teamAgent)));
    expect(isExecutionPrincipal(stored)).toBe(true);
    expect(principalOfRun({ principal: stored, userId: OWNER })).toEqual(agentPrincipal(teamAgent));
    expect(asPrincipal(stored)).toEqual(agentPrincipal(teamAgent));
  });

  it("is offered the organization's and its team's model providers, never a private one", async () => {
    const rows = [
      { id: 'org', organizationId: ORG, visibility: 'org', ownerUserId: null },
      { id: 'team', organizationId: ORG, visibility: 'team', teamId: TEAM, ownerUserId: null },
      { id: 'other-team', organizationId: ORG, visibility: 'team', teamId: OTHER_TEAM, ownerUserId: null },
      { id: 'owners-own', organizationId: ORG, visibility: 'private', ownerUserId: OWNER },
    ] as any[];
    const ids = (await usableProviders(null, ORG, agentPrincipal(teamAgent), rows)).map((p) => p.id);
    expect(ids).toEqual(['org', 'team']);
  });
});

describe('connections an agent acting as itself may use', () => {
  function harness() {
    const grants = fakeRepo<ConnectionGrant>(() => new ConnectionGrant());
    const credentials = fakeRepo<Credential>(() => new Credential());
    const service = new GrantsService(
      grants as any, credentials as any, fakeRepo<any>() as any, fakeRepo<any>() as any, fakeRepo<any>() as any,
      fakeRepo<any>() as any, fakeRepo<any>() as any, fakeRepo<any>() as any, fakeAudit(),
    );
    const policy = new GrantsUsePolicy(service);
    const connection = (over: Partial<Credential>) => {
      const row = Object.assign(new Credential(), { id: randomUUID(), organizationId: ORG, connectorKey: 'openai', visibility: 'org', teamId: null, ownerUserId: null, metadata: null, ...over });
      credentials.rows.push(row);
      return row;
    };
    const grant = (connectionId: string, principalType: string, principalId: string) =>
      grants.rows.push(Object.assign(new ConnectionGrant(), { id: randomUUID(), organizationId: ORG, connectionId, principalType, principalId, permission: 'use' }) as any);
    const use = (credential: Credential, agent: typeof orgAgent | typeof privateAgent = orgAgent, context: Record<string, any> = { purpose: 'llm_call' }) =>
      policy.assertCanUse({ organizationId: ORG, credential: credential as any, execution: agentPrincipal(agent), context: context as any });
    return { connection, grant, use };
  }

  it('uses an organization connection granted to it', async () => {
    const h = harness();
    const conn = h.connection({});
    h.grant(conn.id, 'agent', AGENT);
    await expect(h.use(conn)).resolves.toMatchObject({ allowed: true, via: 'grant' });
  });

  it('cannot use an organization connection nobody granted it', async () => {
    const h = harness();
    const conn = h.connection({});
    h.grant(conn.id, 'agent', OTHER_AGENT);
    await expect(h.use(conn)).rejects.toMatchObject({ code: 'CONNECTION_NOT_GRANTED' });
  });

  it('cannot borrow another agent\'s grant by naming that agent in the call', async () => {
    const h = harness();
    const conn = h.connection({});
    h.grant(conn.id, 'agent', OTHER_AGENT);
    await expect(h.use(conn, orgAgent, { purpose: 'llm_call', resourceType: 'agent', resourceId: OTHER_AGENT })).rejects.toMatchObject({ code: 'CONNECTION_NOT_GRANTED' });
  });

  it("never reaches its owner's personal or private connections", async () => {
    const h = harness();
    const personal = h.connection({ ownerUserId: OWNER });
    const privateConn = h.connection({ ownerUserId: OWNER, visibility: 'private' });
    await expect(h.use(personal)).rejects.toMatchObject({ code: 'CONNECTION_NOT_GRANTED' });
    await expect(h.use(privateConn, privateAgent)).rejects.toThrow();
  });
});

describe('the audit actor', () => {
  function service() {
    const rows: any[] = [];
    const repo = { create: (r: any) => r, save: async (r: any) => (rows.push(r), r) };
    return { audit: new AuditLogService(repo as any, { findOne: async () => null } as any), rows };
  }
  const entry = { organizationId: ORG, action: AuditAction.RUN_START, resourceType: AuditResource.AGENT, resourceId: AGENT };

  it('names the agent on rows written inside a run that acts as itself', async () => {
    const { audit, rows } = service();
    await runWithRequestContext({ actor: { kind: 'agent', agentId: AGENT } }, () => audit.log({ ...entry, details: { runId: 'r-1' } }));
    expect(rows[0].details).toEqual({ runId: 'r-1', actor: { kind: 'agent', agentId: AGENT } });
    expect(rows[0].userId).toBeUndefined();
  });

  it('leaves rows outside such a run as they were', async () => {
    const { audit, rows } = service();
    await runWithRequestContext({ actor: null }, () => audit.log({ ...entry, userId: OWNER, details: { runId: 'r-1' } }));
    expect(rows[0].details).toEqual({ runId: 'r-1' });
  });
});

describe('who an unattended run acts as', () => {
  const runsAsItself = { ...orgAgent, agentConfig: { runAs: 'agent' as const } };

  it('is the agent itself only when it asks to and the organization has the entitlement', () => {
    expect(unattendedPrincipal(runsAsItself, true, 'schedule')).toEqual(agentPrincipal(orgAgent));
    expect(unattendedPrincipal(runsAsItself, false, 'schedule')).toEqual({ kind: 'user', userId: OWNER, source: 'schedule' });
    expect(unattendedPrincipal(orgAgent, true, 'schedule')).toEqual({ kind: 'user', userId: OWNER, source: 'schedule' });
  });

  it('accepts only owner or agent as a setting', () => {
    expect(runAsProblems({ runAs: 'agent' })).toEqual([]);
    expect(runAsProblems({ runAs: 'owner' })).toEqual([]);
    expect(runAsProblems({ runAs: 'admin' })).toHaveLength(1);
  });

  it('refuses turning it on without agent_identity, and lets an agent saved before a downgrade be edited', async () => {
    const licenses = { hasForOrg: jest.fn(async () => false) };
    const identity = new AgentIdentityService(licenses as any);
    await expect(identity.assertMaySave(ORG, { runAs: 'agent' })).rejects.toThrow(new BadRequestException(AGENT_IDENTITY_NOT_INCLUDED));
    await expect(identity.assertMaySave(ORG, { runAs: 'agent' }, { runAs: 'agent' })).resolves.toBeUndefined();
    await expect(identity.assertMaySave(ORG, { runAs: 'owner' })).resolves.toBeUndefined();
    expect(licenses.hasForOrg).toHaveBeenCalledWith(ORG, EE_ENTITLEMENTS.AGENT_IDENTITY);
    licenses.hasForOrg.mockResolvedValue(true);
    await expect(identity.assertMaySave(ORG, { runAs: 'agent' })).resolves.toBeUndefined();
  });

  it('fails closed with no licensing wired', async () => {
    await expect(new AgentIdentityService().assertMaySave(ORG, { runAs: 'agent' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('a scheduled run of an agent that acts as itself', () => {
  function build(agent: Record<string, any>, licensed: boolean) {
    const execute = jest.fn(async () => ({ nodeResults: [] }));
    const users = fakeRepository<any>([
      { id: OWNER, isActive: true, organizationMemberships: [{ organizationId: ORG, role: 'member', isActive: true }] },
    ]);
    const m = membershipFixture();
    m.member(ORG, OWNER);
    const identity = new AgentIdentityService({ hasForOrg: async () => licensed } as any);
    const scheduler = new AgentSchedulerService(
      {} as any, { execute } as any, fakeRepository<any>([agent]) as any, {} as any, m.executionAccess,
      fakeRepository<any>([]) as any, users as any, undefined, undefined, undefined, undefined, undefined, identity,
    );
    return { scheduler, execute };
  }
  const agent = {
    ...orgAgent,
    status: AgentStatus.ACTIVE,
    settings: { schedule: { enabled: true, intervalMinutes: 60 } },
    agentConfig: { runAs: 'agent' },
  };

  it('runs as the agent, with no user, when the organization has agent_identity', async () => {
    const { scheduler, execute } = build(agent, true);
    await scheduler.handleScheduledExecution({ data: { agentId: AGENT, organizationId: ORG, input: {} } } as any);
    const call = execute.mock.calls[0] as any[];
    expect(call[2]).toBeNull();
    expect(call[3].principal).toEqual(agentPrincipal(orgAgent));
  });

  it('runs as its owner without the entitlement', async () => {
    const { scheduler, execute } = build(agent, false);
    await scheduler.handleScheduledExecution({ data: { agentId: AGENT, organizationId: ORG, input: {} } } as any);
    const call = execute.mock.calls[0] as any[];
    expect(call[2]).toBe(OWNER);
    expect(call[3].principal).toEqual({ kind: 'user', userId: OWNER, source: 'schedule' });
  });
});
