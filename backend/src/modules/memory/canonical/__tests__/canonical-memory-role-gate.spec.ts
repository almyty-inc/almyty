import 'reflect-metadata';
import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { CanonicalMemoryController } from '../canonical-memory.controller';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';
import { OrganizationRole } from '../../../../entities/user-organization.entity';

// Org scope on this controller is genuinely well defended: ownScope/assertScope
// substitute the caller's own org by construction, so it was never
// cross-tenant. What was missing is the caller's ROLE. With only JwtAuthGuard
// across 15 routes, a `viewer` -- permissions ['read', 'connections:read'] --
// could POST config and repoint the org's memory backend, embedding provider
// and softcap behaviour, run a cross-backend transfer, or delete memory rows.
// kms.controller.ts and retention.controller.ts, the comparable config
// surfaces, are admin/owner.
describe('canonical memory role gate', () => {
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
          url: '/memory/canonical',
          params: {},
          user: {
            id: 'u-1',
            currentOrganizationId: 'org-1',
            organizationMemberships: [membership],
          },
        }),
      }),
      getHandler: () => CanonicalMemoryController.prototype[handler],
      getClass: () => CanonicalMemoryController,
    } as unknown as ExecutionContext;
  };

  const adminOnly = [
    'updateConfig',
    // Runs a model over the org's short-term rows and supersedes them in
    // bulk: it spends money and rewrites things the caller never looked at.
    'consolidate',
    'syncScope',
    'transfer',
    'remove',
  ] as const;

  const memberPlus = [
    'listBackends',
    'healthAll',
    'getConfig',
    'listSoftcapWarnings',
    'importDocument',
    'put',
    'get',
    'list',
    'search',
    // The correction half of the write path. Bi-temporal — the old row's
    // `valid_until` closes and the history stays readable — so gating it
    // above `put` would let somebody record a fact and then be unable to
    // fix it.
    'supersede',
  ] as const;

  const everyRoute = [...adminOnly, ...memberPlus];

  it.each(everyRoute)('%s declares @Roles at all', (handler) => {
    expect(Reflect.getMetadata(ROLES_KEY, CanonicalMemoryController.prototype[handler])).toBeDefined();
  });

  it.each(everyRoute)('%s refuses a viewer', (handler) => {
    expect(() => guard.canActivate(contextFor(handler, OrganizationRole.VIEWER))).toThrow(
      ForbiddenException,
    );
  });

  it.each(adminOnly)('%s refuses a member too', (handler) => {
    expect(Reflect.getMetadata(ROLES_KEY, CanonicalMemoryController.prototype[handler])).toEqual([
      'admin',
      'owner',
    ]);
    expect(() => guard.canActivate(contextFor(handler, OrganizationRole.MEMBER))).toThrow(
      ForbiddenException,
    );
    expect(guard.canActivate(contextFor(handler, OrganizationRole.ADMIN))).toBe(true);
  });

  it.each(memberPlus)('%s admits a member', (handler) => {
    expect(guard.canActivate(contextFor(handler, OrganizationRole.MEMBER))).toBe(true);
  });
});
