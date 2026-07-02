import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Optional, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import {
  ADVANCED_RBAC_HOOK,
  AdvancedRbacHook,
  RbacHookDecision,
} from '../../../common/ee-hooks/ee-hooks';

export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    // EE hook (advanced_rbac): custom-role additive grants + ABAC
    // deny-overrides. Absent in the community build — @Optional()
    // resolves to undefined and canActivate stays fully synchronous
    // with the exact built-in role/permission semantics.
    @Optional()
    @Inject(ADVANCED_RBAC_HOOK)
    private readonly rbacHook?: AdvancedRbacHook,
  ) {}

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    // Get required roles and permissions from decorators
    const requiredRoles = this.reflector.getAllAndOverride<OrganizationRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If no roles or permissions are required, allow access
    if (!requiredRoles && !requiredPermissions) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Resolve the org to authorize against (path param or validated current org)
    const organizationId = this.extractOrganizationId(request);
    
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }

    // Find user's membership in the organization
    const membership = user.organizationMemberships?.find(
      (m: any) => (m.organizationId ?? m.organization?.id) === organizationId
    );

    if (!membership) {
      throw new ForbiddenException('User is not a member of this organization');
    }

    // Built-in checks (community semantics)
    const roleOk = !requiredRoles || requiredRoles.includes(membership.role);
    const missingPermissions = (requiredPermissions ?? []).filter(
      (permission: string) => !membership.hasPermission(permission),
    );

    // Community build (no EE hook): identical behavior to before —
    // synchronous allow/deny on the built-in role + permission checks.
    if (!this.rbacHook) {
      if (!roleOk) {
        throw new ForbiddenException('Insufficient role privileges');
      }
      if (missingPermissions.length > 0) {
        throw new ForbiddenException('Insufficient permissions');
      }
      return true;
    }

    return this.decideWithRbacHook(
      request,
      user,
      membership,
      organizationId,
      requiredRoles,
      requiredPermissions,
      roleOk,
      missingPermissions,
    );
  }

  /**
   * EE (advanced_rbac) decision path. Two extensions over the built-in
   * checks, both best-effort (a hook failure falls back to the built-in
   * outcome):
   *
   * 1. Additive grants — a custom role can cover a missing permission
   *    directly, or satisfy a required org role via the `role:<name>`
   *    pseudo-permission (the EE evaluator's wildcards apply, so `role:*`
   *    or `*` also match). Grants can only ALLOW what the built-ins would
   *    deny, never revoke a built-in pass.
   * 2. ABAC deny-overrides — an applicable `deny` policy rejects the
   *    request even when role/permission checks passed. 'allow'/'abstain'
   *    leave the built-in outcome unchanged.
   */
  private async decideWithRbacHook(
    request: any,
    user: any,
    membership: any,
    organizationId: string,
    requiredRoles: OrganizationRole[] | undefined,
    requiredPermissions: string[] | undefined,
    builtInRoleOk: boolean,
    missingPermissions: string[],
  ): Promise<boolean> {
    let roleOk = builtInRoleOk;
    let missing = missingPermissions;

    if (!roleOk && requiredRoles?.length) {
      const grants = await Promise.all(
        requiredRoles.map((role) =>
          this.hookHasPermission(organizationId, user.id, `role:${role}`),
        ),
      );
      if (grants.some(Boolean)) {
        roleOk = true;
      }
    }
    if (roleOk && missing.length > 0) {
      const grants = await Promise.all(
        missing.map((permission) =>
          this.hookHasPermission(organizationId, user.id, permission),
        ),
      );
      missing = missing.filter((_, i) => !grants[i]);
    }

    if (!roleOk) {
      throw new ForbiddenException('Insufficient role privileges');
    }
    if (missing.length > 0) {
      throw new ForbiddenException('Insufficient permissions');
    }

    // ABAC deny-override: evaluated per required permission (those are the
    // action vocabulary), or once against the route when only roles are
    // required.
    const actions = requiredPermissions?.length
      ? requiredPermissions
      : [`${request.method ?? 'ANY'}:${request.route?.path ?? request.url ?? '*'}`];
    const evaluationCtx = {
      subject: { id: user.id, role: membership.role },
      context: {
        organizationId,
        method: request.method,
        path: request.route?.path ?? request.url,
      },
    };
    for (const action of actions) {
      let decision: RbacHookDecision | undefined;
      try {
        decision = await this.rbacHook!.evaluateAccess(organizationId, action, evaluationCtx);
      } catch {
        // Hook failure never blocks — community parity.
        continue;
      }
      if (decision?.effect === 'deny') {
        throw new ForbiddenException(decision.reason ?? 'Access denied by policy');
      }
    }

    return true;
  }

  private async hookHasPermission(
    organizationId: string,
    userId: string,
    permission: string,
  ): Promise<boolean> {
    try {
      return await this.rbacHook!.hasPermission(organizationId, userId, permission);
    } catch {
      // Hook failure never grants — community parity.
      return false;
    }
  }

  private extractOrganizationId(request: any): string | null {
    // SECURITY: the role check must run against the SAME organization the
    // handler acts on. Handlers use either the `:organizationId` path param
    // (organizations routes) or `req.user.currentOrganizationId` — the latter
    // is set AND membership-validated by JwtStrategy from the
    // X-Organization-Id header. We deliberately do NOT consult
    // query/body/header org ids here: trusting a caller-supplied org for the
    // role check while the handler mutated `currentOrganizationId` let any
    // member of their own auto-created org pass admin/owner checks against a
    // victim org (cross-tenant privilege escalation).
    const pathOrg = request.params?.organizationId;
    if (pathOrg) return pathOrg;

    if (request.user?.currentOrganizationId) {
      return request.user.currentOrganizationId;
    }

    return null;
  }
}