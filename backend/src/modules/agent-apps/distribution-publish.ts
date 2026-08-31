import { GatewayType } from '../../entities/gateway.entity';
import { DistributionTarget } from '../../entities/agent-app-distribution.entity';
import type { AgentApp } from '../../entities/agent-app.entity';

/**
 * Turning a distribution into something that answers.
 *
 * Up to here a distribution was a row: adding one to Slack recorded an
 * intent and connected nothing. Publishing is what makes it real, and
 * for every target except the three that compile to a file that means
 * standing up a gateway of the matching type.
 *
 * The mapping lives here as data rather than as a switch inside a
 * service so that "which targets can go live, and as what" is one
 * readable table.
 */

/** The gateway type a target is served by, or null if it is a file. */
export const GATEWAY_TYPE_FOR_TARGET: Record<string, GatewayType | null> = Object.freeze({
  [DistributionTarget.WEB]: GatewayType.HOSTED_CHAT,
  [DistributionTarget.SLACK]: GatewayType.SLACK,
  [DistributionTarget.DISCORD]: GatewayType.DISCORD,
  [DistributionTarget.TELEGRAM]: GatewayType.TELEGRAM,
  [DistributionTarget.WHATSAPP]: GatewayType.WHATSAPP,
  [DistributionTarget.WHATSAPP_CLOUD]: GatewayType.WHATSAPP_CLOUD,
  [DistributionTarget.SMS]: GatewayType.SMS,
  [DistributionTarget.EMAIL]: GatewayType.EMAIL,
  [DistributionTarget.WEBHOOK]: GatewayType.WEBHOOK,
  [DistributionTarget.GOOGLE_CHAT]: GatewayType.GOOGLE_CHAT,
  [DistributionTarget.MICROSOFT_TEAMS]: GatewayType.MICROSOFT_TEAMS,
  [DistributionTarget.SIGNAL]: GatewayType.SIGNAL,
  [DistributionTarget.MATRIX]: GatewayType.MATRIX,
  [DistributionTarget.IRC]: GatewayType.IRC,
  // These three produce a file someone downloads. There is nothing to
  // stand up, and nothing to take down.
  [DistributionTarget.TUI]: null,
  [DistributionTarget.DESKTOP]: null,
  [DistributionTarget.BINARY]: null,
});

/** Whether publishing this target means standing up a gateway. */
export function servesOverGateway(target: DistributionTarget | string): boolean {
  return GATEWAY_TYPE_FOR_TARGET[target] != null;
}

/**
 * What each platform needs before it can carry a message.
 *
 * Read off what the adapters actually use, not off their documentation.
 * A gateway created without these is the worst kind of broken: it says
 * live, answers nothing, and gives no reason.
 *
 * Publishing never invents these. They are the customer's own
 * credentials for their own Slack app or Twilio number, so the operator
 * supplies them and publishing checks they are there.
 */
export const REQUIRED_CREDENTIALS: Record<string, readonly string[]> = Object.freeze({
  [DistributionTarget.SLACK]: ['bot_token', 'signing_secret'],
  [DistributionTarget.DISCORD]: ['bot_token'],
  [DistributionTarget.TELEGRAM]: ['bot_token'],
  [DistributionTarget.WHATSAPP]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [DistributionTarget.WHATSAPP_CLOUD]: [
    'access_token',
    'phone_number_id',
    'app_secret',
    'verify_token',
  ],
  [DistributionTarget.SMS]: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  [DistributionTarget.EMAIL]: ['resend_api_key', 'inbound_address', 'reply_from'],
  [DistributionTarget.WEBHOOK]: ['callback_url', 'secret'],
  [DistributionTarget.GOOGLE_CHAT]: ['webhook_url', 'verification_token'],
  [DistributionTarget.MICROSOFT_TEAMS]: ['bot_id', 'bot_password', 'service_url'],
  [DistributionTarget.SIGNAL]: ['api_url', 'phone_number'],
  [DistributionTarget.MATRIX]: ['homeserver_url', 'access_token', 'room_id'],
  [DistributionTarget.IRC]: ['webhook_url', 'bridge_token', 'nick', 'channel'],
  // We host this one, so there is nothing for an operator to register.
  [DistributionTarget.WEB]: [],
  [DistributionTarget.TUI]: [],
  [DistributionTarget.DESKTOP]: [],
  [DistributionTarget.BINARY]: [],
});

/** Which of a target's credentials this configuration is missing. */
export function missingCredentials(
  target: DistributionTarget | string,
  configuration: Record<string, any> | null | undefined,
): string[] {
  const required = REQUIRED_CREDENTIALS[target] ?? [];
  return required.filter((field) => {
    const value = configuration?.[field];
    return typeof value !== 'string' ? !value : !value.trim();
  });
}

/**
 * Which agent answers on this surface.
 *
 * A product can carry several agents, and the entity documents the
 * first as the default. That is a fine default and a bad silent
 * decision: a support product with a triage agent and a billing agent
 * should be able to put the billing one on the billing channel. So a
 * distribution may name its own, and falls back to the app's default
 * when it does not.
 */
export function agentForDistribution(
  app: Pick<AgentApp, 'agentIds'>,
  configuration: Record<string, any> | null | undefined,
): string | null {
  const named = configuration?.agentId;
  if (typeof named === 'string' && named.trim()) return named.trim();
  return app.agentIds?.[0] ?? null;
}

/**
 * Why a distribution cannot go live yet, in the operator's words.
 *
 * Separate from `checkApp`, which answers for the product as a whole.
 * These are the reasons that only apply at the moment of publishing.
 */
