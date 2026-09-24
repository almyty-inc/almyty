import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Api } from '../../entities/api.entity';
import { Organization } from '../../entities/organization.entity';
import { inQuotaTransaction, lockQuota } from '../../common/quota/org-quota-lock';

/**
 * The one place an organization's API quota is enforced.
 *
 * `Organization.settings.maxApis` used to be checked by
 * `Organization.canAddMoreApis()`, which compared against the `apis`
 * relation -- a relation no caller loaded, so it would always have
 * passed. Nothing called it: `create` and `createHttpApi` ran their own
 * unserialised COUNT, and `createSdkApi` and Tool Hub installs (which
 * create an API for a template's base URL) did not check at all.
 *
 * Every code path that inserts an Api row does so through
 * `withApiQuota` (or `assertApiQuota` on a transaction it already
 * owns). `api-quota-is-enforced.guard.spec.ts` reads the tree and fails
 * when a file creates Api rows without it.
 *
 * The count is a real COUNT(*) on `apis`, run in the same transaction as
 * the insert and after the organization's API-quota advisory lock (see
 * common/quota/org-quota-lock.ts), so concurrent creates cannot both take
 * the last slot. Deleting an API removes its row, so every row counts.
 */

export class ApiQuotaExceededException extends BadRequestException {}

async function maxApisFor(manager: EntityManager, organizationId: string): Promise<number | undefined> {
  const organization = await manager
    .getRepository(Organization)
    .findOne({ where: { id: organizationId } });
  return organization?.settings?.maxApis;
}

function countApis(manager: EntityManager, organizationId: string): Promise<number> {
  return manager.getRepository(Api).count({ where: { organizationId } });
}

/** Remaining API slots for the organization; Infinity when unlimited. */
export async function remainingApiQuota(manager: EntityManager, organizationId: string): Promise<number> {
  const maxApis = await maxApisFor(manager, organizationId);
  if (!maxApis) return Infinity;
  return Math.max(0, maxApis - (await countApis(manager, organizationId)));
}

/**
 * The enforcing check. `manager` must be inside a transaction, and the
 * Api insert must run on that same transaction after this returns: it
 * takes the organization's API-quota lock (held to commit), then counts.
 * Most callers want `withApiQuota`.
 */
export async function assertApiQuota(manager: EntityManager, organizationId: string, adding = 1): Promise<void> {
  if (adding <= 0) return;
  // An unlimited organization needs no lock: nothing to overshoot.
  const maxApis = await maxApisFor(manager, organizationId);
  if (!maxApis) return;
  await lockQuota(manager, 'apis', organizationId);
  const remaining = Math.max(0, maxApis - (await countApis(manager, organizationId)));
  if (adding <= remaining) return;
  throw new ApiQuotaExceededException(
    adding === 1
      ? 'API limit exceeded for organization'
      : `API limit exceeded for organization: this would add ${adding} APIs and only ${remaining} remain`,
  );
}

/**
 * Check the quota for `adding` new APIs and run `insert` in the same
 * transaction, under the organization's API-quota lock. Reuses
 * `manager`'s transaction when it has one. `insert` must write through
 * the `tx` it is given; a write on any other manager escapes the lock.
 */
export function withApiQuota<T>(
  manager: EntityManager,
  organizationId: string,
  adding: number,
  insert: (tx: EntityManager) => Promise<T>,
): Promise<T> {
  return inQuotaTransaction(manager, async (tx) => {
    await assertApiQuota(tx, organizationId, adding);
    return insert(tx);
  });
}
