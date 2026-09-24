import { NotFoundException } from '@nestjs/common';

import { type ResourceVisibility } from '../../common/authorization/access-policy.service';

interface ProviderVisibilityLike {
  visibility?: ResourceVisibility | null;
  ownerUserId?: string | null;
}

/**
 * Private ("just me") LLM providers.
 *
 * A private provider -- and the key behind it -- is its owner's alone:
 * listed, fetched, called and routed to for the owner only. Everyone
 * else, org owners and admins included, is told it does not exist. A
 * call with no known user (a system path, a run nobody is attributed to)
 * cannot be the owner, so it is refused too: "just me" fails closed.
 */
export function providerUsableBy(
  provider: ProviderVisibilityLike,
  userId: string | null | undefined,
): boolean {
  if (provider.visibility !== 'private') return true;
  return !!provider.ownerUserId && !!userId && provider.ownerUserId === userId;
}

/** Throw the same not-found a missing provider gets unless `userId` may use it. */
export function assertProviderUsableBy(
  provider: ProviderVisibilityLike,
  userId: string | null | undefined,
): void {
  if (!providerUsableBy(provider, userId)) {
    throw new NotFoundException('Provider not found');
  }
}
