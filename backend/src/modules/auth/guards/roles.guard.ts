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

    // Check organization context (from path params, query, or body)
    const organizationId = this.extractOrganizationId(request);
    
    if (!organizationId) {
      throw new ForbiddenException('Organization context required');
    }

    // Find user's membership in the organization
    const membership = user.organizationMemberships?.find(
      (m: any) => m.organization.id === organizationId
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
    // Try explicit organizationId sources first
    const explicit = (
      request.params?.organizationId ||
      request.query?.organizationId ||
      request.body?.organizationId ||
      request.headers?.['x-organization-id']
    );

    if (explicit) return explicit;

    // Use currentOrganizationId set by JWT strategy
    if (request.user?.currentOrganizationId) {
      return request.user.currentOrganizationId;
    }

    // Fallback: use the user's org from JWT, but ONLY if they belong to exactly one org.
    // If they have multiple orgs, require explicit org context to prevent cross-org leaks.
    const userOrgs = request.user?.organizations;
    if (userOrgs?.length === 1) {
      return userOrgs[0].id;
    }

    return null;
  }
}