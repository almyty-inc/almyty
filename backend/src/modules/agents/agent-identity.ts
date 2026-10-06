import { BadRequestException, Injectable, Optional } from '@nestjs/common';

import {
  AgentScopeLike,
  ExecutionPrincipal,
  PrincipalSource,
  agentPrincipal,
  userPrincipal,
} from '../../common/authorization/execution-access.service';
import type { AgentPauseReason } from '../../entities/agent.entity';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';
import { OrgLicenseResolver } from '../licensing/org-license.resolver';
import { agentOwnerUserId } from './agent-owner';

/**
 * Who an agent's unattended runs act as (docs/design/hosted-runners-and-always-on.md,
 * decision 11): its owner, as always, or the agent itself.
 *
 * Acting as itself, the agent is an `agent` execution principal: it uses
 * the connections granted to it and no one else's (its owner's personal
 * and private ones included), it runs what its own scope reaches, and the
 * audit rows its runs write name it as the actor. It is the Business
 * entitlement `agent_identity`; set per agent as `agentConfig.runAs`.
 *
 * An agent set to act as itself never falls back to its owner: when the
 * organization no longer has the entitlement, its unattended runs are
 * paused with IDENTITY_LAPSED instead (resolveUnattendedPrincipal).
 */
export const AGENT_RUN_AS = ['owner', 'agent'] as const;
export type AgentRunAs = (typeof AGENT_RUN_AS)[number];

/** What a save hears when it turns this on without the plan. */
export const AGENT_IDENTITY_NOT_INCLUDED =
  'An agent that acts as itself is part of the Business plan. Upgrade, or leave it acting as its owner.';

/** Why an agent that acts as itself was paused when the plan no longer includes it. */
export const AGENT_IDENTITY_LAPSED_MESSAGE =
  'This agent acts as itself, which needs the Business plan. It was paused instead of running as you.';

/** Problems with a saved `runAs`, in words. */
export function runAsProblems(agentConfig: unknown): string[] {
  if (!agentConfig || typeof agentConfig !== 'object') return [];
  const runAs = (agentConfig as Record<string, unknown>).runAs;
  if (runAs === undefined || runAs === null) return [];
  return (AGENT_RUN_AS as readonly unknown[]).includes(runAs)
    ? []
    : ["Who the agent acts as must be 'owner' or 'agent'"];
}

/** Does the agent ask to act as itself? */
export function actsAsItself(agent: { agentConfig?: { runAs?: string | null } | null }): boolean {
  return agent.agentConfig?.runAs === 'agent';
}

/** Who an unattended run acts as, or why it may not run at all. */
export type UnattendedResolution =
  | { principal: ExecutionPrincipal }
  | { lapsed: true; reason: AgentPauseReason };

/** Narrows an UnattendedResolution to the lapsed case. */
export function isLapsed(r: UnattendedResolution): r is { lapsed: true; reason: AgentPauseReason } {
  return 'lapsed' in r && r.lapsed === true;
}

/**
 * Who an unattended run of `agent` acts as. An agent that acts as itself
 * is its own principal while the organization has `agent_identity`, and is
 * reported lapsed (never run as its owner) when it has not. Any other agent
 * runs as its owner as the row stands now (agentOwnerUserId).
 */
export function resolveUnattendedPrincipal(
  agent: AgentScopeLike & { agentConfig?: { runAs?: string | null } | null },
  licensed: boolean,
  source: PrincipalSource,
  now: Date = new Date(),
): UnattendedResolution {
  if (!actsAsItself(agent)) return { principal: userPrincipal(agentOwnerUserId(agent), source) };
  if (licensed) return { principal: agentPrincipal(agent) };
  return {
    lapsed: true,
    reason: { code: 'IDENTITY_LAPSED', message: AGENT_IDENTITY_LAPSED_MESSAGE, detectedAt: now.toISOString() },
  };
}

/**
 * The user a run row records for `principal`: the person for a user
 * principal, nobody for an agent acting as itself (it is not a person, and
 * a run's user is what memory, conversations and audit rows are filed under).
 */
export function runUserOf(principal: ExecutionPrincipal): string | null {
  return principal.kind === 'user' ? principal.userId : null;
}

/** Reads the entitlement for an organization; fails closed. */
@Injectable()
export class AgentIdentityService {
  constructor(@Optional() private readonly licenses?: OrgLicenseResolver) {}

  async licensed(organizationId: string): Promise<boolean> {
    if (!this.licenses) return false;
    return this.licenses.hasForOrg(organizationId, EE_ENTITLEMENTS.AGENT_IDENTITY).catch(() => false);
  }

  /** resolveUnattendedPrincipal with the organization's entitlement read for you. */
  async resolve(
    agent: AgentScopeLike & { agentConfig?: { runAs?: string | null } | null },
    source: PrincipalSource,
  ): Promise<UnattendedResolution> {
    const licensed = actsAsItself(agent) ? await this.licensed(agent.organizationId) : false;
    return resolveUnattendedPrincipal(agent, licensed, source);
  }

  /**
   * Refuse a save that turns acting-as-itself on without the plan. One that
   * was already on is left alone, so an agent saved before a downgrade can
   * still be edited (its unattended runs stay paused until the plan includes
   * it again or it is switched back to its owner).
   */
  async assertMaySave(
    organizationId: string,
    agentConfig: { runAs?: string | null } | null | undefined,
    previous?: { runAs?: string | null } | null,
  ): Promise<void> {
    if (agentConfig?.runAs !== 'agent' || previous?.runAs === 'agent') return;
    if (!(await this.licensed(organizationId))) throw new BadRequestException(AGENT_IDENTITY_NOT_INCLUDED);
  }
}
