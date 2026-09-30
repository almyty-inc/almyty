import { GatewayType } from '../../entities/gateway.entity';
import { ChannelType, MESSAGING_CHANNEL_TYPES, VisitorAuthMode, type VisitorLimits } from '../../entities/agent-channel.entity';
import { credentialKeysOf } from '../gateways/channels/channel-config.helper';

/**
 * Turning a channel into something that answers.
 *
 * Until it is published a channel is a row. Publishing is what makes it
 * real, and for every type except the downloads that means standing up a
 * gateway of the matching type, created only through here (see
 * gateways/channel-surface.ts for the guard).
 *
 * The mapping lives here as data so "which channels can go live, and as
 * what" is one readable table.
 */

/** The gateway type a channel is served by, or null if it is a download. */
export const GATEWAY_TYPE_FOR_CHANNEL: Record<string, GatewayType | null> = Object.freeze({
  [ChannelType.WEB]: GatewayType.HOSTED_CHAT,
  [ChannelType.SLACK]: GatewayType.SLACK,
  [ChannelType.DISCORD]: GatewayType.DISCORD,
  [ChannelType.TELEGRAM]: GatewayType.TELEGRAM,
  [ChannelType.WHATSAPP]: GatewayType.WHATSAPP,
  [ChannelType.WHATSAPP_CLOUD]: GatewayType.WHATSAPP_CLOUD,
  [ChannelType.SMS]: GatewayType.SMS,
  [ChannelType.EMAIL]: GatewayType.EMAIL,
  [ChannelType.WEBHOOK]: GatewayType.WEBHOOK,
  [ChannelType.GOOGLE_CHAT]: GatewayType.GOOGLE_CHAT,
  [ChannelType.MICROSOFT_TEAMS]: GatewayType.MICROSOFT_TEAMS,
  [ChannelType.SIGNAL]: GatewayType.SIGNAL,
  [ChannelType.MATRIX]: GatewayType.MATRIX,
  [ChannelType.IRC]: GatewayType.IRC,
  [ChannelType.WIDGET]: GatewayType.CHAT_WIDGET,
  [ChannelType.A2A]: GatewayType.A2A,
  // These produce a file someone downloads. Nothing to stand up.
  [ChannelType.TUI]: null,
  [ChannelType.DESKTOP]: null,
});

/** Whether publishing this channel means standing up a gateway. */
export function servesOverGateway(type: ChannelType | string): boolean {
  return GATEWAY_TYPE_FOR_CHANNEL[type] != null;
}

/** The channel type a gateway type serves, or null for a gateway no channel stands up. */
export function channelTypeForGatewayType(type: string): ChannelType | null {
  const entry = Object.entries(GATEWAY_TYPE_FOR_CHANNEL).find(([, gatewayType]) => gatewayType === type);
  return entry ? (entry[0] as ChannelType) : null;
}

/**
 * What each platform needs before it can carry a message, read off what
 * the adapters actually use. Publishing never invents these: they are the
 * customer's own keys, entered or picked on the channel form and kept in
 * a credential.
 */
export const REQUIRED_CREDENTIALS: Record<string, readonly string[]> = Object.freeze({
  [ChannelType.SLACK]: ['bot_token', 'signing_secret'],
  [ChannelType.DISCORD]: ['bot_token'],
  [ChannelType.TELEGRAM]: ['bot_token'],
  [ChannelType.WHATSAPP]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [ChannelType.WHATSAPP_CLOUD]: ['access_token', 'phone_number_id', 'app_secret', 'verify_token'],
  [ChannelType.SMS]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [ChannelType.EMAIL]: ['resend_api_key', 'inbound_address', 'reply_from'],
  [ChannelType.WEBHOOK]: ['callback_url', 'secret'],
  [ChannelType.GOOGLE_CHAT]: ['webhook_url', 'verification_token'],
  [ChannelType.MICROSOFT_TEAMS]: ['bot_id', 'bot_password', 'service_url'],
  [ChannelType.SIGNAL]: ['api_url', 'phone_number'],
  [ChannelType.MATRIX]: ['homeserver_url', 'access_token', 'room_id'],
  [ChannelType.IRC]: ['webhook_url', 'bridge_token', 'nick', 'channel'],
  // We host these, so there is nothing for an operator to register.
  [ChannelType.WEB]: [],
  [ChannelType.WIDGET]: [],
  [ChannelType.A2A]: [],
  [ChannelType.TUI]: [],
  [ChannelType.DESKTOP]: [],
});

/**
 * Keys that can stand in for others. A Slack channel carries either one
 * bot token (one workspace) or its Slack app's client id and secret, which
 * is what "Add to Slack" needs (slack-install.service.ts).
 */
export const CREDENTIAL_ALTERNATIVES: Record<string, { instead: readonly string[]; all: readonly string[] }> =
  Object.freeze({
    [ChannelType.SLACK]: { instead: ['bot_token'], all: ['client_id', 'client_secret'] },
  });

/** Which of a channel's keys this configuration is missing. */
export function missingCredentials(
  type: ChannelType | string,
  configuration: Record<string, any> | null | undefined,
): string[] {
  // A secret is present when its credential holds it (`credentialKeys`
  // names it) or, on a row not yet moved, when it is still inline.
  const held = credentialKeysOf(configuration);
  const present = (field: string) => {
    if (held.includes(field)) return true;
    const value = configuration?.[field];
    return typeof value !== 'string' ? !!value : !!value.trim();
  };
  const alternative = CREDENTIAL_ALTERNATIVES[type];
  const replaced = alternative && alternative.all.every(present) ? alternative.instead : [];
  const required = (REQUIRED_CREDENTIALS[type] ?? []).filter((field) => !replaced.includes(field));
  return required.filter((field) => !present(field));
}

