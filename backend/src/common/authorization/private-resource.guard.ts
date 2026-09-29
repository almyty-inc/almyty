import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  Optional,
  Type,
  mixin,
} from '@nestjs/common';
import { DataSource, EntityTarget, ObjectLiteral } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { Api } from '../../entities/api.entity';
import { Tool } from '../../entities/tool.entity';
import { UserOrganization } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { AccessPolicyService, ResourceLike } from './access-policy.service';
import { canRead } from './read-rule';

/**
 * The resources a route parameter can name. Each maps to its entity and
 * the column that records a private row's owner.
 */
export type PrivateResourceKind = 'agent' | 'tool' | 'api';

const KINDS: Record<PrivateResourceKind, { entity: EntityTarget<ObjectLiteral>; owner: 'createdBy' | 'ownerUserId'; label: string }> = {
  agent: { entity: Agent, owner: 'createdBy', label: 'Agent' },
  tool: { entity: Tool, owner: 'createdBy', label: 'Tool' },
  api: { entity: Api, owner: 'ownerUserId', label: 'API' },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route guard: refuse (404) any request whose path names an agent / tool /
 * API the caller may not read.
 *
 * Every controller under `agents/:id/...`, `.../tools/:toolId/...` and
 * `apis/:id/...` resolves its row a little differently -- some through
 * the service, some straight off a repository, some not at all before
 * handing the id to a queue. Guarding the route parameter itself is the
 * one place none of them can forget. The row is looked up by id alone
 * (not by the org in the path), so a mismatched org id cannot route
 * around it.
 *
 * The decision is the read rule (read-rule.ts, AccessPolicyService.canAccess
 * 'read'): another member's private row is refused whatever the caller's
 * role, org admins included; a team row is refused to anyone outside the
 * team who is not an org owner or admin; a row of an organization the
 * caller is not a member of is refused. The answer is the 404 a missing
 * row gets, so a caller probing ids cannot tell "not yours" from "absent".
 *
 * Non-UUID values pass through so literal sub-routes (`agents/templates`)
 * and ParseUUIDPipe keep answering as before, and a missing row passes so
 * the handler's own 404 stays the answer. The DataSource is optional only
 * so controller unit tests without a database can construct the guard;
 * the application always has one.
 */
export function PrivateResourceGuard(params: Record<string, PrivateResourceKind>): Type<CanActivate> {
  @Injectable()
  class PrivateResourceGuardMixin implements CanActivate {
    private policy?: AccessPolicyService;

    constructor(@Optional() readonly dataSource?: DataSource) {}

    private accessPolicy(ds: DataSource): AccessPolicyService {
      this.policy ??= new AccessPolicyService(ds.getRepository(UserOrganization), ds.getRepository(UserTeam));
      return this.policy;
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
      if (!this.dataSource) return true;
      const req = context.switchToHttp().getRequest();
      const userId: string | undefined = req?.user?.sub || req?.user?.id;
      for (const [param, kind] of Object.entries(params)) {
        const id = req?.params?.[param];
        if (typeof id !== 'string' || !UUID_RE.test(id)) continue;
        const spec = KINDS[kind];
        const row = (await this.dataSource.getRepository(spec.entity).findOne({
          where: { id },
          select: { id: true, organizationId: true, visibility: true, teamId: true, [spec.owner]: true } as any,
        })) as ResourceLike | null;
        // No user is nobody, who reads no row by id here: these routes
        // all sit behind JwtAuthGuard, so a missing user is a wiring fault.
        if (row && (!userId || !(await canRead(this.accessPolicy(this.dataSource), { id: userId }, row)))) {
          throw new NotFoundException(`${spec.label} not found`);
        }
      }
      return true;
    }
  }
  return mixin(PrivateResourceGuardMixin);
}

/** `agents/:id/...` routes. */
export const PrivateAgentGuard = PrivateResourceGuard({ id: 'agent' });
/** `agents/:agentId/...` sub-resource routes. */
export const PrivateAgentByAgentIdGuard = PrivateResourceGuard({ agentId: 'agent' });
/** `organizations/:organizationId/tools/:toolId/...` routes, plus `generate-from-api/:apiId`. */
export const PrivateToolGuard = PrivateResourceGuard({ toolId: 'tool', apiId: 'api' });
/** `apis/:id/...` routes. */
export const PrivateApiGuard = PrivateResourceGuard({ id: 'api' });
