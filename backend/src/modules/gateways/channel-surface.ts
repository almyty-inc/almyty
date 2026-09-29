import { GatewayType } from '../../entities/gateway.entity';
import { GATEWAY_TYPE_FOR_CHANNEL } from '../agent-channels/channel-publish';

/**
 * The gateways that are an agent's channels.
 *
 * The web chat, the website widget, the messaging platforms and the A2A
 * endpoint for other agents are channels on an agent: publishing one on
 * the agent's Channels tab stands up the gateway it answers on and
 * records it on the channel. So every gateway of these types belongs to a
 * channel, and none is made any other way. The list is read off the
 * channel table itself, so a channel type is on it by construction.
 */
export const CHANNEL_GATEWAY_TYPES: ReadonlySet<GatewayType> = new Set(
  Object.values(GATEWAY_TYPE_FOR_CHANNEL).filter((type): type is GatewayType => type != null),
);

export function isChannelGatewayType(type: GatewayType | string | null | undefined): boolean {
  return CHANNEL_GATEWAY_TYPES.has(type as GatewayType);
}

/** Why a channel's gateway made outside an agent's channels is refused. */
export const CHANNEL_GATEWAY_NEEDS_AGENT = Object.freeze({
  code: 'CHANNEL_GATEWAY_NEEDS_AGENT',
  message:
    'A web chat, a website widget, a messaging channel or an A2A endpoint is a channel on an agent. Add it on the agent’s Channels tab.',
});
