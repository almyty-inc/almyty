import 'reflect-metadata';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { RolesGuard } from '../../../../src/modules/auth/guards/roles.guard';
import { OrganizationRole } from '../../../../src/entities/user-organization.entity';
import {
  RBAC_ACTION_KEY,
  RBAC_PERMISSION_CATALOG,
} from '../../../../src/common/authorization/rbac-actions';
import { AgentsController } from '../../../../src/modules/agents/agents.controller';
import { AgentExecutionController } from '../../../../src/modules/agents/agent-execution.controller';
import { AgentRunsController } from '../../../../src/modules/agents/agent-runs.controller';
import { AgentManagementController } from '../../../../src/modules/agents/agent-management.controller';
import { AgentScheduleController } from '../../../../src/modules/agents/agent-schedule.controller';
import { AgentRolesController } from '../../../../src/modules/agents/agent-roles.controller';
import { AgentApiAccessController } from '../../../../src/modules/agents/agent-api-access.controller';
import { AgentExecutionSettingsController } from '../../../../src/modules/agents/agent-execution-settings.controller';
import { ToolsController } from '../../../../src/modules/tools/tools.controller';
import { ToolsExportController } from '../../../../src/modules/tools/tools-export.controller';
import { AuditLogController } from '../../../../src/modules/audit-log/audit-log.controller';
import { AuditExportController } from '../../audit-export/audit-export.controller';
import { AdvancedRbacHookImpl } from '../advanced-rbac.hook';
import { PolicyEvaluatorService } from '../policy-evaluator.service';
import { AbacPolicy } from '../../../../src/entities/abac-policy.entity';

/**
 * A custom role's permissions gate the routes they name. Before, only
 * `role:<x>` grants were consulted, so `agents:execute` on a viewer did
 * nothing and an ABAC policy on `agents:execute` never matched a route.
 * Each case drives the real RolesGuard against the real controller
 * handler's metadata, with the real hook and evaluator.
 */
