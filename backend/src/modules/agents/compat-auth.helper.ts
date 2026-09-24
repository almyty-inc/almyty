import { BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { ApiKey } from '../../entities/api-key.entity';
import { Agent } from '../../entities/agent.entity';
import { hasEffectiveMembership } from '../../common/authorization/membership';
import type { AgentsService } from './agents.service';

/**
 * Authentication and agent resolution for the OpenAI- and
 * Anthropic-compatible endpoints, in one place so the two cannot differ.
 *
 * Both controllers looked a key up by hash and checked only that it was
 * active and unexpired, so every key ApiKeyStrategy refuses on the
 * platform API worked here: a gateway key handed to a third-party MCP
 * client ran any org-visible agent, a removed member's key kept running
 * the organization's agents, and an access key minted for one agent ran
 * all of them.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function authenticateCompatKey(apiKeys: Repository<ApiKey>, token: string): Promise<ApiKey> {
  if (!token) throw new UnauthorizedException('Missing API key');

  const keyHash = crypto.createHash('sha256').update(token).digest('hex');
  const apiKey = await apiKeys.findOne({
    where: { keyHash, isActive: true },
    relations: { organization: true, user: { organizationMemberships: true } },
  });

  if (!apiKey) throw new UnauthorizedException('Invalid API key');
  if (apiKey.isExpired()) throw new UnauthorizedException('API key has expired');

  // A gateway key is a credential for one gateway's protocol surface,
  // not for running the organization's agents (see ApiKeyStrategy).
  if (apiKey.gatewayId) {
    throw new UnauthorizedException('This is a gateway API key. Use it against the gateway endpoint.');
  }

  // Every agent lookup below is scoped to the key's organization; a key
  // with none has nothing it may run.
  if (!apiKey.organizationId) {
    throw new UnauthorizedException('API key is not scoped to an organization');
  }

  // The key acts as its user, so the user has to be active and still a
  // member of the key's organization. Removing a member does not
  // deactivate their keys; this is what stops them working.
  const user = apiKey.user;
  if (!user || !user.isActive || !hasEffectiveMembership(user.organizationMemberships, apiKey.organizationId)) {
    throw new UnauthorizedException('API key is not valid for that organization');
  }

  return apiKey;
}

/**
 * The agent a compat request names, as the key may see it.
 *
 * `model` is "agent:<id>", "agent:<name>" or a bare id or name. Only a
 * uuid is looked up by id: the id column is a uuid, and Postgres answers
 * a non-uuid there with a query error rather than no rows, which made
 * every by-name request a 500. A key minted for one agent (`agentId`)
 * resolves that agent and nothing else, with the same 404 as an agent
 * that does not exist. Private agents answer only to their owner's key.
 */
export async function resolveCompatAgent(
  agentsService: Pick<AgentsService, 'getAgent' | 'findByName'>,
  model: string,
  apiKey: ApiKey,
): Promise<Agent> {
  const ref = model.replace(/^agent:/, '');
  const callerId = apiKey.userId || null;

  let agent: Agent | null = null;
  if (UUID_RE.test(ref)) {
    try {
      agent = await agentsService.getAgent(ref, apiKey.organizationId, callerId ? { id: callerId } : null);
    } catch (err) {
      // Only a not-found falls through to the name lookup: a real
      // database error must surface, not read as "agent not found".
      if (!(err instanceof NotFoundException)) throw err;
    }
  }
  if (!agent) agent = await agentsService.findByName(ref, apiKey.organizationId, callerId);

  if (!agent || (apiKey.agentId && agent.id !== apiKey.agentId)) {
    throw new NotFoundException(`Agent not found: ${model}`);
  }
  if (agent.status !== 'active') {
    throw new BadRequestException(`Agent is not active: ${agent.name} (status: ${agent.status})`);
  }
  return agent;
}

/** The agents a key may list: all visible ones, or the one it was minted for. */
export function agentsForKey<T extends { id: string }>(agents: T[], apiKey: ApiKey): T[] {
  return apiKey.agentId ? agents.filter((agent) => agent.id === apiKey.agentId) : agents;
}
