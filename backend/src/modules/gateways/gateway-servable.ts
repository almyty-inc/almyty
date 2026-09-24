import { Repository } from 'typeorm';

import { AgentRun } from '../../entities/agent-run.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { resourceServableThroughGateway } from './private-gateway';

/**
 * What a gateway serves: the one answer to "may this tool be listed on, or
 * called through, this gateway?".
 *
 * A gateway publishes the tools attached to it and nothing else. A tool is
 * servable on a gateway when all of these hold:
 *  - it has an active `gateway_tools` row on that gateway;
 *  - the tool itself is active;
 *  - its scope fits the gateway's (`resourceServableThroughGateway`): a
 *    private tool only on its owner's private gateway, a team tool only on
 *    a gateway of that team or a private one.
 *
 * Every protocol builds its listing and resolves its calls from here, so
 * what a client is shown and what it can run cannot drift apart: a call
 * naming a tool that is not listed gets the protocol's "not found", exactly
 * like a tool that does not exist. The per-caller part of the rule (team
 * membership, re-checked on every call) is ExecutionAccessService's, in the
 * executor, which also re-asks this module for every call that arrives
 * through a gateway.
 *
 * `gateway-servable.guard.spec.ts` holds every executor call site to this.
 */
export interface ServableGatewayToolsFilter {
  /** Only this tool's row (a call resolving one tool by id). */
  toolId?: string;
}

type GatewayToolFinder = Pick<Repository<GatewayTool>, 'find'>;

/** The pure predicate, for a row whose tool and gateway are loaded on it. */
export function isServableGatewayTool(row: GatewayTool | null | undefined): row is GatewayTool {
  if (!row?.isActive || !row.tool || !row.gateway) return false;
  if (row.tool.status !== ToolStatus.ACTIVE) return false;
  return resourceServableThroughGateway(row.gateway, row.tool);
}

/**
 * The gateway's servable rows, each carrying its `tool` and `gateway`.
 * `toolRelations` loads more of the tool where a caller renders it.
 */
export async function servableGatewayTools(
  gatewayTools: GatewayToolFinder,
  gatewayId: string,
  filter: ServableGatewayToolsFilter = {},
  toolRelations: Record<string, any> | true = true,
): Promise<GatewayTool[]> {
  const rows = await gatewayTools.find({
    where: { gatewayId, isActive: true, ...(filter.toolId ? { toolId: filter.toolId } : {}) },
    relations: { tool: toolRelations, gateway: true },
  });
  return rows.filter(isServableGatewayTool);
}

/** The servable tools themselves, in listing order. */
export async function servableToolsOnGateway(
  gatewayTools: GatewayToolFinder,
  gatewayId: string,
  toolRelations: Record<string, any> | true = true,
): Promise<Tool[]> {
  return (await servableGatewayTools(gatewayTools, gatewayId, {}, toolRelations)).map((row) => row.tool);
}

/** One servable row by tool id, or null when the gateway does not serve it. */
export async function findServableGatewayTool(
  gatewayTools: GatewayToolFinder,
  gatewayId: string,
  toolId: string,
): Promise<GatewayTool | null> {
  if (!gatewayId || !toolId) return null;
  const [row] = await servableGatewayTools(gatewayTools, gatewayId, { toolId });
  return row ?? null;
}
/**
 * What an agent gateway (A2A, ACP) serves: its one agent. A run a client
 * names -- by task id, session id or context/conversation id -- is this
 * gateway's only when it is a run of that agent in the gateway's
 * organization. Anything else (another agent's run, however the client
 * learned its id) is not found: reading it would disclose another agent's
 * conversation, and resuming or cancelling it would act on an agent the
 * gateway never published.
 */
export interface AgentGatewayLike {
  organizationId: string;
  agentId?: string | null;
}

type AgentRunFinder = Pick<Repository<AgentRun>, 'findOne'>;

export async function findGatewayRun(
  runs: AgentRunFinder,
  gateway: AgentGatewayLike,
  by: { id: string } | { conversationId: string },
): Promise<AgentRun | null> {
  if (!gateway?.agentId || !gateway.organizationId) return null;
  const key = 'id' in by ? by.id : by.conversationId;
  if (typeof key !== 'string' || !key) return null;
  return runs.findOne({
    where: { ...by, organizationId: gateway.organizationId, agentId: gateway.agentId },
    ...('conversationId' in by ? { order: { createdAt: 'DESC' as const } } : {}),
  });
}
