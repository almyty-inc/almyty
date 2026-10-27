import { SetMetadata } from '@nestjs/common';

/**
 * The permission a route performs, in the `resource:action` vocabulary
 * custom roles (EE advanced_rbac) are written in.
 *
 * RolesGuard reads it in two places:
 *  - a custom role that grants it satisfies the route's `@Roles(...)`
 *    requirement, so a viewer holding `agents:execute` can run agents;
 *  - ABAC policies whose `action` names it are evaluated for the route.
 *
 * A route without one is reachable only by the built-in roles it lists
 * (and `role:<name>` grants). Every permission in RBAC_PERMISSION_CATALOG
 * is declared by at least one route (rbac-actions.wiring.spec.ts).
 */
export const RBAC_ACTION_KEY = 'rbac_action';

export const RbacAction = (permission: string) => SetMetadata(RBAC_ACTION_KEY, permission);

export const RBAC_PERMISSIONS = {
  AGENTS_READ: 'agents:read',
  AGENTS_CREATE: 'agents:create',
  AGENTS_UPDATE: 'agents:update',
  AGENTS_DELETE: 'agents:delete',
  AGENTS_EXECUTE: 'agents:execute',
  TOOLS_READ: 'tools:read',
  TOOLS_MANAGE: 'tools:manage',
  TOOLS_EXECUTE: 'tools:execute',
  AUDIT_READ: 'audit:read',
  AUDIT_EXPORT: 'audit:export',
} as const;

export interface RbacPermissionEntry {
  permission: string;
  description: string;
}

/**
 * Every permission a route enforces, with what it unlocks. Served to the
 * Roles settings page (GET /rbac/permissions) and listed in the
 * advanced-rbac docs; a permission outside this list gates nothing.
 */
export const RBAC_PERMISSION_CATALOG: readonly RbacPermissionEntry[] = [
  { permission: RBAC_PERMISSIONS.AGENTS_READ, description: 'See agents, their runs, versions, readiness and technical documentation' },
  { permission: RBAC_PERMISSIONS.AGENTS_CREATE, description: 'Create, import and duplicate agents' },
  { permission: RBAC_PERMISSIONS.AGENTS_UPDATE, description: 'Edit, activate, deactivate and roll back agents; change their schedule, roles and API access' },
  { permission: RBAC_PERMISSIONS.AGENTS_DELETE, description: 'Delete agents' },
  { permission: RBAC_PERMISSIONS.AGENTS_EXECUTE, description: 'Run agents, answer their questions and cancel their runs' },
  { permission: RBAC_PERMISSIONS.TOOLS_READ, description: 'See tools, their versions and stats, and export them as skills, CLIs or SDKs' },
  { permission: RBAC_PERMISSIONS.TOOLS_MANAGE, description: 'Create, edit, delete, activate, deactivate and generate tools' },
  { permission: RBAC_PERMISSIONS.TOOLS_EXECUTE, description: 'Run a tool directly' },
  { permission: RBAC_PERMISSIONS.AUDIT_READ, description: 'Read the audit trail' },
  { permission: RBAC_PERMISSIONS.AUDIT_EXPORT, description: 'Export the audit trail and manage audit streaming targets' },
];
