import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GatewayType } from '../../entities/gateway.entity';
import { resourceOwnerId, type AccessPolicyService, type ResourceVisibility } from '../../common/authorization/access-policy.service';

/**
 * Private ("just me") gateways.
 *
 * A private gateway is served to its owner and nobody else. That only
 * means something on a surface where the caller proves who they are with
 * an almyty identity (an API key, an OAuth token, a gateway JWT naming a
 * user), so only the protocol surfaces can be private. Channel gateways
 * (Slack, Telegram, the chat widget, hosted chat...) are reached by
 * people outside almyty whose requests carry a platform signature, not a
 * user; a private one could never answer anybody, so it is refused at
 * write time and, should one exist anyway, treated as absent at serve
 * time.
 */
export const PRIVATE_CAPABLE_GATEWAY_TYPES: ReadonlySet<GatewayType> = new Set([
  GatewayType.MCP,
  GatewayType.UTCP,
  GatewayType.SKILLS,
  GatewayType.A2A,
  GatewayType.ACP,
  GatewayType.OPENAI_CHAT,
]);

interface GatewayVisibilityLike {
  visibility?: ResourceVisibility | null;
  ownerUserId?: string | null;
  teamId?: string | null;
}

interface ServableResourceLike {
  visibility?: ResourceVisibility | null;
  ownerUserId?: string | null;
  createdBy?: string | null;
  teamId?: string | null;
}

export function isPrivateGateway(gateway: GatewayVisibilityLike | null | undefined): boolean {
  return gateway?.visibility === 'private';
}

/**
 * May this gateway be served to `userId`? Non-private gateways: yes, the
 * gateway's own auth configs decide. A private gateway: only when the
 * request is authenticated as its recorded owner. No user, or a private
 * row with no owner, is a no.
 */
export function gatewayServableTo(
  gateway: GatewayVisibilityLike,
  userId: string | null | undefined,
): boolean {
  if (!isPrivateGateway(gateway)) return true;
  const owner = gateway.ownerUserId ?? null;
  return !!owner && !!userId && owner === userId;
}

/** The message every dashboard route answers a gateway the caller may not read with. */
export const GATEWAY_NOT_FOUND = 'Gateway not found';

/**
 * May `userId` read this gateway on the dashboard -- fetch it by id, list
 * its skills, download its CLI or SDK bundle, run a skill through it,
 * resolve it by slug?
 *
 * The same read rule every other scoped resource has
 * (AccessPolicyService.canAccess 'read'): a private gateway to its owner
 * only, admins excluded; a team gateway to its team's members and to org
 * owners/admins; an org gateway to every member. Not a member of the
 * gateway's organization, or no user at all, is a no.
 *
 * gatewayServableTo above answers a different question -- may a protocol
 * surface serve it to this identity -- where the gateway's auth configs
 * decide the rest.
 */
export async function gatewayReadableBy(
  accessPolicy: Pick<AccessPolicyService, 'canAccess'>,
  gateway: GatewayVisibilityLike & { organizationId: string },
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  return (await accessPolicy.canAccess({ id: userId }, gateway, 'read')).allowed;
}

/**
 * gatewayReadableBy, as a 404 with the text a missing gateway gets, so a
 * caller probing ids cannot tell "not yours" from "absent".
 */
export async function assertGatewayReadable(
  accessPolicy: Pick<AccessPolicyService, 'canAccess'>,
  gateway: GatewayVisibilityLike & { organizationId: string },
  userId: string | null | undefined,
): Promise<void> {
  if (!(await gatewayReadableBy(accessPolicy, gateway, userId))) {
    throw new NotFoundException(GATEWAY_NOT_FOUND);
  }
}

/**
 * May `resource` (a tool, an agent) be exposed through `gateway`?
 *
 * The part of the gateway rule (ExecutionAccessService.canExecute with a
 * gateway principal) that needs no membership lookup, for listings built
 * in memory:
 * - a private resource only through a gateway private to the same owner;
 * - a team resource only through a gateway scoped to that team, or a
 *   private gateway (whose owner's membership is checked on every call).
 * Anything wider would hand the resource to whoever the gateway answers.
 */
export function resourceServableThroughGateway(
  gateway: GatewayVisibilityLike,
  resource: ServableResourceLike | null | undefined,
): boolean {
  if (!resource) return false;
  if (resource.visibility === 'team') {
    if (isPrivateGateway(gateway)) return true;
    return gateway.visibility === 'team' && !!resource.teamId && gateway.teamId === resource.teamId;
  }
  if (resource.visibility !== 'private') return true;
  const owner = resourceOwnerId(resource);
  return !!owner && isPrivateGateway(gateway) && gateway.ownerUserId === owner;
}

/**
 * Refuse attaching `tool` to `gateway` when that would expose it beyond
 * its scope. Another user's private tool is reported as not found (it does
 * not exist for this caller); the caller's own private tool is refused
 * unless the gateway is private to them too, and a team tool unless the
 * gateway is scoped to its team. Whether the caller may run a team tool at
 * all needs a membership lookup, which the caller does with
 * ExecutionAccessService.assertGatewayMayServe.
 */
export function assertToolAttachable(
  gateway: GatewayVisibilityLike,
  tool: ServableResourceLike & { name?: string },
  userId: string,
): void {
  if (tool.visibility === 'private' && resourceOwnerId(tool) !== userId) {
    throw new NotFoundException('Tool not found');
  }
  if (!resourceServableThroughGateway(gateway, tool)) {
    throw new BadRequestException(
      tool.visibility === 'team'
        ? `Tool '${tool.name ?? ''}' is visible to its team only; it can only be served through a gateway scoped to that team`
        : `Tool '${tool.name ?? ''}' is private; it can only be served through a gateway that is private to you`,
    );
  }
}
