import {
  OWNED_RESOURCE_TABLES,
  ResourceHandoverHelper,
  TEAM_SCOPED_TABLES,
} from '../resource-handover.helper';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { Runner } from '../../../entities/runner.entity';

describe('ResourceHandoverHelper', () => {
  function build(updated: Record<string, Array<{ id: string; name: string }>>, privateRunners: any[] = []) {
    const order: string[] = [];
    const manager: any = {
      // manager.query on UPDATE ... RETURNING yields [rows, rowCount].
      query: jest.fn(async (sql: string) => {
        const table = /UPDATE (\w+)/.exec(sql)![1];
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
    const helper = new ResourceHandoverHelper(audit as any, runners as any);
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

    it('moves only private rows of the leaver in this org, keeping them private', async () => {
      const t = build({});
      await t.helper.handOverPrivateResources(t.manager, args);

      expect(t.manager.query).toHaveBeenCalledTimes(OWNED_RESOURCE_TABLES.length);
      for (const [sql, params] of t.manager.query.mock.calls) {
        expect(sql).toMatch(/WHERE "organizationId" = \$2 AND visibility = 'private' AND "(createdBy|ownerUserId)" = \$3/);
        expect(sql).not.toMatch(/SET[^W]*visibility/);
        expect(params).toEqual(['admin', 'org-1', 'leaver']);
      }
    });

    it('deletes the private runner first, then audits one row per moved resource', async () => {
      const runner = { id: 'runner-1', name: 'leaver-mac' };
      const t = build(
        { agents: [{ id: 'a-1', name: 'Agent' }], credentials: [{ id: 'c-1', name: 'Key' }] },
        [runner],
      );

      const rows = await t.helper.handOverPrivateResources(t.manager, args);

      // Runner tools are private tools of the leaver: they go with the
      // runner instead of being handed over.
      expect(t.order[0]).toBe('delete runner runner-1');
      expect(t.runners.deleteForDepartedOwner).toHaveBeenCalledWith(runner, t.manager);

      expect(rows.map((r: any) => [r.action, r.resourceType, r.resourceId])).toEqual([
        [AuditAction.DELETE, AuditResource.RUNNER, 'runner-1'],
        [AuditAction.OWNERSHIP_TRANSFER, AuditResource.AGENT, 'a-1'],
        [AuditAction.OWNERSHIP_TRANSFER, AuditResource.CREDENTIAL, 'c-1'],
      ]);
      expect(t.audit.logInTransaction).toHaveBeenCalledWith(t.manager, expect.objectContaining({
        organizationId: 'org-1',
        userId: 'admin',
        resourceName: 'Agent',
        changes: [{ field: 'createdBy', from: 'leaver', to: 'admin' }],
        details: expect.objectContaining({ reason: 'member_removed', fromUserId: 'leaver', toUserId: 'admin' }),
      }));
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