export const PUBLISH_REFUSALS = Object.freeze({
  NOT_SERVED: 'This ships as a file people download, so there is nothing to publish.',
  NO_AGENT: 'A published product needs an agent to answer. Add one first.',
  APP_INACTIVE: 'This product is switched off. Turn it back on before publishing.',
  MISSING_CREDENTIALS: 'This platform cannot carry a message yet. It still needs: ',
  AGENT_NOT_ON_APP:
    'The agent this surface is set to answer with is no longer part of this product. Pick one that is.',
  AGENT_NOT_CONVERSATIONAL:
    'A chat surface needs an agent that holds a conversation. This one runs as a workflow, which answers a call rather than a person, so switch it to autonomous or pick a different agent.',
});

export type PublishRefusalCode = keyof typeof PUBLISH_REFUSALS;

export interface PublishCheck {
  ok: boolean;
  refusals: Array<{ code: PublishRefusalCode; message: string }>;
}

/**
 * Whether this distribution can be published, ignoring the product-wide
 * rules that `checkApp` already answers.
 *
 * Deliberately does not repeat the cost-cap and rate-limit refusals: the
 * caller runs both and shows one list, and saying the same thing twice
 * reads as two separate problems.
 */
export function checkPublish(
  target: DistributionTarget,
  app: Pick<AgentApp, 'agentIds' | 'isActive'>,
  configuration: Record<string, any> | null | undefined = null,
  agent: { mode?: string } | null = null,
): PublishCheck {
  const refusals: Array<{ code: PublishRefusalCode; message: string }> = [];
  const refuse = (code: PublishRefusalCode, detail = '') =>
    refusals.push({ code, message: `${PUBLISH_REFUSALS[code]}${detail}` });

  if (!servesOverGateway(target)) refuse('NOT_SERVED');
  if (!app.agentIds?.length) refuse('NO_AGENT');
  if (app.isActive === false) refuse('APP_INACTIVE');

  // A named agent that has since been removed from the product would
  // otherwise publish a surface answered by something the operator
  // thinks is no longer involved.
  const named = configuration?.agentId;
  if (typeof named === 'string' && named.trim() && !app.agentIds?.includes(named.trim())) {
    refuse('AGENT_NOT_ON_APP');
  }

  // Only worth saying for something that would otherwise go live.
  if (servesOverGateway(target)) {
    const missing = missingCredentials(target, configuration);
    if (missing.length) refuse('MISSING_CREDENTIALS', missing.join(', '));

    // A workflow agent answers a call, not a person. The runtime
    // refuses it at the first message, so publishing one produces a
    // surface that is live and rejects every visitor.
    if (agent && agent.mode !== 'autonomous') refuse('AGENT_NOT_CONVERSATIONAL');
  }

  return { ok: refusals.length === 0, refusals };
}

/**
 * Where a published distribution answers.
 *
 * Endpoints are unique per organization, so the app and the target
 * together make one that cannot collide with a hand-made gateway or
 * with the same app's other surfaces.
 */
export function endpointFor(appSlug: string, target: DistributionTarget | string): string {
  return `/apps/${appSlug}/${target}`;
}

/** What the gateway is called in a list of gateways. */
export function gatewayNameFor(app: Pick<AgentApp, 'name'>, target: DistributionTarget | string): string {
  return `${app.name} (${target})`;
}

/**
 * The rate limit a gateway is created with.
 *
 * Taken from the app's own limits rather than left at the gateway
 * default, because those limits are the reason the product was allowed
 * to be published at all. Creating the surface without them would make
 * the check theatre.
 */
export function rateLimitFor(app: Pick<AgentApp, 'limits'>) {
  const perUser = app.limits?.perUserRateLimit ?? 0;
  const perIp = app.limits?.perIpRateLimit ?? 0;
  const perHour = Math.max(perUser, perIp);

  if (perHour <= 0) return { enabled: false };

  return {
    enabled: true,
    requestsPerHour: perHour,
    // A per-minute ceiling as well, so an hour's budget cannot be spent
    // in the first ten seconds.
    requestsPerMinute: Math.max(1, Math.ceil(perHour / 60)),
  };
}

/**
 * The configuration a published gateway is created with.
 *
 * Two things are merged: whatever the operator put on the distribution,
 * which is where the platform credentials live, and the product's own
 * presentation, so a surface does not carry a copy of the branding that
 * someone has to keep in step by hand.
 *
 * The hosted chat is the one target that needs more than that. It is
 * looked up by `configuration -> 'hostedChat' ->> 'slug'`, so without
 * that block a published web app is a gateway nothing can find — which
 * is exactly what happened before this existed.
 */
export function gatewayConfigurationFor(
  target: DistributionTarget,
  app: Pick<AgentApp, 'id' | 'slug' | 'name' | 'branding' | 'authMode'>,
  configuration: Record<string, any> | null | undefined,
): Record<string, any> {
  const branding = app.branding ?? {};

  const base = {
    ...(configuration ?? {}),
    branding,
    authMode: app.authMode,
    appId: app.id,
  };

  if (target !== DistributionTarget.WEB) return base;

  return {
    ...base,
    hostedChat: {
      // The product's own name is the address. One surface per product
      // per deployment, which is what makes it findable.
      slug: app.slug,
      appName: branding.appName || app.name,
      primaryColor: branding.primaryColor ?? '#8b5cf6',
      greeting: branding.greeting ?? '',
      theme: branding.theme ?? 'auto',
      logoUrl: branding.logoUrl ?? null,
      suggestedPrompts: branding.suggestedPrompts ?? [],
      authMode: app.authMode,
      aiDisclosure: branding.aiDisclosure ?? null,
      whiteLabel: branding.whiteLabel ?? false,
    },
  };
}
