import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentRole, RoleBinding } from '../../entities/agent-role.entity';
import { ModelRouterService } from '../model-catalog/routing/model-router.service';
import { RoutingPolicy } from '../model-catalog/routing/model-router';
import type { ActingAs } from '../../common/authorization/execution-access.service';

/**
 * Resolving an agent's roles to concrete models for one run.
 *
 * The rule that shapes this file: **a pinned binding never touches L3.**
 * Roles are usable with routing switched off entirely, so the router is
 * optional here and a pinned role resolves without it being present at
 * all. See docs/design/layers.md, L4.
 */

/** What one role resolved to, recorded so a run always names its models. */
export interface ResolvedRole {
  key: string;
  displayName: string;
  modelId: string;
  /** How it was chosen, for the run record and the route trace. */
  via: 'pinned' | 'resolved';
  /** Why the router chose it. Absent for a pinned role: there was no choice. */
  rationale?: string;
}

export class RoleUnresolvedError extends Error {
  readonly code = 'ROLE_UNRESOLVED';
  constructor(
    readonly roleKey: string,
    reason: string,
  ) {
    super(`Role "${roleKey}" could not be filled: ${reason}`);
    this.name = 'RoleUnresolvedError';
  }
}

@Injectable()
export class AgentRolesService {
  constructor(
    @InjectRepository(AgentRole) private readonly roles: Repository<AgentRole>,
    /**
     * Optional on purpose. An install that never routes still resolves
     * pinned roles, and a missing router must not be an error until
     * something actually asks to be resolved.
     */
    @Optional() private readonly router?: ModelRouterService,
  ) {}

  async list(organizationId: string, agentId: string): Promise<AgentRole[]> {
    return this.roles.find({ where: { organizationId, agentId }, order: { key: 'ASC' } });
  }

  /**
   * Fill every role for one run.
   *
   * `overrides` lets a single run pin a role without editing the agent,
   * which is how you try a model on a real task without committing to it.
   */
  async resolveRoles(
    organizationId: string,
    agentId: string,
    overrides: Record<string, string> = {},
    principal?: ActingAs,
  ): Promise<ResolvedRole[]> {
    const roles = await this.list(organizationId, agentId);
    const out: ResolvedRole[] = [];
    for (const role of roles) {
      const override = overrides[role.key];
      if (override) {
        out.push({ key: role.key, displayName: role.displayName, modelId: override, via: 'pinned' });
        continue;
      }
      out.push(await this.resolveOne(organizationId, role, principal));
    }
    return out;
  }

  private async resolveOne(
    organizationId: string,
    role: AgentRole,
    principal?: ActingAs,
  ): Promise<ResolvedRole> {
    const binding: RoleBinding = role.binding;
    if (binding?.mode === 'pinned') {
      if (!binding.modelId) throw new RoleUnresolvedError(role.key, 'pinned to no model');
      // Deliberately no router call, no catalog read, no policy. A pinned
      // role is a fact, and treating it as a one-candidate routing problem
      // is how routing becomes impossible to switch off.
      return { key: role.key, displayName: role.displayName, modelId: binding.modelId, via: 'pinned' };
    }

    if (!this.router) {
      throw new RoleUnresolvedError(role.key, 'it asks to be resolved but routing is not available on this install');
    }

    const policy = { ...(binding?.policy ?? {}), ...requirementToPolicy(role) } as RoutingPolicy;
    const plan = await this.router.plan(organizationId, policy, principal);
    const first = plan.candidates[0];
    if (!first) {
      const why = plan.rejected.length
        ? `no model satisfied it (${plan.rejected.length} rejected: ${plan.rejected.slice(0, 3).map((r) => `${r.modelId} ${r.reason}`).join('; ')})`
        : 'no models are registered for this organization';
      throw new RoleUnresolvedError(role.key, why);
    }
    return {
      key: role.key,
      displayName: role.displayName,
      modelId: first.modelId,
      via: 'resolved',
      rationale: first.rationale,
    };
  }
}

/**
 * A role's requirement expressed as the routing policy fields L3 already
 * understands. The requirement is the durable statement of what the job
 * needs; the policy is how this layer asks for it.
 *
 * **Every field of RoleRequirement must appear here.** Three of them
 * (minContext, maxBlendedPrice, tags) were declared on the entity, written
 * by the API and read by nothing: a role saying "at least 200k context"
 * resolved to a 4k card without complaint. A field the requirement can
 * carry and this function drops is a setting that silently does nothing,
 * so requirement-fields-reach-the-router.guard.spec.ts fails the build
 * when the two lists diverge.
 */
export function requirementToPolicy(role: Pick<AgentRole, 'requirement'>): Partial<RoutingPolicy> {
  const r = role.requirement ?? {};
  const policy: Partial<RoutingPolicy> = {};
  if (r.capabilities) policy.capabilities = r.capabilities as RoutingPolicy['capabilities'];
  if (r.privacyTierCeiling) policy.privacyTier = r.privacyTierCeiling as RoutingPolicy['privacyTier'];
  if (r.region) policy.regions = [r.region];
  if (r.minContext != null) policy.minContextLength = r.minContext;
  if (r.maxBlendedPrice != null) policy.maxBlendedPricePerMTok = r.maxBlendedPrice;
  return policy;
}
