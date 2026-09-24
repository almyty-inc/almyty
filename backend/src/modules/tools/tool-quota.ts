import { BadRequestException } from '@nestjs/common';
import { EntityManager, In, Not } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { Tool, ToolStatus } from '../../entities/tool.entity';
import { inQuotaTransaction, lockQuota } from '../../common/quota/org-quota-lock';
import { isUniqueViolation } from '../../common/utils/unique-violation';

/**
 * The one place an organization's tool quota is enforced.
 *
 * `Organization.settings.maxTools` used to be checked only by
 * `Organization.canAddMoreTools()`, which compares against the `tools`
 * relation -- a relation no caller ever loaded, so the check read
 * `undefined.length || 0` and always passed. And only manual creation
 * called it at all: schema-generated tools, MCP-synced tools, Tool Hub
 * installs and runner / memory capability rows were never checked.
 *
 * Every code path that inserts a Tool row does so through
 * `withToolQuota` (or `assertToolQuota` on a transaction it already
 * owns), with the number of NEW rows it is about to write (rows it
 * updates in place do not count). `tool-quota-is-enforced.guard.spec.ts`
 * reads the tree and fails when a file creates Tool rows without it.
 *
 * Bulk policy: REJECT, never truncate. A batch (schema import, MCP sync,
 * runner publish) that would take the organization over its limit is
 * refused as a whole before anything is written, with an error naming
 * how many tools it needed and how many are left. Truncating would leave
 * an API with an arbitrary subset of its operations as tools, which is
 * worse to debug than a clear refusal.
 *
 * The count is a real COUNT(*) on `tools`, not a loaded relation, and it
 * is serialised: `withToolQuota` runs the check and the caller's insert
 * in one transaction that first takes a per-organization advisory lock
 * (`pg_advisory_xact_lock`, see `lockQuota`). A second writer for the
 * same organization blocks on that lock until the first commits, then
 * counts the rows the first wrote. Two batches racing for the last
 * slots can no longer both pass.
 *
 * Generated batches (schema import, "generate tools from API") go through
 * `writeToolBatch`, which checks and writes the whole batch under the
 * lock, so a batch that does not fit is refused before any of it lands
 * rather than stopping partway when a concurrent writer takes the slots.
 *
 * `precheckToolQuota` is the unlocked form, for bulk paths that want to
 * refuse a whole batch before doing any work. It is advisory only; the
 * locked check behind it is what holds under concurrency.
 */

/**
 * Hard ceiling on tools produced from one schema or one MCP server,
 * independent of the organization's quota. The largest real specs we
 * import (Stripe, ~600 operations) sit well under it. A request that
 * would exceed it is rejected; select a subset of operations instead.
 */
export const MAX_TOOLS_PER_SCHEMA = 1000;

/**
 * Descriptions derived from a schema, a remote MCP server or a Tool Hub
 * template are truncated to this many characters (ellipsis included).
 * A tool description is shipped to every LLM that lists the tool, so an
 * unbounded one is both a storage and a prompt-cost problem.
 */
export const MAX_GENERATED_DESCRIPTION_LENGTH = 4000;

export class ToolQuotaExceededException extends BadRequestException {}

/**
 * Tools the organization holds. Deleting a tool is a soft delete
 * (`status = 'deleted'`, the row stays for history and the name is freed
 * by the partial `tools_org_name_uq` index), so a deleted row must not
 * use up a slot: an organization that deleted tools to make room would
 * otherwise still be counted at its old total.
 */
export function countLiveTools(manager: EntityManager, organizationId: string): Promise<number> {
  return manager.getRepository(Tool).count({ where: { organizationId, status: Not(ToolStatus.DELETED) } });
}

/** Remaining tool slots for the organization; Infinity when unlimited. */
export async function remainingToolQuota(
  manager: EntityManager,
  organizationId: string,
): Promise<number> {
  const maxTools = await maxToolsFor(manager, organizationId);
  if (!maxTools) return Infinity;
  const current = await countLiveTools(manager, organizationId);
  return Math.max(0, maxTools - current);
}

async function maxToolsFor(manager: EntityManager, organizationId: string): Promise<number | undefined> {
  const organization = await manager
    .getRepository(Organization)
    .findOne({ where: { id: organizationId } });
  return organization?.settings?.maxTools;
}

function quotaExceeded(adding: number, remaining: number): ToolQuotaExceededException {
  return new ToolQuotaExceededException(
    adding === 1
      ? 'Organization has reached tool limit'
      : `Organization has reached tool limit: this would add ${adding} tools and only ${remaining} remain`,
  );
}

/**
 * Unlocked check: throw unless the organization can take `adding` more
 * tools right now. For bulk paths that refuse a whole batch before any
 * work starts. NOT an enforcement point on its own -- a concurrent
 * writer can take the slots between this and the insert. The insert
 * itself goes through `withToolQuota`.
 */
export async function precheckToolQuota(
  manager: EntityManager,
  organizationId: string,
  adding = 1,
): Promise<void> {
  if (adding <= 0) return;
  const remaining = await remainingToolQuota(manager, organizationId);
  if (adding <= remaining) return;
  throw quotaExceeded(adding, remaining);
}