describe('custom-role permissions are enforced on the routes they name', () => {
  const evaluator = new PolicyEvaluatorService();

  function guardFor(grants: string[], policies: Partial<AbacPolicy>[] = [], roleNames: string[] = []) {
    const customRoles = {
      hasPermission: async (_o: string, _u: string, perm: string) => evaluator.permits(grants, perm),
      evaluateAccess: async (_o: string, action: string, ctx: any) =>
        evaluator.evaluate(
          policies.map((p, i) => ({ id: `p${i}`, active: true, priority: 0, conditions: [], ...p })) as AbacPolicy[],
          action,
          ctx,
        ),
      getActiveRoleNames: async () => roleNames,
    };
    const licenses = { hasForOrg: async () => true };
    const hook = new AdvancedRbacHookImpl(customRoles as any, licenses as any);
    return new RolesGuard(new Reflector(), hook);
  }

  function contextFor(controller: any, method: string, role: OrganizationRole, body: any = {}): ExecutionContext {
    const request = {
      method: 'POST',
      url: '/x',
      body,
      params: { id: 'agent-1' },
      user: {
        id: 'user-1',
        currentOrganizationId: 'org-1',
        organizationMemberships: [
          { organizationId: 'org-1', role, isActive: true, inviteAccepted: true, hasPermission: () => false },
        ],
      },
    };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => controller.prototype[method],
      getClass: () => controller,
    } as any;
  }

  // One route per permission; the role is one the route's @Roles does not
  // admit, so only the custom-role grant can let the caller through.
  const cases: Array<[string, any, string, OrganizationRole]> = [
    ['agents:read', AgentsController, 'getReadiness', OrganizationRole.VIEWER],
    ['agents:create', AgentsController, 'createAgent', OrganizationRole.VIEWER],
    ['agents:update', AgentsController, 'updateAgent', OrganizationRole.VIEWER],
    ['agents:delete', AgentsController, 'deleteAgent', OrganizationRole.VIEWER],
    ['agents:execute', AgentExecutionController, 'invokeAgent', OrganizationRole.VIEWER],
    ['tools:read', ToolsController, 'getTools', OrganizationRole.VIEWER],
    ['tools:manage', ToolsController, 'deleteTool', OrganizationRole.MEMBER],
    ['tools:execute', ToolsController, 'executeTool', OrganizationRole.VIEWER],
    ['audit:read', AuditLogController, 'findAll', OrganizationRole.MEMBER],
    ['audit:export', AuditExportController, 'download', OrganizationRole.MEMBER],
  ];

  it('covers every permission in the catalog', () => {
    expect(cases.map((c) => c[0]).sort()).toEqual(RBAC_PERMISSION_CATALOG.map((p) => p.permission).sort());
  });

  describe.each(cases)('%s', (permission, controller, method, role) => {
    it('denies the route without the permission', async () => {
      await expect(guardFor(['something:else']).canActivate(contextFor(controller, method, role))).rejects.toThrow(
        new ForbiddenException(`Insufficient role privileges (needs ${permission})`),
      );
    });

    it('allows it with the permission', async () => {
      await expect(guardFor([permission]).canActivate(contextFor(controller, method, role))).resolves.toBe(true);
    });

    it('allows it through a resource wildcard', async () => {
      const [resource] = permission.split(':');
      await expect(guardFor([`${resource}:*`]).canActivate(contextFor(controller, method, role))).resolves.toBe(true);
    });
  });

  it('*:read grants reads, not writes', async () => {
    const guard = guardFor(['*:read']);
    await expect(guard.canActivate(contextFor(AgentsController, 'getReadiness', OrganizationRole.VIEWER))).resolves.toBe(true);
    await expect(
      guard.canActivate(contextFor(AgentExecutionController, 'invokeAgent', OrganizationRole.VIEWER)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('every route-declared permission is in the catalog, and every catalog entry is declared somewhere', () => {
    const controllers = [
      AgentsController, AgentExecutionController, AgentRunsController, AgentManagementController,
      AgentScheduleController, AgentRolesController, AgentApiAccessController, AgentExecutionSettingsController,
      ToolsController, ToolsExportController, AuditLogController, AuditExportController,
    ];
    const declared = new Set<string>();
    for (const c of controllers) {
      const classAction = Reflect.getMetadata(RBAC_ACTION_KEY, c);
      if (classAction) declared.add(classAction);
      for (const name of Object.getOwnPropertyNames(c.prototype)) {
        const action = Reflect.getMetadata(RBAC_ACTION_KEY, c.prototype[name]);
        if (action) declared.add(action);
      }
    }
    const catalog = RBAC_PERMISSION_CATALOG.map((p) => p.permission);
    expect([...declared].sort()).toEqual([...catalog].sort());
  });

  describe('access policies match on the route permission', () => {
    const bigRefunds: Partial<AbacPolicy> = {
      name: 'block-large-amounts',
      effect: 'deny',
      action: 'agents:execute',
      conditions: [
        { attr: 'resource.input.amount', op: 'gt', value: 10000 },
        { attr: 'subject.roles', op: 'not_contains', value: 'finance' },
      ],
    };

    it('a deny policy on agents:execute refuses a large amount for a non-finance member', async () => {
      const guard = guardFor([], [bigRefunds]);
      await expect(
        guard.canActivate(contextFor(AgentExecutionController, 'invokeAgent', OrganizationRole.MEMBER, { input: { amount: 20000 } })),
      ).rejects.toThrow(new ForbiddenException('denied by policy "block-large-amounts"'));
    });

    it('lets a small amount through', async () => {
      const guard = guardFor([], [bigRefunds]);
      await expect(
        guard.canActivate(contextFor(AgentExecutionController, 'invokeAgent', OrganizationRole.MEMBER, { input: { amount: 50 } })),
      ).resolves.toBe(true);
    });
  });

  it('subject.roles carries the custom role names', async () => {
    const policy: Partial<AbacPolicy> = {
      name: 'finance-only',
      effect: 'deny',
      action: 'agents:execute',
      conditions: [{ attr: 'subject.roles', op: 'contains', value: 'contractor' }],
    };
    const ctx = () => contextFor(AgentExecutionController, 'invokeAgent', OrganizationRole.MEMBER);
    await expect(guardFor([], [policy], ['contractor']).canActivate(ctx())).rejects.toThrow(ForbiddenException);
    await expect(guardFor([], [policy], ['finance']).canActivate(ctx())).resolves.toBe(true);
  });
});
