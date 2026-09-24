import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Gateway } from '../../entities/gateway.entity';
import { Organization } from '../../entities/organization.entity';
import { inQuotaTransaction, lockQuota } from '../../common/quota/org-quota-lock';

/**
 * The one place an organization's gateway quota is enforced.
 *
 * `Organization.settings.maxGateways` used to be checked by
 * `Organization.canAddMoreGateways()`, which compared against the
 * `gateways` relation -- a relation createGateway never loaded, so the
 * check read `undefined.length || 0` and always passed. The limit was
 * never enforced at all.
 *
 * Every code path that inserts a Gateway row does so through
 * `withGatewayQuota` (or `assertGatewayQuota` on a transaction it
 * already owns). `gateway-quota-is-enforced.guard.spec.ts` reads the
 * tree and fails when a file creates Gateway rows without it.
 *
 * The count is a real COUNT(*) on `gateways`, run in the same
 * transaction as the insert and after the organization's gateway-quota
 * advisory lock (see common/quota/org-quota-lock.ts), so concurrent
 * creates cannot both take the last slot.
 *
 * The platform's own system gateway (`isSystem`, the `/almyty` MCP
 * endpoint GatewayInitHelper.ensureSystemGateway provisions on demand)
 * is infrastructure, not something the organization created: it is not
 * counted and its creation is not gated, so an organization at its
 * limit still gets the management endpoint.
 */

export class GatewayQuotaExceededException extends BadRequestException {}

async function maxGatewaysFor(manager: EntityManager, organizationId: string): Promise<number | undefined> {
  const organization = await manager
    .getRepository(Organization)
    .findOne({ where: { id: organizationId } });
  return organization?.settings?.maxGateways;
}

function countGateways(manager: EntityManager, organizationId: string): Promise<number> {
  return manager.getRepository(Gateway).count({ where: { organizationId, isSystem: false } });
}

/** Remaining gateway slots for the organization; Infinity when unlimited. */
export async function remainingGatewayQuota(
  manager: EntityManager,
  organizationId: string,
): Promise<number> {
  const maxGateways = await maxGatewaysFor(manager, organizationId);
  if (!maxGateways) return Infinity;
  return Math.max(0, maxGateways - (await countGateways(manager, organizationId)));
}

/**
 * The enforcing check. `manager` must be inside a transaction, and the
 * Gateway insert must run on that same transaction after this returns:
 * it takes the organization's gateway-quota lock (held to commit), then
 * counts. Most callers want `withGatewayQuota`.
 */
export async function assertGatewayQuota(
  manager: EntityManager,
  organizationId: string,
  adding = 1,
): Promise<void> {
  if (adding <= 0) return;
  // An unlimited organization needs no lock: nothing to overshoot.
  const maxGateways = await maxGatewaysFor(manager, organizationId);
  if (!maxGateways) return;
  await lockQuota(manager, 'gateways', organizationId);
  const remaining = Math.max(0, maxGateways - (await countGateways(manager, organizationId)));
  if (adding <= remaining) return;
  throw new GatewayQuotaExceededException(
    adding === 1
      ? 'Organization has reached gateway limit'
      : `Organization has reached gateway limit: this would add ${adding} gateways and only ${remaining} remain`,
  );
}

/**
 * Check the quota for `adding` new gateways and run `insert` in the same
 * transaction, under the organization's gateway-quota lock. Reuses
 * `manager`'s transaction when it has one. `insert` must write through
 * the `tx` it is given; a write on any other manager escapes the lock.
 */
export function withGatewayQuota<T>(
  manager: EntityManager,
  organizationId: string,
  adding: number,
  insert: (tx: EntityManager) => Promise<T>,
): Promise<T> {
  return inQuotaTransaction(manager, async (tx) => {
    await assertGatewayQuota(tx, organizationId, adding);
    return insert(tx);
  });
}
