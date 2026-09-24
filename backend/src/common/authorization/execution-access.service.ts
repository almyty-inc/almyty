import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import {
  AccessDecision,
  AccessPolicyService,
  ResourceLike,
  ResourceVisibility,
  resourceOwnerId,
} from './access-policy.service';

/**
 * Team and private scope as an execution boundary.
 *
 * Visibility used to decide only what a list showed. Anyone in the org who
 * knew a team agent's or tool's id could still run it -- directly, from
 * their own agent (sub_agent, tool_call, invoke_agent), through a schedule
 * or through a gateway. "Team only is team only": this file is the one
 * place that decides whether a run may execute an agent or a tool, and
 * every executor (AgentExecutionEngine.execute, AgentRuntimeService.startRun,
 * ToolExecutorService.executeTool) asks it before doing any work.
 *
 * A run carries the scope of whoever started it -- its principal -- and
 * every nested step is authorized against that inherited principal, never
 * re-derived from the child resource. `execution-access-guard.spec.ts`
 * fails if an execution path reaches an executor without naming one.
 */

/** Where a user principal's authority came from. Recorded for the error, never used to decide. */
export type PrincipalSource =
  | 'session'
  | 'api_key'
  | 'schedule'
  | 'heartbeat'
  | 'system_gateway'
  | 'replay';

/**
 * A person: a dashboard session, an API key's owner, a JWT's subject, or
 * the agent owner a schedule or heartbeat runs as (read at fire time).
 * `userId: null` is nobody -- only org-wide resources run for nobody.
 */
export interface UserPrincipal {
  kind: 'user';
  userId: string | null;
  source: PrincipalSource;
}

/**
 * A published surface: MCP, A2A, UTCP, Skills, ACP, OpenAI-chat, a chat
 * channel, hosted chat. A gateway is reached by whoever its own auth
 * admits, not by a user this policy can check, so what it may run is
 * decided by the gateway's own scope (see canGatewayExecute).
 */
export interface GatewayPrincipal {
  kind: 'gateway';
  gatewayId: string;
  organizationId: string;
  visibility: ResourceVisibility;
  teamId: string | null;
  ownerUserId: string | null;
}

export type ExecutionPrincipal = UserPrincipal | GatewayPrincipal;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The principal for a user. Anything that is not a user id ('system', an
 * empty string) is nobody, never passed through: a made-up id must not be
 * looked up as a membership.
 */
export function userPrincipal(
  userId: string | null | undefined,
  source: PrincipalSource = 'session',
): UserPrincipal {
  return {
    kind: 'user',
    userId: typeof userId === 'string' && UUID_RE.test(userId) ? userId : null,
    source,
  };
}

export interface GatewayScopeLike {
  id: string;
  organizationId: string;
  visibility?: ResourceVisibility | null;
  teamId?: string | null;
  ownerUserId?: string | null;
  isSystem?: boolean | null;
}

/**
 * The principal for a call that arrived through `gateway`.
 *
 * The system gateway (the org's own almyty MCP endpoint) is not a
 * publication: its callers authenticate as themselves and act as
 * themselves, so its principal is the caller.
 */
export function gatewayPrincipal(
  gateway: GatewayScopeLike,
  callerUserId?: string | null,
): ExecutionPrincipal {
  if (gateway.isSystem) return userPrincipal(callerUserId ?? null, 'system_gateway');
  return {
    kind: 'gateway',
    gatewayId: gateway.id,
    organizationId: gateway.organizationId,
    visibility: gateway.visibility ?? 'org',
    teamId: gateway.visibility === 'team' ? (gateway.teamId ?? null) : null,
    ownerUserId: gateway.ownerUserId ?? null,
  };
}

/**
 * The principal a run carries. Child runs and tool calls inside the run
 * inherit this. A run row written without one is its recorded user's.
 */
export function principalOfRun(run: {
  principal?: ExecutionPrincipal | null;
  userId?: string | null;
}): ExecutionPrincipal {
  if (run.principal && (run.principal.kind === 'user' || run.principal.kind === 'gateway')) {
    return run.principal;
  }
  return userPrincipal(run.userId ?? null);
}

/** Who a principal is, in words, for a run error. */
export function describePrincipal(principal: ExecutionPrincipal): string {
  if (principal.kind === 'gateway') return `gateway ${principal.gatewayId}`;
  if (!principal.userId) return 'an anonymous caller';
  return `user ${principal.userId}`;
}

export type ExecutableKind = 'Agent' | 'Tool';

@Injectable()
export class ExecutionAccessService {
  constructor(private readonly accessPolicy: AccessPolicyService) {}

