import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { Gateway } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { collectAgentReferences } from '../../modules/agents/agent-references';
import { AccessPolicyService, ResourceLike } from './access-policy.service';

/**
 * Who would lose a tool or agent if its owner made it private.
 *
 * A private tool or agent may only be referenced by the same owner's own
 * private agents (assertAttachable), and gateways serve a private tool only
 * when the gateway is private to the same owner (servableOnGateway). So
 * flipping a shared tool or agent to "just me" silently detaches it from
 * every org or team agent that uses it -- they fail at run time -- and from
 * every shared gateway that serves it.
 *
 * The decision: refuse the change and say who depends on it, the same
 * answer attaching a private resource to a shared one already gets. The
 * owner removes it from those first, or keeps it shared.
 *
 * Another member's private agent or gateway is not counted and not
 * named: telling the owner it exists would be the leak the tier prevents.
 * It fails at run time like any agent whose tool was deleted.
 */
export async function findSharedDependents(
  manager: EntityManager,
  target: { kind: 'tool' | 'agent'; id: string; organizationId: string },
): Promise<Array<ResourceLike & { id: string; name: string; noun: 'agent' | 'gateway' }>> {
  // A private dependent is either the owner's own (still allowed to
  // reference the private resource) or another member's (not ours to
  // know about). Only shared ones would break.
  const keeps = (row: ResourceLike) => row.visibility !== 'private';
  const agents = await manager.getRepository(Agent).find({
    where: { organizationId: target.organizationId, isTemporary: false },
    select: {
      id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true,
      toolIds: true, pipeline: true, collaboration: true,
    },
  });
  const dependents: Array<ResourceLike & { id: string; name: string; noun: 'agent' | 'gateway' }> = [];
  for (const agent of agents) {
    if (agent.id === target.id) continue;
    const refs = collectAgentReferences(agent);
    const uses = target.kind === 'tool' ? refs.toolIds.has(target.id) : refs.agentIds.has(target.id);
    if (uses && keeps(agent)) {
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
      if (keeps(gateway)) dependents.push({ ...pick(gateway), noun: 'gateway' });
    }
  }
  return dependents;
}

/**
 * Refuse making a resource private while shared agents or gateways use it
 * (or, for an API, use the tools that go private with it). Dependents the
 * caller can see are named; the rest (team resources of a team the caller
 * is not on) are only counted.
 */
export async function assertNoSharedDependents(
  manager: EntityManager,
  accessPolicy: AccessPolicyService,
  args: {
    noun: string;
    organizationId: string;
    targets: Array<{ kind: 'tool' | 'agent'; id: string }>;
  },
  callerId: string,
): Promise<void> {
  const seen = new Set<string>();
  const dependents: Awaited<ReturnType<typeof findSharedDependents>> = [];
  for (const target of args.targets) {
    for (const d of await findSharedDependents(manager, { ...target, organizationId: args.organizationId })) {
      const key = `${d.noun}:${d.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dependents.push(d);
    }
  }
  if (dependents.length === 0) return;
  const visible = await accessPolicy.filterVisible({ id: callerId }, args.organizationId, dependents);
  const named = visible.map((d) => `${d.noun} "${d.name}"`);
  const unnamed = dependents.length - visible.length;
  const list = named.join(', ') + (unnamed > 0 ? `${named.length ? ' and ' : ''}${unnamed} more you cannot see` : '');
  const one = dependents.length === 1;
  throw new ConflictException(
    `Making this ${args.noun} private would take it away from ${list}, which other people can use. ` +
      `Remove it from ${one ? 'that' : 'those'} first, or keep the ${args.noun} shared.`,
  );
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