/**
 * The enforcing check. `manager` must be inside a transaction, and the
 * caller's Tool inserts must run on that same transaction after this
 * returns: it takes the organization's tool-quota lock (held to commit),
 * then counts. Pass the transaction the insert runs on, so rows it
 * deleted first are not counted. Most callers want `withToolQuota`.
 */
export async function assertToolQuota(
  manager: EntityManager,
  organizationId: string,
  adding = 1,
): Promise<void> {
  if (adding <= 0) return;
  // An unlimited organization needs no lock: nothing to overshoot.
  const maxTools = await maxToolsFor(manager, organizationId);
  if (!maxTools) return;
  await lockQuota(manager, 'tools', organizationId);
  const current = await countLiveTools(manager, organizationId);
  const remaining = Math.max(0, maxTools - current);
  if (adding <= remaining) return;
  throw quotaExceeded(adding, remaining);
}

/**
 * Check the quota for `adding` new tools and run `insert` in the same
 * transaction, under the organization's tool-quota lock. Reuses
 * `manager`'s transaction when it has one. `insert` must write through
 * the `tx` it is given; a write on any other manager escapes the lock.
 */
export function withToolQuota<T>(
  manager: EntityManager,
  organizationId: string,
  adding: number,
  insert: (tx: EntityManager) => Promise<T>,
): Promise<T> {
  return inQuotaTransaction(manager, async (tx) => {
    await assertToolQuota(tx, organizationId, adding);
    return insert(tx);
  });
}

/** Rows per INSERT / UPDATE statement when a batch is written. */
const BATCH_WRITE_CHUNK = 50;

/**
 * A generated batch (a schema import, "generate tools from API"): new
 * rows to insert and loaded rows to update.
 */
export interface ToolBatch {
  creates: Tool[];
  updates: Tool[];
}

export interface ToolBatchResult {
  created: Tool[];
  updated: Tool[];
  /** Creates not written: a duplicate name in the batch, or `onNameTaken` declined. */
  skipped: Tool[];
}

/**
 * Write a whole generated batch, all-or-nothing against the quota.
 *
 * The per-row form (`withToolQuota` around each insert) lets two batches
 * racing for the last slots interleave: both pass their unlocked
 * precheck, then each insert takes a slot until the quota runs out, and
 * the loser stops partway with an arbitrary subset of its operations as
 * tools. Here the batch is checked and written in one transaction under
 * the organization's tool-quota lock: it fits whole, or it is refused
 * before any row -- insert or update -- is written.
 *
 * Callers build every row first (the slow part: parameters, schemas) and
 * hand them over; only the writes run under the lock. A create whose name
 * a live tool has taken since the caller looked is handed to
 * `onNameTaken` with that row: return the row to update instead, or null
 * to skip it. The names are read after the lock, so for a limited
 * organization no quota-checked writer can take one in between. An
 * unlimited organization is not serialised, so a unique violation there
 * retries the batch once, which reads the names again.
 */
export async function writeToolBatch(
  manager: EntityManager,
  organizationId: string,
  batch: ToolBatch,
  onNameTaken: (existing: Tool, built: Tool) => Tool | null,
): Promise<ToolBatchResult> {
  const attempt = () =>
    inQuotaTransaction(manager, async (tx) => {
      const repo = tx.getRepository(Tool);
      if (await maxToolsFor(tx, organizationId)) await lockQuota(tx, 'tools', organizationId);

      const names = [...new Set(batch.creates.map((t) => t.name))];
      const live = names.length
        ? await repo.find({ where: { organizationId, name: In(names), status: Not(ToolStatus.DELETED) } })
        : [];
      const taken = new Map(live.map((t) => [t.name, t] as const));

      const created: Tool[] = [];
      const updated = [...batch.updates];
      const skipped: Tool[] = [];
      const planned = new Set<string>();
      for (const built of batch.creates) {
        const existing = taken.get(built.name);
        const merged = existing ? onNameTaken(existing, built) : null;
        if (merged) updated.push(merged);
        else if (existing || planned.has(built.name)) skipped.push(built);
        else {
          planned.add(built.name);
          created.push(built);
        }
      }

      await assertToolQuota(tx, organizationId, created.length);
      if (updated.length) await repo.save(updated, { chunk: BATCH_WRITE_CHUNK });
      if (created.length) await repo.save(created, { chunk: BATCH_WRITE_CHUNK });
      return { created, updated, skipped };
    });

  try {
    return await attempt();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return attempt();
  }
}

/** Reject a single schema / server that would produce too many tools. */
export function assertWithinPerSchemaCap(count: number, source: string): void {
  if (count <= MAX_TOOLS_PER_SCHEMA) return;
  throw new ToolQuotaExceededException(
    `${source} would produce ${count} tools; the limit per schema is ${MAX_TOOLS_PER_SCHEMA}. ` +
      'Select a subset of operations.',
  );
}

/** Truncate a schema-derived description, marking the cut with an ellipsis. */
export function capGeneratedDescription(description: string): string;
export function capGeneratedDescription(description: string | null | undefined): string | null | undefined;
export function capGeneratedDescription(description: string | null | undefined): string | null | undefined {
  if (typeof description !== 'string' || description.length <= MAX_GENERATED_DESCRIPTION_LENGTH) {
    return description;
  }
  return `${description.slice(0, MAX_GENERATED_DESCRIPTION_LENGTH - 1)}…`;
}
