import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import {
  AccessPolicyService,
  ResourceLike,
  ResourceVisibility,
  normaliseVisibility,
  resourceOwnerId,
} from './access-policy.service';

/**
 * Helpers for the 'private' ("just me") tier on agents, tools and APIs.
 * The policy itself lives in AccessPolicyService; these are the pieces
 * the services repeat around it: refuse another user's private row as
 * "not found", decide who owns a row that is being made private, and
 * refuse wiring a private resource into something other people can use.
 */

/**
 * Throw a 404 when `row` is somebody else's private resource.
 *
 * 404, not 403: a 403 would confirm to another member that a resource
 * with that id exists. Rows that are not private pass untouched -- their
 * org/team rules are enforced where they always were.
 */
export async function assertNotOthersPrivate(
  accessPolicy: AccessPolicyService,
  user: { id: string } | null | undefined,
  row: ResourceLike | null | undefined,
  label = 'Resource',
): Promise<void> {
  if (!row || row.visibility !== 'private') return;
  if (!user?.id) throw new NotFoundException(`${label} not found`);
  const decision = await accessPolicy.canAccess(user, row, 'read');
  if (!decision.allowed) throw new NotFoundException(`${label} not found`);
}

/**
 * True when `row` is private and not `userId`'s. A private row with no
 * recorded owner is nobody's, so it counts as someone else's for everyone.
 */
export function isOthersPrivate(row: ResourceLike, userId: string | null | undefined): boolean {
  if (row.visibility !== 'private') return false;
  const owner = resourceOwnerId(row);
  return !owner || owner !== userId;
}

/** Drop every row that is another user's private resource. */
export function withoutOthersPrivate<T extends ResourceLike>(rows: T[], userId: string | null | undefined): T[] {
  return rows.filter((row) => !isOthersPrivate(row, userId));
}

/**
 * Work out the (visibility, teamId, owner) to write on create/update.
 *
 * - Nothing requested: the row keeps what it has.
 * - 'private' requested: only the row's recorded owner may make it (or
 *   keep it) private. A row with no recorded owner becomes the caller's.
 *   Anyone else is refused -- flipping a colleague's org-wide agent to
 *   "just me" would take it away from its owner.
 * - 'org' / 'team': the owner is left as it is.
 *
 * `ownerId` in the result is the owner the row must carry afterwards;
 * callers write it to their owner column (createdBy / ownerUserId). On
 * create, pass the caller as current.ownerId.
 */
export function resolveVisibilityWrite(args: {
  requestedVisibility: ResourceVisibility | undefined | null;
  requestedTeamId: string | null | undefined;
  current: { visibility?: ResourceVisibility | null; teamId?: string | null; ownerId?: string | null } | null;
  callerId: string | null | undefined;
  noun?: string;
}): { visibility: ResourceVisibility; teamId: string | null; ownerId: string | null } {
  const { requestedVisibility, requestedTeamId, current, callerId } = args;
  const noun = args.noun ?? 'resource';
  const currentOwner = current?.ownerId ?? null;
  const nextVisibility: ResourceVisibility =
    requestedVisibility ?? current?.visibility ?? 'org';
  const nextTeamIdRaw =
    requestedTeamId !== undefined ? requestedTeamId : (current?.teamId ?? null);
  const { visibility, teamId } = normaliseVisibility(nextVisibility, nextTeamIdRaw);

  if (visibility !== 'private') {
    return { visibility, teamId, ownerId: currentOwner };
  }
  if (!callerId) {
    throw new ForbiddenException(`A private ${noun} needs an owner`);
  }
  if (currentOwner && currentOwner !== callerId) {
    throw new ForbiddenException(`Only the owner of this ${noun} can make it private`);
  }
  return { visibility, teamId, ownerId: callerId };
}

/**
 * May `parent` reference `child`? Anything not private, yes; a private
 * child only from a parent that is private to the same owner.
 */
export function canReference(
  parent: { visibility?: ResourceVisibility | null; ownerId?: string | null },
  child: ResourceLike,
): boolean {
  if (child.visibility !== 'private') return true;
  const childOwner = resourceOwnerId(child);
  return parent.visibility === 'private' && !!childOwner && childOwner === parent.ownerId;
}

/**
 * Refuse attaching a private resource to something other people can use.
 *
 * A private tool, API or sub-agent may only be referenced by a resource
 * that is itself private to the same owner. Anything wider (org, team,
 * or somebody else's private agent) would hand the private resource to
 * everyone who can run the parent.
 */
export function assertAttachable(
  parent: { visibility?: ResourceVisibility | null; ownerId?: string | null; noun: string },
  children: Array<ResourceLike & { id?: string; name?: string | null }>,
  childNoun: string,
): void {
  const blocked = children.filter((child) => !canReference(parent, child));
  if (blocked.length === 0) return;
  // Name only the caller's own resources; another member's private
  // resource is identified by the id the caller already sent.
  const names = blocked
    .map((c) => (resourceOwnerId(c) === parent.ownerId && c.name ? c.name : c.id))
    .join(', ');
  throw new BadRequestException(
    `These ${childNoun}s are private to their owner and can only be used by that owner's own private ${parent.noun}: ${names}. ` +
      `Make this ${parent.noun} private, or share the ${childNoun} with the organization first.`,
  );
}

/**
 * The tools a gateway may serve. A gateway is reached by whoever holds
 * its URL or key, not by a user the policy can check, so a private tool
 * is only served on a gateway that is itself private to the tool's own
 * owner. Every org/team tool passes (gateway membership gates those).
 */
export function servableOnGateway<T extends ResourceLike>(
  tools: T[],
  gateway: { visibility?: ResourceVisibility | null; ownerUserId?: string | null } | null | undefined,
): T[] {
  return tools.filter((tool) => {
    if (tool.visibility !== 'private') return true;
    const owner = resourceOwnerId(tool);
    return !!owner && gateway?.visibility === 'private' && gateway.ownerUserId === owner;
  });
}