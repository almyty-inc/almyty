import {
  memberConnectionSql,
  OWNED_RESOURCE_TABLES,
  ResourceHandoverHelper,
  TEAM_SCOPED_TABLES,
} from '../resource-handover.helper';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { Runner } from '../../../entities/runner.entity';
import { ConnectionOffboardingService } from '../../connections/connection-offboarding.service';

describe('ResourceHandoverHelper', () => {
  function build(
    updated: Record<string, Array<{ id: string; name: string }>>,
    privateRunners: any[] = [],
    extra: { connections?: any[]; connectionGrants?: any[]; userGrants?: any[] } = {},
  ) {
    const order: string[] = [];
    const manager: any = {
      // manager.query on UPDATE/DELETE ... RETURNING yields [rows, rowCount].
      query: jest.fn(async (sql: string) => {
        const del = /DELETE FROM (\w+)/.exec(sql);
        if (del) {
          const rows = /"principalType" = 'user'/.test(sql) ? extra.userGrants ?? [] : extra.connectionGrants ?? [];
          order.push(`delete ${del[1]}`);
          return [rows, rows.length];
        }
        const table = /UPDATE (\w+)/.exec(sql)![1];
        if (/"healthStatus" = 'revoked'/.test(sql)) {
          order.push('revoke connections');
          const rows = extra.connections ?? [];
          return [rows, rows.length];
        }
        order.push(`update ${table}`);
        const rows = updated[table] ?? [];
        return [rows, rows.length];
      }),
      getRepository: jest.fn((entity: any) => {
        if (entity !== Runner) throw new Error('unexpected repository');
        return { find: jest.fn(async () => privateRunners) };
      }),
    };
    const audit = {
      logInTransaction: jest.fn(async (_m: any, options: any) => ({ id: `audit-${options.resourceId}`, ...options })),
    };
    const runners = {
      deleteForDepartedOwner: jest.fn(async (runner: any) => { order.push(`delete runner ${runner.id}`); }),
    };
    const helper = new ResourceHandoverHelper(audit as any, runners as any, new ConnectionOffboardingService({} as any, {} as any, audit as any));
    return { helper, manager, audit, runners, order };
  }

  it('covers every table with a private tier, with its owner column', () => {
    expect(OWNED_RESOURCE_TABLES.map((t) => [t.table, t.ownerColumn])).toEqual([
      ['agents', 'createdBy'],
      ['tools', 'createdBy'],
      ['apis', 'ownerUserId'],
      ['gateways', 'ownerUserId'],
      ['llm_providers', 'ownerUserId'],
      ['credentials', 'ownerUserId'],
    ]);
    // The seven tables 1745340000000 gave a teamId FK.
    expect(TEAM_SCOPED_TABLES.map((t) => t.table).sort()).toEqual(
      ['agents', 'apis', 'credentials', 'gateways', 'llm_providers', 'runners', 'tools'],
    );
  });

  describe('handOverPrivateResources', () => {
    const args = {
      organizationId: 'org-1',
      fromUserId: 'leaver',
      toUserId: 'admin',
      actorUserId: 'admin',
      reason: 'member_removed' as const,
    };

    const transfers = (t: ReturnType<typeof build>) =>
      t.manager.query.mock.calls.filter(([sql]: [string]) => /SET "(createdBy|ownerUserId)" = \$1/.test(sql));

    it('moves only private rows of the leaver in this org, keeping them private', async () => {
      const t = build({});
      await t.helper.handOverPrivateResources(t.manager, args);

      // Every private-tier table, plus the approvals the leaver's private
      // agents asked for, which follow the agents.
      expect(transfers(t)).toHaveLength(OWNED_RESOURCE_TABLES.length + 1);
      expect(transfers(t).map(([sql]: [string]) => /UPDATE (\w+)/.exec(sql)![1])).toContain('approval_requests');
      for (const [sql, params] of transfers(t)) {
        expect(sql).toMatch(/WHERE "organizationId" = \$2 AND visibility = 'private' AND "(createdBy|ownerUserId)" = \$3/);
        expect(sql).not.toMatch(/SET[^W]*visibility/);
        expect(params).toEqual(['admin', 'org-1', 'leaver']);
      }
      // The member's own connections are revoked, not handed over.
      const [credentialsSql] = transfers(t).find(([sql]: [string]) => /UPDATE credentials/.test(sql))!;
      expect(credentialsSql).toContain(`AND NOT ${memberConnectionSql()}`);
    });

    it('deregisters every runner of the leaver, whatever its visibility, then audits one row per moved resource', async () => {
      const runner = { id: 'runner-1', name: 'leaver-mac', visibility: 'private', teamId: null };
      const shared = { id: 'runner-2', name: 'team-box', visibility: 'team', teamId: 'team-1' };
      const t = build(
        { agents: [{ id: 'a-1', name: 'Agent' }], credentials: [{ id: 'c-1', name: 'Key' }] },
        [runner, shared],
      );

      const rows = await t.helper.handOverPrivateResources(t.manager, args);

      // Runner tools are the leaver's tools: they go with the runner
      // instead of being handed over.
      expect(t.order.slice(0, 2)).toEqual(['delete runner runner-1', 'delete runner runner-2']);
      expect(t.runners.deleteForDepartedOwner).toHaveBeenCalledWith(runner, t.manager);
      expect(t.runners.deleteForDepartedOwner).toHaveBeenCalledWith(shared, t.manager);
      const runnerLookup = t.manager.getRepository.mock.results[0].value.find.mock.calls[0][0];
      expect(runnerLookup).toEqual({ where: { organizationId: 'org-1', ownerUserId: 'leaver' } });

      expect(rows.map((r: any) => [r.action, r.resourceType, r.resourceId])).toEqual([
        [AuditAction.DELETE, AuditResource.RUNNER, 'runner-1'],
        [AuditAction.DELETE, AuditResource.RUNNER, 'runner-2'],
        [AuditAction.OWNERSHIP_TRANSFER, AuditResource.AGENT, 'a-1'],
        [AuditAction.OWNERSHIP_TRANSFER, AuditResource.CREDENTIAL, 'c-1'],
      ]);
      expect(rows[1]).toMatchObject({ details: { reason: 'member_removed', ownerUserId: 'leaver', visibility: 'team', teamId: 'team-1' } });
      expect(t.audit.logInTransaction).toHaveBeenCalledWith(t.manager, expect.objectContaining({
        organizationId: 'org-1',
        userId: 'admin',
        resourceName: 'Agent',
        changes: [{ field: 'createdBy', from: 'leaver', to: 'admin' }],
        details: expect.objectContaining({ reason: 'member_removed', fromUserId: 'leaver', toUserId: 'admin' }),
      }));
    });

    it('revokes the leaver\'s own connections, drops their grants and grants naming the leaver, and audits each', async () => {
      const t = build({}, [], {
        connections: [
          { id: 'conn-p', organizationId: 'org-1', name: 'my github', visibility: 'private', connectorKey: 'github', previousConfig: { accessToken: 'encrypted:p' } },
          { id: 'conn-u', organizationId: 'org-1', name: 'my openai', visibility: 'org', connectorKey: 'openai', previousConfig: { apiKey: 'encrypted:u' } },
        ],
        connectionGrants: [{ id: 'g-1', connectionId: 'conn-u' }, { id: 'g-2', connectionId: 'conn-u' }],
        userGrants: [{ id: 'g-9', connectionId: 'conn-org', permission: 'use' }],
      });
      const wipedConnections: any[] = [];

      const rows = await t.helper.handOverPrivateResources(t.manager, { ...args, wipedConnections });

      const [revokeSql, revokeParams] = t.manager.query.mock.calls.find(([sql]: [string]) => /"healthStatus" = 'revoked'/.test(sql));
      expect(revokeSql).toContain(`config = '{}'::json`);
      expect(revokeSql).toContain('"isActive" = false');
      expect(revokeSql).toContain(memberConnectionSql());
      // The secret as it was comes back for the provider revoke after commit.
      expect(revokeSql).toContain('target."previousConfig"');
      expect(revokeParams).toEqual(['org-1', 'leaver', 'the owner left the organization']);
      expect(wipedConnections.map((c) => [c.id, c.previousConfig, c.grantsRemoved])).toEqual([
        ['conn-p', { accessToken: 'encrypted:p' }, 0],
        ['conn-u', { apiKey: 'encrypted:u' }, 2],
      ]);
      const [grantSql, grantParams] = t.manager.query.mock.calls.find(([sql]: [string]) => /DELETE FROM connection_grants WHERE "connectionId"/.test(sql));
      expect(grantSql).toContain('ANY($1::uuid[])');
      expect(grantParams).toEqual([['conn-p', 'conn-u']]);
      const [userGrantSql, userGrantParams] = t.manager.query.mock.calls.find(([sql]: [string]) => /"principalType" = 'user'/.test(sql));
      expect(userGrantSql).toContain('"organizationId" = $1');
      expect(userGrantParams).toEqual(['org-1', 'leaver']);

      expect(rows.map((r: any) => [r.action, r.resourceId])).toEqual([
        [AuditAction.CONNECTION_DISCONNECT, 'conn-p'],
        [AuditAction.CONNECTION_DISCONNECT, 'conn-u'],
        [AuditAction.CONNECTION_REVOKE_GRANT, 'conn-org'],
      ]);
      expect(rows[0]).toMatchObject({ details: { owner: 'private', secretWiped: true, providerRevoke: 'after_commit', grantsRemoved: 0, reason: 'member_removed' } });
      expect(rows[1]).toMatchObject({ details: { owner: 'user', grantsRemoved: 2 } });
      expect(rows[2]).toMatchObject({ details: { principalType: 'user', principalId: 'leaver', grantId: 'g-9' } });
    });

    it('a managed credential (an LLM provider\'s own key) is not a member connection', () => {
      expect(memberConnectionSql()).toContain(`'managedBy'`);
      expect(memberConnectionSql()).toContain('"connectorKey" IS NOT NULL');
    });
  });

  describe('demoteTeamResources', () => {
    it('makes every row of the team org-wide and audits each one', async () => {
      const t = build({ tools: [{ id: 't-1', name: 'tool' }], runners: [{ id: 'r-1', name: 'box' }] });

      const rows = await t.helper.demoteTeamResources(t.manager, {
        organizationId: 'org-1', teamId: 'team-1', teamName: 'Platform', actorUserId: 'owner',
      });

      expect(t.manager.query).toHaveBeenCalledTimes(TEAM_SCOPED_TABLES.length);
      for (const [sql, params] of t.manager.query.mock.calls) {
        expect(sql).toMatch(/SET visibility = 'org', "teamId" = NULL\s+WHERE "teamId" = \$1/);
        expect(params).toEqual(['team-1']);
      }
      expect(rows.map((r: any) => [r.action, r.resourceType, r.resourceId])).toEqual([
        [AuditAction.VISIBILITY_CHANGE, AuditResource.TOOL, 't-1'],
        [AuditAction.VISIBILITY_CHANGE, AuditResource.RUNNER, 'r-1'],
      ]);
      expect(rows[0]).toMatchObject({
        userId: 'owner',
        details: { reason: 'team_deleted', teamId: 'team-1', teamName: 'Platform' },
      });
    });
  });
});
