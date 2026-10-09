import { ForbiddenException, Injectable } from '@nestjs/common';

import { ConnectionUseDecision, ConnectionUseInput, ConnectionUsePolicy } from '../../credentials/credential-ref.resolver';
import { GrantPrincipal } from './grant-check';
import { GrantsService } from './grants.service';

/**
 * Gate 2 behind the consumer seam: when a consumer (LLM call, MCP call,
 * channel, API test, a deploy) resolves a credential that is a shared
 * connection, the caller must hold a grant.
 *
 * Rows a consumer manages for itself (metadata.managedBy) and plain
 * credentials are not connections and pass.
 *
 * Who the caller is:
 * - a user (a session, the user a run acts for, the owner of a gateway
 *   private to them): that user's grants, roles and teams.
 * - a run through any other gateway: the gateway. It has no user, but it
 *   is not the system either -- whoever its auth admits is behind it. It
 *   holds what a grant to its team (for a team gateway), to the run's
 *   agent or to its workspace gives, and nothing a role or a user grant
 *   gives. The resolver has already applied the team rule, so a team
 *   connection reaches only a gateway of that team.
 * - an agent acting as itself (agent_identity): the agent. No user, no
 *   role, no owner, no team: only a grant to that agent lets it use a
 *   connection. Its owner's personal and private connections stay out of
 *   reach.
 * - nobody (a scheduler, the reconcile loop): a system path. It may use an
 *   organization connection, never someone's personal one, because there
 *   is no one whose grant could be checked.
 *
 * Returns how the use was allowed, so org governance can apply the budget
 * on the grant that allowed it.
 */
@Injectable()
export class GrantsUsePolicy implements ConnectionUsePolicy {
  constructor(private readonly grants: GrantsService) {}

  async assertCanUse(input: ConnectionUseInput): Promise<void | ConnectionUseDecision> {
    const { credential, principal, context, execution } = input;
    if (!credential.connectorKey) return;
    if ((credential.metadata as Record<string, any> | null | undefined)?.managedBy) return;
    const useContext = { purpose: context?.purpose, resourceType: context?.resourceType, resourceId: context?.resourceId };
    if (principal?.id) {
      return this.grants.assertCanUse(
        { id: principal.id, organizationIds: principal.organizationIds } as any,
        credential,
        useContext,
      );
    }
    if (execution?.kind === 'gateway') {
      // The gateway's own channel key -- the Slack app, the Resend key it
      // was set up with -- used to talk to its own platform. The resolver
      // has applied the team and private rules already; an organization
      // connection serves the channel it is attached to, as it did before
      // runs were judged as their gateway. Without this every org channel
      // whose key lives on Credentials refused its own inbound events and
      // could post nothing, and no grant could fix it: a grant cannot name
      // a gateway.
      if (!credential.ownerUserId && context?.resourceType === 'gateway' && context.resourceId === execution.gatewayId) return;
      // Otherwise the gateway holds what was granted to the run's agent: a
      // channel message from someone other than the owner acts for nobody,
      // and the agent's own grants decide what it may reach.
      return this.grants.assertCanUse(GrantsUsePolicy.gatewayGrantPrincipal(execution), credential, {
        ...useContext,
        ...(context?.agentId ? { agentId: context.agentId } : {}),
      });
    }
    // An agent acting as itself: the grants made to that agent, and only
    // those. The agent named by the call's context cannot stand in for it,
    // so its own id is pinned.
    if (execution?.kind === 'agent') {
      return this.grants.assertCanUse(GrantsUsePolicy.agentGrantPrincipal(execution), credential, {
        ...useContext,
        agentId: execution.agentId,
      });
    }
    if (credential.ownerUserId) {
      throw new ForbiddenException({
        code: 'CONNECTION_NOT_GRANTED',
        message: 'a personal connection cannot be used by a system path; re-create it as an organization connection or record the acting user',
        connectionId: credential.id,
      });
    }
  }

  /**
   * A gateway as the grant check sees it: no user (the id names the
   * gateway and matches no user grant or owner), no role, and its team
   * when it is scoped to one.
   */
  static gatewayGrantPrincipal(gateway: { gatewayId: string; visibility: string; teamId: string | null }): GrantPrincipal {
    return {
      userId: `gateway:${gateway.gatewayId}`,
      roles: [],
      permissions: [],
      teamIds: gateway.visibility === 'team' && gateway.teamId ? [gateway.teamId] : [],
    };
  }

  /**
   * An agent acting as itself, as the grant check sees it: no user (the id
   * names the agent and matches no user grant or owner), no role, no team
   * (a team agent is not a member of its team), and itself as the agent a
   * grant may name.
   */
  static agentGrantPrincipal(agent: { agentId: string; visibility: string; teamId: string | null }): GrantPrincipal {
    return {
      userId: `agent:${agent.agentId}`,
      roles: [],
      permissions: [],
      // Not its team's: a team agent is no member of the team (Frane, 2026-10-06).
      teamIds: [],
      agentId: agent.agentId,
    };
  }
}
