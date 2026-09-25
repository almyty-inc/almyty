import { NotFoundException } from '@nestjs/common';

import { type AccessPolicyService, type ResourceVisibility } from '../../common/authorization/access-policy.service';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { type ActingAs, asPrincipal, describePrincipal } from '../../common/authorization/execution-access.service';

interface ProviderVisibilityLike {
  visibility?: ResourceVisibility | null;
  ownerUserId?: string | null;
}

/** What the team rule needs on top: the organization and the team the provider is scoped to. */
export interface ProviderScopeLike extends ProviderVisibilityLike {
  organizationId: string;
  teamId?: string | null;
}

/** The two AccessPolicyService lookups the team rule reads. */
export type ProviderAccessPolicy = Pick<AccessPolicyService, 'getOrgRole' | 'getTeamMemberships'>;

/**
 * Private ("just me") LLM providers.
 *
 * A private provider -- and the key behind it -- is its owner's alone:
 * listed, fetched, called and routed to for the owner only. Everyone
 * else, org owners and admins included, is told it does not exist. A
 * call with no known user (a system path, a run nobody is attributed to)
 * cannot be the owner, so it is refused too: "just me" fails closed.
 *
 * This is the private tier only. A path that decides whether a person or
 * a run may use a provider goes through usableProviders /
 * providerUsableByUser below, which add the team tier.
 */
export function providerUsableBy(
  provider: ProviderVisibilityLike,
  userId: string | null | undefined,
): boolean {
  if (provider.visibility !== 'private') return true;
  return !!provider.ownerUserId && !!userId && provider.ownerUserId === userId;
}

/** Throw the same not-found a missing provider gets unless `userId` may use it (private tier only). */
export function assertProviderUsableBy(
  provider: ProviderVisibilityLike,
  userId: string | null | undefined,
): void {
  if (!providerUsableBy(provider, userId)) {
    throw new NotFoundException('Provider not found');
  }
}

/**
 * The providers of `rows` that `who` may use: the private rule above,
 * plus the team rule. Team only is team only: a team provider is usable by
 * members of its team (and by the org owners and admins who pass
 * AccessPolicyService.canAccess everywhere else), and by nobody else.
 *
 * A run uses a provider as its inherited principal (ExecutionPrincipal),
 * never as whoever is attributed on the run row:
 * - a user principal is judged as that user;
 * - a gateway principal gets the organization's providers plus, for a
 *   gateway scoped to a team, that team's providers. A gateway private to
 *   its owner is judged as its owner. This is the rule
 *   ExecutionAccessService.canGatewayExecute applies to agents and tools;
 * - nobody (null) gets organization-wide providers only.
 *
 * The caller's org role and teams are looked up once, and only when a
 * team provider is among the rows. With no policy wired a team provider
 * is refused: failing closed is the only safe default.
 */
export async function usableProviders<T extends ProviderScopeLike>(
  accessPolicy: ProviderAccessPolicy | null | undefined,
  organizationId: string,
  who: ActingAs,
  rows: T[],
): Promise<T[]> {
  const principal = asPrincipal(who);
  if (principal.kind === 'gateway') {
    const own = rows.filter((p) => p.organizationId === principal.organizationId);
    if (principal.visibility === 'private') {
      return principal.ownerUserId
        ? usableProviders(accessPolicy, organizationId, principal.ownerUserId, own)
        : own.filter(isOrgWide);
    }
    return own.filter(
      (p) =>
        isOrgWide(p) ||
        (p.visibility === 'team' && principal.visibility === 'team' && !!principal.teamId && p.teamId === principal.teamId),
    );
  }
  const userId = principal.userId;
  const privateOk = rows.filter((p) => providerUsableBy(p, userId));
  if (!privateOk.some((p) => p.visibility === 'team')) return privateOk;
  let inTeam: (teamId: string) => boolean = () => false;
  if (userId && accessPolicy) {
    const role = await accessPolicy.getOrgRole(userId, organizationId);
    if (role === OrganizationRole.OWNER || role === OrganizationRole.ADMIN) {
      inTeam = () => true;
    } else if (role) {
      const teams = await accessPolicy.getTeamMemberships(userId, organizationId);
      inTeam = (teamId) => teams.has(teamId);
    }
  }
  return privateOk.filter((p) => {
    if (p.visibility !== 'team') return true;
    return p.organizationId === organizationId && !!p.teamId && inTeam(p.teamId);
  });
}

function isOrgWide(p: ProviderVisibilityLike): boolean {
  return !p.visibility || p.visibility === 'org';
}

/** One provider through usableProviders. */
export async function providerUsableByUser(
  accessPolicy: ProviderAccessPolicy | null | undefined,
  provider: ProviderScopeLike,
  who: ActingAs,
): Promise<boolean> {
  return (await usableProviders(accessPolicy, provider.organizationId, who, [provider])).length === 1;
}

/**
 * The refusal a person or a run gets for a provider it may not use: a
 * 404, the status a missing provider gets, never a 403 that would confirm
 * a team or private provider exists. A missing provider asked for on
 * someone's behalf gets the same error, so the two stay indistinguishable.
 * The message names who the call acts as, so a failed run explains itself
 * (the OWNER_CANNOT_RUN idea): the run's principal decided, not the
 * person looking at the run.
 */
export class ProviderNotUsableError extends NotFoundException {
  readonly code = 'PROVIDER_NOT_USABLE';

  constructor(who: ActingAs) {
    const principal = asPrincipal(who);
    const described =
      principal.kind === 'user' && !principal.userId ? 'no user: an anonymous or system call' : describePrincipal(principal);
    super({
      code: 'PROVIDER_NOT_USABLE',
      message:
        `Provider not found for the ${principal.kind === 'gateway' ? 'gateway' : 'user'} this call acts as (${described}). ` +
        'A private provider is usable by its owner only, and a team provider by members of its team only.',
      error: 'Not Found',
      statusCode: 404,
    });
  }
}
