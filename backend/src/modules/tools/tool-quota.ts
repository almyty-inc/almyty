import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Organization } from '../../entities/organization.entity';
import { Tool } from '../../entities/tool.entity';

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
 * Every code path that inserts a Tool row calls `assertToolQuota` first,
 * with the number of NEW rows it is about to write (rows it updates in
 * place do not count). `tool-quota-is-enforced.guard.spec.ts` reads the
 * tree and fails when a file creates Tool rows without calling it.
 *
 * Bulk policy: REJECT, never truncate. A batch (schema import, MCP sync,
 * runner publish) that would take the organization over its limit is
 * refused as a whole before anything is written, with an error naming
 * how many tools it needed and how many are left. Truncating would leave
 * an API with an arbitrary subset of its operations as tools, which is
 * worse to debug than a clear refusal.
 *
 * The count is a real COUNT(*) on `tools`, not a loaded relation. It is
 * not serialised against concurrent writers: two batches racing for the
 * last few slots can overshoot by at most one batch. The per-schema cap
 * below bounds how large that overshoot can be.
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

/** Remaining tool slots for the organization; Infinity when unlimited. */
export async function remainingToolQuota(
  manager: EntityManager,
  organizationId: string,
): Promise<number> {
  const organization = await manager
    .getRepository(Organization)
    .findOne({ where: { id: organizationId } });
  const maxTools = organization?.settings?.maxTools;
  if (!maxTools) return Infinity;
  const current = await manager.getRepository(Tool).count({ where: { organizationId } });
  return Math.max(0, maxTools - current);
}

/**
 * Throw ToolQuotaExceededException unless the organization can take
 * `adding` more tools. Pass the caller's transactional EntityManager
 * when the insert runs inside a transaction, so rows it deleted first
 * are not counted.
 */
export async function assertToolQuota(
  manager: EntityManager,
  organizationId: string,
  adding = 1,
): Promise<void> {
  if (adding <= 0) return;
  const remaining = await remainingToolQuota(manager, organizationId);
  if (adding <= remaining) return;
  throw new ToolQuotaExceededException(
    adding === 1
      ? 'Organization has reached tool limit'
      : `Organization has reached tool limit: this would add ${adding} tools and only ${remaining} remain`,
  );
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
