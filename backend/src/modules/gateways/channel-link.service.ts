import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { AgentChannel, ChannelType } from '../../entities/agent-channel.entity';
import type { Gateway } from '../../entities/gateway.entity';
import { carriesDisclosure, disclosureOn, effectiveBranding, effectiveVisitorRules } from '../agent-channels/channel-rules';
import { hostedChatBlockFor } from './channels/hosted-chat.config';

/** The channel a gateway answers for, with the agent it belongs to. */
export type LinkedChannel = AgentChannel & { agent: Agent };

/** What the gateway page links to: the agent and which of its channels this is. */
export interface GatewayManagedBy {
  agent: { id: string; name: string };
  channel: { id: string; type: ChannelType };
}

/**
 * Which channel owns a gateway.
 *
 * Publishing a channel stands up a gateway and records it on the channel
 * (`gatewayId`), so the owner is found by that column, never by name or
 * endpoint. Everything that asks "is this gateway a channel's?" asks
 * here: the gateway page's "Managed on" link, the policy every visitor
 * message passes, and the hosted chat, which reads its branding from the
 * agent and the channel on every request.
 *
 * Lives in the gateways module and reads the two tables directly, because
 * the channels module already depends on this one.
 */
@Injectable()
export class ChannelLinkService {
  constructor(
    @InjectRepository(AgentChannel)
    private readonly channels: Repository<AgentChannel>,
  ) {}

  /** The channel (with its agent) that points at this gateway, in this organization. */
  async channelFor(organizationId: string, gatewayId: string): Promise<LinkedChannel | null> {
    if (!organizationId || !gatewayId) return null;
    const found = await this.channels.findOne({
      where: { organizationId, gatewayId },
      relations: { agent: true },
    });
    if (!found?.agent || String(found.agent.organizationId) !== String(organizationId)) return null;
    return found as LinkedChannel;
  }

  /** What the gateway page links to, or null for a gateway no channel owns. */
  async managedBy(organizationId: string, gatewayId: string): Promise<GatewayManagedBy | null> {
    const found = await this.channelFor(organizationId, gatewayId);
    if (!found) return null;
    return {
      agent: { id: found.agent.id, name: found.agent.name },
      channel: { id: found.id, type: found.type },
    };
  }

  /**
   * The gateway as the public hosted chat should see it: its own address,
   * and the branding, sign-in rule and visitor rights of its agent with
   * the channel's overrides. Returns a copy; the stored row is never
   * changed here.
   */
  async withChannelSettings(gateway: Gateway): Promise<Gateway> {
    const found = await this.channelFor(gateway.organizationId, gateway.id);
    const configuration = gateway.configuration ?? {};
    const hostedChat = hostedChatBlockFor(found ? ownerOf(found) : null, configuration.hostedChat);
    return Object.assign(Object.create(Object.getPrototypeOf(gateway)), gateway, {
      configuration: { ...configuration, hostedChat },
    });
  }
}

/** What a hosted chat reads about the channel that owns it: its resolved branding and rules. */
export function ownerOf(channel: LinkedChannel) {
  const rules = effectiveVisitorRules(channel.agent, channel);
  const branding = effectiveBranding(channel.agent, channel);
  // The channel's AI disclosure switch. Only an org that may remove the
  // disclosure can store it off (the channel service refuses otherwise), so
  // off here is a removal the org is entitled to: an empty line.
  const disclosureOff = carriesDisclosure(channel.type) && !disclosureOn(channel.configuration);
  return {
    name: channel.agent.name,
    branding: disclosureOff ? { ...branding, aiDisclosure: '' } : branding,
    disclosureOff,
    authMode: rules.authMode,
    privacy: rules.privacy,
  };
}
