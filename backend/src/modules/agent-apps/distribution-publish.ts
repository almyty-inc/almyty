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
 * Why a distribution cannot go live yet, in the operator's words.
 *
 * Separate from `checkApp`, which answers for the product as a whole.
 * These are the reasons that only apply at the moment of publishing.
 */
export const PUBLISH_REFUSALS = Object.freeze({
  NOT_SERVED: 'This ships as a file people download, so there is nothing to publish.',
  NO_AGENT: 'A published product needs an agent to answer. Add one first.',
  APP_INACTIVE: 'This product is switched off. Turn it back on before publishing.',
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
): PublishCheck {
  const refusals: Array<{ code: PublishRefusalCode; message: string }> = [];
  const refuse = (code: PublishRefusalCode) =>
    refusals.push({ code, message: PUBLISH_REFUSALS[code] });

  if (!servesOverGateway(target)) refuse('NOT_SERVED');
  if (!app.agentIds?.length) refuse('NO_AGENT');
  if (app.isActive === false) refuse('APP_INACTIVE');

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
