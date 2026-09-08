import { Injectable } from '@nestjs/common';

import type { ScopePrincipalKind } from '../../../src/entities/connection-policy.entity';
import type { GovernedConnection, PolicyDecision, UseContext, UsePrincipal } from './policy-evaluator';

/**
 * The seams between this module and core. Each is an injection token
 * plus an interface; the module binds a default so it boots on its own,
 * and the lead swaps the real core service in with one provider line.
 */

// ── Rotation (gate 5: RotationService) ────────────────────────────

export const CONNECTION_ROTATOR = 'EE_CONNECTION_ROTATOR';

export interface RotationOutcome {
  rotated: boolean;
  /** The connector has no provider-side rotation; the owner was told to rotate by hand. */
  manual?: boolean;
  error?: string;
}

export interface ConnectionRotator {
  rotate(connectionId: string): Promise<RotationOutcome>;
  /** Whether the connector can be rotated through its provider API. Optional; the catalog's `capabilities` is consulted too. */
  canRotate?(connectorKey: string): boolean | Promise<boolean>;
}

/**
 * Default until gate 5's RotationService is wired:
 * `{ provide: CONNECTION_ROTATOR, useExisting: RotationService }`.
 * Nothing is rotated; every due connection is reported as manual.
 */
@Injectable()
export class NoopConnectionRotator implements ConnectionRotator {
  async rotate(): Promise<RotationOutcome> {
    return { rotated: false, manual: true };
  }

  canRotate(): boolean {
    return false;
  }
}

// ── Grants (gate 2: GrantsService) ─────────────────────────────────

export const CONNECTION_GRANT_REVOKER = 'EE_CONNECTION_GRANT_REVOKER';

/**
 * The slice of gate 2's GrantsService this module calls. Wire with
 * `{ provide: CONNECTION_GRANT_REVOKER, useExisting: GrantsService }`
 * (its `revoke(grantId, actor, organizationId)` and `invalidate` match).
 * Without it the service removes grant rows directly and writes the
 * same audit event.
 */
export interface ConnectionGrantRevoker {
  revoke(grantId: string, actor: { id: string }, organizationId?: string): Promise<unknown>;
  invalidate?(connectionId: string): void;
}

// ── Principals (core principal builder) ────────────────────────────

export const CONNECTION_PRINCIPAL_SOURCE = 'EE_CONNECTION_PRINCIPAL_SOURCE';

export interface UserPrincipals {
  /** Active teams of the user in the organization; SCIM groups are teams. */
  teamIds: string[];
  /** Org role names the user holds (`owner`, `admin`, `member`, `viewer`). */
  roles: string[];
}

export interface ConnectionPrincipalSource {
  principalsFor(user: { id: string }, organizationId: string): Promise<UserPrincipals>;
}

// ── Policy hook (core resolver seam) ───────────────────────────────

export { CONNECTIONS_GOVERNANCE_HOOK } from '../../../src/common/ee-hooks/ee-hooks';

export interface GovernanceUseContext extends UseContext {
  purpose?: string;
  resourceType?: string;
  resourceId?: string;
  runId?: string;
}

/**
 * What core calls, `@Optional()`, from `ConnectionsService.connect` /
 * `rotate` (`beforeConnect`) and from
 * `ConnectionsResolverService.resolveForUse` right after the grant
 * check and before the audit row (`beforeUse`). Both throw a
 * ForbiddenException with `code: CONNECTION_POLICY_DENIED` to refuse
 * and return normally otherwise. Unlicensed orgs are never refused.
 */
export interface ConnectionsGovernanceHook {
  beforeConnect(organizationId: string, connectorKey: string, owner: 'org' | 'user'): Promise<void>;
  beforeUse(
    organizationId: string,
    connection: GovernedConnection,
    principal: UsePrincipal,
    context?: GovernanceUseContext,
    decision?: { via?: string | null; grant?: { id?: string; principalType?: string; budgetId?: string | null } | null },
  ): Promise<void>;
  /** The decision without throwing, for callers that want to log it. */
  evaluateUse(organizationId: string, connection: GovernedConnection, principal: UsePrincipal, context?: GovernanceUseContext): Promise<PolicyDecision>;
}

export type { ScopePrincipalKind };
