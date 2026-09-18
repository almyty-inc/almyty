import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { ExternalAgentsController } from '../external-agents.controller';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { OrganizationRole } from '../../../entities/user-organization.entity';

// The controller was JwtAuthGuard-only, so a `viewer` -- permissions ['read',
// 'connections:read'] -- could create, repoint, refresh or delete an external
// agent. Repointing one's URL is a data-exfiltration primitive: the org's own
// agents then call an attacker-chosen endpoint with whatever they pass it.
// Org scope was already correct; the role was not checked at all.
describe('external agents role gate', () => {
  const guard = new RolesGuard(new Reflector());

  const contextFor = (handler: string, role: OrganizationRole): ExecutionContext => {
    const membership = {
      organizationId: 'org-1',
      role,
      hasPermission: () => role !== OrganizationRole.VIEWER,
    };
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          url: '/external-agents',
          params: {},
          user: {
            id: 'u-1',
            currentOrganizationId: 'org-1',
            organizationMemberships: [membership],
          },
        }),
      }),
      getHandler: () => ExternalAgentsController.prototype[handler],
      getClass: () => ExternalAgentsController,
    } as unknown as ExecutionContext;
  };

  // Mutations, plus the two routes that fetch a remote URL server-side.
  const memberPlus = ['preview', 'create', 'update', 'remove', 'refresh'] as const;
  const viewerPlus = ['findAll', 'findOne'] as const;

  it.each([...memberPlus, ...viewerPlus])('%s declares @Roles at all', (handler) => {
    expect(Reflect.getMetadata(ROLES_KEY, ExternalAgentsController.prototype[handler])).toBeDefined();
  });

  it.each(memberPlus)('%s refuses a viewer', (handler) => {
    expect(() => guard.canActivate(contextFor(handler, OrganizationRole.VIEWER))).toThrow(
      ForbiddenException,
    );
  });

  it.each(memberPlus)('%s admits a member (matching agents.controller.ts)', (handler) => {
    expect(guard.canActivate(contextFor(handler, OrganizationRole.MEMBER))).toBe(true);
  });

  it.each(viewerPlus)('%s stays readable by a viewer, as on agents.controller.ts', (handler) => {
    expect(guard.canActivate(contextFor(handler, OrganizationRole.VIEWER))).toBe(true);
  });
});
