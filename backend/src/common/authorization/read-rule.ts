import { ForbiddenException, NotFoundException } from '@nestjs/common';

import { AccessPolicyService, ResourceLike, resourceOwnerId } from './access-policy.service';

/**
 * The read rule, and the order every path that returns or changes one
 * resource by id applies it in.
 *
 *   cannot read          -> 404, the same answer an id that does not exist gets
 *   can read, not manage -> 403
 *
 * Reading is AccessPolicyService.canAccess(user, row, 'read'): another
 * member's private row is refused to everyone (org admins included), a team
 * row to anyone outside the team, and every row to a non-member. Checking
 * 'manage' first answered a caller who could not even see the row with a
 * 403 naming why ("not a member of the resource's team"), which confirms
 * the id exists and says how it is scoped. So the read check always runs
 * first, and its failure is indistinguishable from a missing row.
 *
 * `read-before-manage.guard.spec.ts` holds every manage path to this.
 */

/** Who is asking. `null` is an explicit nobody: an internal call made on no one's behalf. */
export type ReadCaller = { id: string } | null;

/**
 * May `caller` read `row`? A nobody reads only organization-wide rows (the
 * caller of such a path has already been bound to the row's organization);
 * a team or private row is nobody's to read.
 */
export async function canRead(
  accessPolicy: Pick<AccessPolicyService, 'canAccess'>,
  caller: ReadCaller | undefined,
  row: ResourceLike,
): Promise<boolean> {
  if (!caller?.id) return (row.visibility ?? 'org') === 'org';
  const decision = await accessPolicy.canAccess({ id: caller.id }, row, 'read');
  return decision.allowed;
}

/** 404 unless `caller` may read `row` (and unless there is a row at all). */
export async function assertReadable<T extends ResourceLike>(
  accessPolicy: Pick<AccessPolicyService, 'canAccess'>,
  caller: ReadCaller | undefined,
  row: T | null | undefined,
  label = 'Resource',
): Promise<T> {
  if (!row || !(await canRead(accessPolicy, caller, row))) {
    throw new NotFoundException(`${label} not found`);
  }
  return row;
}

export interface ManageOptions {
  /**
   * The row's owner (resourceOwnerId: ownerUserId, else createdBy) may
   * manage it without a manage grant -- the creator of an agent or tool
   * edits their own. The read check still runs first.
   */
  ownerManages?: boolean;
}

/**
 * The manage gate: 404 unless `userId` may read `row`, then 403 unless
 * they may manage it. A manage path always names a user; one without is
 * refused as not found.
 */
export async function assertManageable<T extends ResourceLike>(
  accessPolicy: Pick<AccessPolicyService, 'canAccess'>,
  userId: string | null | undefined,
  row: T | null | undefined,
  label = 'Resource',
  options: ManageOptions = {},
): Promise<T> {
  if (!userId) throw new NotFoundException(`${label} not found`);
  const readable = await assertReadable(accessPolicy, { id: userId }, row, label);
  if (options.ownerManages && resourceOwnerId(readable) === userId) return readable;
  const decision = await accessPolicy.canAccess({ id: userId }, readable, 'manage');
  if (!decision.allowed) throw new ForbiddenException(decision.reason);
  return readable;
}
