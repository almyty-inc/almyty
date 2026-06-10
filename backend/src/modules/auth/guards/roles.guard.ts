import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { OrganizationRole } from '../../../entities/user-organization.entity';

export const ROLES_KEY = 'roles';
export const PERMISSIONS_KEY = 'permissions';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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

    // Check roles
    if (requiredRoles && !requiredRoles.includes(membership.role)) {
      throw new ForbiddenException('Insufficient role privileges');
    }

    // Check permissions
    if (requiredPermissions) {
      const hasAllPermissions = requiredPermissions.every(permission =>
        membership.hasPermission(permission)
      );

      if (!hasAllPermissions) {
        throw new ForbiddenException('Insufficient permissions');
      }
    }

    return true;
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