  /**
   * May `principal` execute `resource`?
   *
   * - org: any active member of the organization. With no user known at
   *   all, org-wide resources still run (and nothing else does).
   * - team: the same rule that decides whether the resource is READ --
   *   AccessPolicyService.canAccess(user, resource, 'use'): active members of
   *   the team, plus org owners and admins. Read and execute cannot disagree
   *   because they are the same call.
   * - private: the owner and nobody else, admins included.
   *
   * Gateways: see canGatewayExecute.
   */
  async canExecute(principal: ExecutionPrincipal, resource: ResourceLike): Promise<AccessDecision> {
    if (principal.kind === 'gateway') return this.canGatewayExecute(principal, resource);
    const visibility = resource.visibility ?? 'org';
    if (!principal.userId) {
      return visibility === 'org'
        ? { allowed: true, reason: 'org-wide resource' }
        : { allowed: false, reason: `${visibility} resource needs a known user` };
    }
    return this.accessPolicy.canAccess({ id: principal.userId }, resource, 'use');
  }

  /**
   * The gateway rule. A gateway is a publication: whoever its auth admits
   * gets what it serves, so what it may serve is bounded by its own scope.
   *
   * - org resource: any gateway of the same organization.
   * - team resource: a gateway scoped to that same team (the team published
   *   it), or a private gateway whose owner may execute the resource right
   *   now (team member or org owner/admin). An org-wide gateway never hands
   *   a team resource to the whole org, and another team's gateway never
   *   hands it to that team.
   * - private resource: only a gateway private to the resource's own owner.
   *
   * Evaluated on every call, so a resource moved to another team, or a
   * private gateway whose owner left the team, stops being served.
   */
  private async canGatewayExecute(principal: GatewayPrincipal, resource: ResourceLike): Promise<AccessDecision> {
    if (resource.organizationId !== principal.organizationId) {
      return { allowed: false, reason: 'resource belongs to another organization' };
    }
    const visibility = resource.visibility ?? 'org';
    if (visibility === 'org') return { allowed: true, reason: 'org-wide resource' };
    if (visibility === 'private') {
      const owner = resourceOwnerId(resource);
      return principal.visibility === 'private' && !!owner && principal.ownerUserId === owner
        ? { allowed: true, reason: 'gateway private to the resource owner' }
        : { allowed: false, reason: 'private resource on a gateway that is not private to its owner' };
    }
    if (!resource.teamId) return { allowed: false, reason: 'team-scoped resource without teamId' };
    if (principal.visibility === 'team' && principal.teamId === resource.teamId) {
      return { allowed: true, reason: 'gateway scoped to the resource team' };
    }
    if (principal.visibility === 'private' && principal.ownerUserId) {
      const decision = await this.accessPolicy.canAccess({ id: principal.ownerUserId }, resource, 'use');
      return { allowed: decision.allowed, reason: `private gateway owner: ${decision.reason}` };
    }
    return { allowed: false, reason: 'team resource on a gateway not scoped to that team' };
  }

  /**
   * Refuse with the answer a missing resource gets. 404, not 403: a 403
   * would confirm to a non-member that a team resource with that id exists.
   */
  async assertCanExecute(
    principal: ExecutionPrincipal,
    resource: ResourceLike | null | undefined,
    kind: ExecutableKind,
  ): Promise<void> {
    if (!resource) throw new NotFoundException(`${kind} not found`);
    const decision = await this.canExecute(principal, resource);
    if (!decision.allowed) throw new NotFoundException(`${kind} not found`);
  }

  /** The rows `principal` may execute, in order. For what a model is offered. */
  async filterExecutable<T extends ResourceLike>(principal: ExecutionPrincipal, rows: T[]): Promise<T[]> {
    const out: T[] = [];
    for (const row of rows) {
      if ((await this.canExecute(principal, row)).allowed) out.push(row);
    }
    return out;
  }

  /**
   * Publish-time twin of canGatewayExecute: may `gateway` serve `resource`,
   * and may `actorUserId` (who is attaching it) execute it themselves? Both
   * must hold -- nobody publishes what they could not run. A resource the
   * actor may not run is "not found"; one the actor may run but the
   * gateway's scope does not cover is a 400 that says what to change.
   */
  async assertGatewayMayServe(
    gateway: GatewayScopeLike,
    resource: ResourceLike & { name?: string | null },
    actorUserId: string,
    kind: ExecutableKind,
  ): Promise<void> {
    await this.assertCanExecute(userPrincipal(actorUserId), resource, kind);
    const decision = await this.canExecute(gatewayPrincipal(gateway, actorUserId), resource);
    if (decision.allowed) return;
    const noun = kind.toLowerCase();
    const label = resource.name ? ` '${resource.name}'` : '';
    if (resource.visibility === 'team') {
      throw new BadRequestException(
        `The ${noun}${label} is visible to its team only; it can only be served through a gateway scoped to that team ` +
          `or one private to a member of it.`,
      );
    }
    throw new BadRequestException(
      `The ${noun}${label} is private; it can only be served through a gateway that is private to its owner.`,
    );
  }
}
