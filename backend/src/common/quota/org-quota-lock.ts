import { EntityManager } from 'typeorm';

/**
 * Serialisation for per-organization quotas (`settings.maxTools`,
 * `settings.maxGateways`, `settings.maxApis`).
 *
 * A quota check is a COUNT followed by an INSERT. Run unserialised, two
 * writers for the same organization both count N-1, both pass, and the
 * organization ends at N+1 -- and a batch racing a batch overshoots by
 * the whole batch. The fix is the classic one: check and insert in one
 * transaction that first takes a lock every other writer for that
 * organization and resource also takes.
 *
 * The lock is a transaction-scoped advisory lock keyed on the resource
 * and the organization id. It is released on commit or rollback, it
 * never touches the `organizations` row (so it cannot deadlock with the
 * FOR KEY SHARE locks every FK insert takes on that row, nor block a
 * settings update), and the tool, gateway and API quotas do not wait on each
 * other. Under READ COMMITTED the COUNT that follows the lock takes a
 * fresh snapshot, so it sees every row the previous holder committed.
 */
export type QuotaResource = 'tools' | 'gateways' | 'apis';

export class QuotaLockRequiresTransactionError extends Error {}

export function inTransaction(manager: EntityManager): boolean {
  return !!manager.queryRunner?.isTransactionActive;
}

/**
 * Take the quota lock for `resource` in `organizationId`, held until the
 * surrounding transaction ends. Outside a transaction an xact-scoped
 * advisory lock would be released at the end of its own statement and
 * serialise nothing, so that is refused rather than silently accepted.
 */
export async function lockQuota(
  manager: EntityManager,
  resource: QuotaResource,
  organizationId: string,
): Promise<void> {
  if (!inTransaction(manager)) {
    throw new QuotaLockRequiresTransactionError(
      `The ${resource} quota check must run inside a transaction together with the insert it guards`,
    );
  }
  await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    `quota:${resource}:${organizationId}`,
  ]);
}

/**
 * Run `work` on `manager`'s transaction when it already has one, else in
 * a new transaction. Lets a quota helper serve both callers that own a
 * transaction (runner / memory publishers) and callers that do not.
 */
export function inQuotaTransaction<T>(
  manager: EntityManager,
  work: (tx: EntityManager) => Promise<T>,
): Promise<T> {
  return inTransaction(manager) ? work(manager) : manager.transaction(work);
}