/** Why a channel cannot go live yet, in the operator's words. */
export const PUBLISH_REFUSALS = Object.freeze({
  NOT_SERVED: 'This ships as a file people download, so there is nothing to publish.',
  AGENT_PRIVATE:
    'This agent is private to its owner. Share it with the organization before putting it on a channel.',
  MISSING_CREDENTIALS: 'This platform cannot carry a message yet. It still needs: ',
  AGENT_NOT_CONVERSATIONAL:
    'This channel needs an agent that holds a conversation. This one runs as a workflow, which answers a call rather than a person, so switch it to autonomous.',
  WIDGET_HAS_NO_SIGN_IN:
    'The website widget has no sign-in, so it only goes on a channel anyone can use. Set who can use it to anyone with the link, or use the web chat, which asks people to sign in.',
  DESKTOP_NEEDS_WEB_CHAT:
    'A desktop app opens the agent’s web chat. Add a web chat channel to this agent first.',
});

export type PublishRefusalCode = keyof typeof PUBLISH_REFUSALS;

export interface PublishCheck {
  ok: boolean;
  refusals: Array<{ code: PublishRefusalCode; message: string }>;
}

/**
 * Whether this channel can be published, beyond the rules checkChannel
 * already answers (cost caps, entitlements, missing keys), which the
 * caller runs too and shows in one list.
 */
export function checkPublish(
  type: ChannelType | string,
  agent: { mode?: string; visibility?: string } | null,
): PublishCheck {
  const refusals: Array<{ code: PublishRefusalCode; message: string }> = [];
  const refuse = (code: PublishRefusalCode) => refusals.push({ code, message: PUBLISH_REFUSALS[code] });

  if (!servesOverGateway(type)) refuse('NOT_SERVED');
  if (agent?.visibility === 'private') refuse('AGENT_PRIVATE');
  // A workflow agent answers a call, not a person. The runtime refuses it
  // at the first message, so publishing one produces a channel that is
  // live and rejects every visitor.
  if (servesOverGateway(type) && agent && agent.mode !== 'autonomous') refuse('AGENT_NOT_CONVERSATIONAL');

  return { ok: refusals.length === 0, refusals };
}

/**
 * Where a published channel answers. The channel id makes it unique per
 * organization and unable to collide with a hand-made gateway.
 */
export function endpointFor(channel: { id: string }): string {
  return `/channels/${channel.id}`;
}

/** What the gateway is called in a list of gateways. */
export function gatewayNameFor(agentName: string, channelName: string): string {
  return `${agentName} (${channelName})`;
}

/**
 * The rate limit a channel's gateway is created with.
 *
 * The per-visitor and per-IP numbers mean what they say: each visitor and
 * each address gets that many messages an hour, never one ceiling shared
 * by the whole channel.
 */
export function rateLimitFor(limits: VisitorLimits, type: ChannelType | string = ChannelType.WEB) {
  const perUser = limits.perUserRateLimit ?? 0;
  const perIp = limits.perIpRateLimit ?? 0;
  if (perUser <= 0 && perIp <= 0) return { enabled: false };

  const perVisitor = {
    ...(perUser > 0 ? { perVisitorPerHour: perUser } : {}),
    ...(perIp > 0 ? { perIpPerHour: perIp } : {}),
  };

  // The web chat and the widget know their visitor and enforce the share
  // per visitor only. Messaging channels enforce it per platform sender as
  // well, but their webhook ingress also keeps a surface ceiling: a public
  // Slack or Telegram channel is the customer's model keys on the open
  // internet, and the ceiling is the spend bound while the sender is still
  // unverified. A2A callers are machines holding a key, so they get the
  // surface ceiling too.
  if (type !== ChannelType.WEB && type !== ChannelType.WIDGET) {
    const perHour = Math.max(perUser, perIp);
    return {
      enabled: true,
      requestsPerHour: perHour,
      requestsPerMinute: Math.max(1, Math.ceil(perHour / 60)),
      ...perVisitor,
    };
  }

  return { enabled: false, ...perVisitor };
}

/**
 * The configuration a published gateway is created with: the platform
 * settings and the credential reference from the channel, which channel
 * it is, and who may use it. Branding is not copied: it has one home (the
 * agent, overridden per channel) and the hosted chat and widget read it
 * from there on every request, so there is no second copy to drift.
 *
 * The web chat needs its address block too: it is looked up by
 * `configuration -> 'hostedChat' ->> 'slug'`.
 */
export function gatewayConfigurationFor(
  channel: { id: string; type: ChannelType | string; slug?: string | null; configuration?: Record<string, any> | null },
  authMode: VisitorAuthMode,
  /**
   * The AI disclosure a messaging channel prefixes to the first reply of a
   * conversation: the branding's line (or the default when it has none),
   * or false when the channel's switch is off and the org may turn it off.
   */
  disclosure: string | false = '',
): Record<string, any> {
  const {
    branding: _staleBranding,
    capabilities: _capabilities,
    bundleId: _bundleId,
    webChatChannelId: _webChat,
    signingCredentialId: _signing,
    aiDisclosure: _switch,
    ...operator
  } = channel.configuration ?? {};

  const base: Record<string, any> = { ...operator, authMode, channelId: channel.id };
  if (MESSAGING_CHANNEL_TYPES.includes(channel.type as ChannelType)) {
    base.aiDisclosure = disclosure === false ? false : disclosure.trim() || true;
  }
  if (channel.type !== ChannelType.WEB) return base;
  return {
    ...base,
    hostedChat: {
      slug: channel.slug,
      // Mirrored so a reader without the channel in hand (the custom-domain
      // and sign-in URL builders) still sees the rule. The public page
      // itself reads the channel's.
      authMode,
    },
  };
}
