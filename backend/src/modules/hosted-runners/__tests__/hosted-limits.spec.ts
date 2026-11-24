import 'reflect-metadata';
import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { EnvironmentsController } from '../environments.controller';
import { HostedLimitsDto } from '../dto/hosted-limits.dto';
import { HostedLimitsService } from '../hosted-limits.service';
import { HostedCapacity } from '../hosted-capacity.provider';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

/**
 * An organization lowers its own hosted limits from the Hosted tab
 * (PUT /environments/capacity/limits): owners and admins only, each number
 * at most the plan's, every change on the audit trail.
 */
const ORG = 'org-1';
const PRO: HostedCapacity = { plan: 'pro', hostedEnvironments: true, maxConcurrentRunners: 2, maxWorkspaces: 10, resourceClasses: null, monthlyCeilingUsd: 50 };

function setup(plan: HostedCapacity | null, settings: Record<string, any> | null = {}) {
  const hosted: any = { planLimitsFor: jest.fn(async () => plan) };
  const query = jest.fn(async (sql: string, _params?: unknown[]) => (sql.startsWith('SELECT') ? [{ settings }] : []));
  const auditLog: any = { log: jest.fn(async () => null) };
  const service = new HostedLimitsService(hosted, { query } as any, auditLog);
  return { service, query, auditLog };
}

describe('own hosted limits', () => {
  it('lowers the limits, keeps other settings, and audits the change', async () => {
    const { service, query, auditLog } = setup(PRO, { alwaysOn: { includedAgents: 1 }, hostedCapacity: { monthlyCeilingHours: 20 } });
    const view = await service.set(ORG, { userId: 'u-1', ipAddress: '1.2.3.4' }, { maxConcurrentRunners: 1, monthlyCeilingUsd: 20 });

    expect(view).toEqual({
      available: true,
      plan: { maxConcurrentRunners: 2, maxWorkspaces: 10, monthlyCeilingUsd: 50 },
      own: { maxConcurrentRunners: 1, maxWorkspaces: null, monthlyCeilingUsd: 20 },
    });
    const update = query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))!;
    expect(update[0]).toContain("jsonb_set(COALESCE(settings, '{}'::jsonb), '{hostedCapacity}'");
    expect(JSON.parse(update[1]![1] as string)).toEqual({ monthlyCeilingHours: 20, maxConcurrentRunners: 1, monthlyCeilingUsd: 20 });
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        userId: 'u-1',
        action: AuditAction.UPDATE,
        resourceType: AuditResource.ORGANIZATION,
        changes: [
          { field: 'maxConcurrentRunners', from: null, to: 1 },
          { field: 'monthlyCeilingUsd', from: null, to: 20 },
        ],
      }),
    );
  });

  it('refuses a raise above the plan and writes nothing', async () => {
    const { service, query, auditLog } = setup(PRO);
    const err = await service.set(ORG, { userId: 'u-1' }, { maxConcurrentRunners: 3 }).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Your plan allows at most 2 machines running at once. You can only lower it.');
    await expect(service.set(ORG, {}, { monthlyCeilingUsd: 50.01 })).rejects.toThrow('Your plan allows at most $50.00 a month beyond the included hours.');
    await expect(service.set(ORG, {}, { maxWorkspaces: 11 })).rejects.toThrow('at most 10 workspaces kept');
    expect(query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(false);
    expect(auditLog.log).not.toHaveBeenCalled();
  });

  it('accepts the plan limit itself, and any number where the plan has none', async () => {
    await expect(setup(PRO).service.set(ORG, {}, { maxConcurrentRunners: 2, maxWorkspaces: 10, monthlyCeilingUsd: 50 })).resolves.toMatchObject({ available: true });
    const open = setup({ ...PRO, plan: 'enterprise', monthlyCeilingUsd: null });
    await expect(open.service.set(ORG, {}, { monthlyCeilingUsd: 5000 })).resolves.toMatchObject({ own: { monthlyCeilingUsd: 5000 } });
  });

  it('clears the own limits back to the plan', async () => {
    const { service, query, auditLog } = setup(PRO, { hostedCapacity: { maxWorkspaces: 4 } });
    const view = await service.set(ORG, { userId: 'u-1' }, {});
    expect(view.own).toEqual({ maxConcurrentRunners: null, maxWorkspaces: null, monthlyCeilingUsd: null });
    expect(query.mock.calls.find(([sql]) => sql.startsWith('UPDATE'))![0]).toContain("- 'hostedCapacity'");
    expect(auditLog.log).toHaveBeenCalledWith(expect.objectContaining({ changes: [{ field: 'maxWorkspaces', from: 4, to: null }] }));
  });

  it('refuses where no plan applies, and says so in the view', async () => {
    const none = setup(null);
    await expect(none.service.set(ORG, {}, { maxWorkspaces: 1 })).rejects.toThrow(BadRequestException);
    await expect(none.service.view(ORG)).resolves.toMatchObject({ available: false });
    const free = setup({ ...PRO, plan: 'free', hostedEnvironments: false });
    await expect(free.service.set(ORG, {}, { maxWorkspaces: 0 })).rejects.toThrow(BadRequestException);
  });

  it('reads the own limits next to the plan limits', async () => {
    const { service } = setup(PRO, { hostedCapacity: { maxWorkspaces: 4, monthlyCeilingUsd: 10 } });
    await expect(service.view(ORG)).resolves.toEqual({
      available: true,
      plan: { maxConcurrentRunners: 2, maxWorkspaces: 10, monthlyCeilingUsd: 50 },
      own: { maxConcurrentRunners: null, maxWorkspaces: 4, monthlyCeilingUsd: 10 },
    });
  });

  it('validates the body: whole numbers of machines and workspaces, dollars to the cent, never negative', async () => {
    const errors = async (body: object) => (await validate(plainToInstance(HostedLimitsDto, body))).map((e) => e.property);
    expect(await errors({ maxConcurrentRunners: 1, maxWorkspaces: null, monthlyCeilingUsd: 12.5 })).toEqual([]);
    expect(await errors({ maxConcurrentRunners: 1.5 })).toEqual(['maxConcurrentRunners']);
    expect(await errors({ maxWorkspaces: -1 })).toEqual(['maxWorkspaces']);
    expect(await errors({ monthlyCeilingUsd: 1.234 })).toEqual(['monthlyCeilingUsd']);
  });
});

describe('own hosted limits route', () => {
  const guard = new RolesGuard(new Reflector());
  const contextFor = (role: OrganizationRole): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'PUT',
          url: '/environments/capacity/limits',
          params: {},
          user: { id: 'u-1', currentOrganizationId: ORG, organizationMemberships: [{ organizationId: ORG, role, hasPermission: () => true }] },
        }),
      }),
      getHandler: () => EnvironmentsController.prototype.setLimits,
      getClass: () => EnvironmentsController,
    }) as unknown as ExecutionContext;

  it('is for owners and admins only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, EnvironmentsController.prototype.setLimits)).toEqual(['admin', 'owner']);
    expect(() => guard.canActivate(contextFor(OrganizationRole.MEMBER))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextFor(OrganizationRole.VIEWER))).toThrow(ForbiddenException);
    expect(guard.canActivate(contextFor(OrganizationRole.ADMIN))).toBe(true);
    expect(guard.canActivate(contextFor(OrganizationRole.OWNER))).toBe(true);
  });
});
