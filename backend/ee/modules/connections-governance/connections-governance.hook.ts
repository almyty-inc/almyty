import { ForbiddenException, Injectable } from '@nestjs/common';

import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { ConnectionsGovernanceService } from './connections-governance.service';
import { GovernedConnection, PolicyDecision, UsePrincipal } from './policy-evaluator';
import { ConnectionsGovernanceHook, GovernanceUseContext } from './seams';

/**
 * The runtime hook core consults, `@Optional()`, under the
 * `CONNECTIONS_GOVERNANCE_HOOK` token. Entitlement is checked per org
 * at call time: an org without `connections_governance` gets exactly
 * the community behaviour, whatever policies its rows hold.
 *
 * TODO(lead): call sites in core, both `@Optional() @Inject(CONNECTIONS_GOVERNANCE_HOOK)`:
 * - `ConnectionsService.connect` / `rotate`, before the row is written:
 *   `await this.governance?.beforeConnect(organizationId, connector.key, owner)`
 * - `ConnectionsResolverService.resolveForUse`, after
 *   `const decision = await this.grants.assertCanUse(principal, row, context)`
 *   and before `materialize` / `recordResolve`:
 *   `await this.governance?.beforeUse(row.organizationId, row, { userId: principal.id, ...context }, context, decision)`
 */
@Injectable()
export class ConnectionsGovernanceHookImpl implements ConnectionsGovernanceHook {
  constructor(
    private readonly governance: ConnectionsGovernanceService,
    private readonly licenses: OrgLicenseResolver,
  ) {}

  private async licensed(organizationId: string): Promise<boolean> {
    try {
      return await this.licenses.hasForOrg(organizationId, EE_ENTITLEMENTS.CONNECTIONS_GOVERNANCE);
    } catch {
      return false;
    }
  }

  async beforeConnect(organizationId: string, connectorKey: string, owner: 'org' | 'user'): Promise<void> {
    if (!(await this.licensed(organizationId))) return;
    const decision = await this.governance.decideConnect(organizationId, connectorKey, owner);
    if (!decision.allowed) throw denied(decision, { connectorKey, owner });
  }

  async evaluateUse(organizationId: string, connection: GovernedConnection, principal: UsePrincipal, context: GovernanceUseContext = {}): Promise<PolicyDecision> {
    if (!(await this.licensed(organizationId))) return { allowed: true, reason: 'connections governance is not licensed for this organization' };
    return this.governance.decideUse(organizationId, connection, principal, context);
  }

  async beforeUse(
    organizationId: string,
    connection: GovernedConnection,
    principal: UsePrincipal,
    context: GovernanceUseContext = {},
    decision?: { via?: string | null; grant?: { id?: string; principalType?: string; budgetId?: string | null } | null },
  ): Promise<void> {
    if (!(await this.licensed(organizationId))) return;
    const ctx: GovernanceUseContext = { ...context };
    if (!ctx.via && decision?.grant?.principalType) ctx.via = { principalType: decision.grant.principalType };
    const verdict = await this.governance.decideUse(organizationId, connection, principal, ctx);
    if (!verdict.allowed) throw denied(verdict, { connectionId: connection.id });
    if (decision?.via === 'grant' && decision.grant?.budgetId) {
      await this.governance.assertBudget(organizationId, decision.grant.budgetId, ctx.agentId ?? principal.agentId ?? null);
    }
  }
}

function denied(decision: PolicyDecision, extra: Record<string, unknown>): ForbiddenException {
  return new ForbiddenException({
    code: 'CONNECTION_POLICY_DENIED',
    message: `refused by a connection policy: ${decision.reason}`,
    reason: decision.reason,
    policyId: decision.policyId ?? null,
    ...extra,
  });
}
