import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Team } from '../../entities/team.entity';
import { collectAgentReferences } from '../../modules/agents/agent-references';
import { AccessPolicyService, ResourceLike, ResourceVisibility, normaliseVisibility } from './access-policy.service';

/**
 * Who would lose a tool or agent if its scope narrowed.
 *
 * A private tool or agent may only be referenced by the same owner's own
 * private agents (assertAttachable), and gateways serve a private tool only
 * when the gateway is private to the same owner (gateway-servable). A team
 * one is usable only by that team's agents and gateways. So narrowing a
 * shared tool or agent -- to "just me", to a team, or from one team to
 * another -- silently detaches it from every agent and gateway outside the
 * new scope that uses it: they fail at run time.
 *
 * The decision: refuse the change and say who depends on it, the same
 * answer attaching a narrower resource to a wider one already gets. The
 * owner narrows those first, removes it from them, or keeps the scope.
 *
 * Another member's private agent or gateway is not counted and not
 * named: telling the caller it exists would be the leak the tier prevents.
 * It fails at run time like any agent whose tool was deleted.
 */

/** A scope a resource moves into. */
export interface TargetScope {
  visibility: ResourceVisibility;
  teamId: string | null;
}

const PRIVATE: TargetScope = { visibility: 'private', teamId: null };

/**
 * True when moving from `from` to `to` takes the resource away from someone
 * who could use it: org or team to private, org to a team, or one team to
 * another. Widening, and re-saving the scope a row already has, are not.
 */
export function narrowsScope(
  from: { visibility?: ResourceVisibility | null; teamId?: string | null },
  to: { visibility?: ResourceVisibility | null; teamId?: string | null },
): boolean {
  const before = normaliseVisibility(from.visibility, from.teamId);
  const after = normaliseVisibility(to.visibility, to.teamId);
  if (before.visibility === 'private') return false;
  if (after.visibility === 'private') return true;
  if (after.visibility === 'team') return before.visibility === 'org' || before.teamId !== after.teamId;
  return false;
}

/** Whether a shared dependent can still use a resource that moved into `into`. */
function stillReaches(row: ResourceLike, into: TargetScope): boolean {
  if (into.visibility === 'org') return true;
  if (into.visibility === 'team') return row.visibility === 'team' && row.teamId === into.teamId;
  return false;
}

type Dependent = ResourceLike & { id: string; name: string; noun: 'agent' | 'gateway' };

export async function findSharedDependents(
  manager: EntityManager,
  target: { kind: 'tool' | 'agent'; id: string; organizationId: string },
  into: TargetScope = PRIVATE,
): Promise<Dependent[]> {
  // A private dependent is either the owner's own (still allowed to
  // reference a private resource) or another member's (not ours to know
  // about). Only shared ones outside the new scope would break.
  const breaks = (row: ResourceLike) => row.visibility !== 'private' && !stillReaches(row, into);
  const agents = await manager.getRepository(Agent).find({
    where: { organizationId: target.organizationId, isTemporary: false },
    select: {
      id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true,
      toolIds: true, pipeline: true, collaboration: true, models: true,
    },
  });
  const dependents: Dependent[] = [];
  for (const agent of agents) {
    if (agent.id === target.id) continue;
    const refs = collectAgentReferences(agent);
    const uses = target.kind === 'tool' ? refs.toolIds.has(target.id) : refs.agentIds.has(target.id);
    if (uses && breaks(agent)) {
      dependents.push({ ...pick(agent), noun: 'agent' });
    }
  }
  if (target.kind === 'tool') {
    const gateways = await manager
      .getRepository(Gateway)
      .createQueryBuilder('gw')
      .innerJoin(GatewayTool, 'gt', 'gt.gatewayId = gw.id')
      .where('gt.toolId = :toolId', { toolId: target.id })
      .andWhere('gw.organizationId = :organizationId', { organizationId: target.organizationId })
      .andWhere('gw.isSystem = false')
      .select(['gw.id', 'gw.name', 'gw.organizationId', 'gw.visibility', 'gw.teamId', 'gw.ownerUserId'])
      .getMany();
    for (const gateway of gateways) {
      if (breaks(gateway)) dependents.push({ ...pick(gateway), noun: 'gateway' });
    }
  }
  return dependents;
}

/**
 * Refuse narrowing a resource while agents or gateways outside its new
 * scope use it (or, for an API, use the tools that move with it).
 * Dependents the caller can see are named; the rest (team resources of a
 * team the caller is not on) are only counted.
 */
export async function assertNoSharedDependents(
  manager: EntityManager,
  accessPolicy: AccessPolicyService,
  args: {
    noun: string;
    organizationId: string;
    targets: Array<{ kind: 'tool' | 'agent'; id: string }>;
    /** The scope the targets move into; private when omitted. */
    into?: TargetScope;
  },
  callerId: string,
): Promise<void> {
  const into = args.into ?? PRIVATE;
  const seen = new Set<string>();
  const dependents: Dependent[] = [];
  for (const target of args.targets) {
    for (const d of await findSharedDependents(manager, { ...target, organizationId: args.organizationId }, into)) {
      const key = `${d.noun}:${d.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependents.push(d);
    }
  }
  if (dependents.length === 0) return;
  const visible = await accessPolicy.filterVisible({ id: callerId }, args.organizationId, dependents);
  const one = dependents.length === 1;

  if (into.visibility !== 'team') {
    const named = visible.map((d) => `${d.noun} "${d.name}"`);
    throw new ConflictException(
      `Making this ${args.noun} private would take it away from ${listed(named, dependents.length - visible.length)}, ` +
        `which other people can use. Remove it from ${one ? 'that' : 'those'} first, or keep the ${args.noun} shared.`,
    );
  }

  // Narrowing to a team: say where each one is, so the fix is obvious.
  const team = into.teamId
    ? await manager.getRepository(Team).findOne({ where: { id: into.teamId, organizationId: args.organizationId }, select: { name: true } })
    : null;
  const named = visible.map((d) => `${d.noun} "${d.name}" (${d.visibility === 'team' ? 'another team' : 'org-wide'})`);
  // An API's tools move with it; for a tool or agent it is the row itself.
  const isApi = args.noun === 'API';
  const what = isApi ? 'its tools' : 'it';
  const them = one ? 'it' : 'them';
  throw new ConflictException(
    `Narrowing this ${args.noun} to team ${team ? `"${team.name}"` : 'the team'} would take ${what} away from ` +
      `${listed(named, dependents.length - visible.length)}. Narrow ${them} to that team first, ` +
      `or remove the ${isApi ? 'tools' : args.noun} from ${them}.`,
  );
}

/** "a", "a and b", "a, b and c", with the ones the caller cannot see counted at the end. */
function listed(named: string[], unnamed: number): string {
  const items = unnamed > 0 ? [...named, `${unnamed} more you cannot see`] : named;
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function pick(row: ResourceLike & { id: string; name: string }): ResourceLike & { id: string; name: string } {
  return {
    id: row.id,
    name: row.name,
    organizationId: row.organizationId,
    visibility: row.visibility,
    teamId: row.teamId,
    ownerUserId: row.ownerUserId,
    createdBy: row.createdBy,
  };
}
