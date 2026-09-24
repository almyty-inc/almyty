import { EntityManager } from 'typeorm';

/**
 * A connection a member made for themselves (Personal or Private): a
 * credentials row with a connectorKey and an owner, that no consumer
 * manages. A row an LLM provider or MCP source manages for itself
 * (metadata.managedBy) follows its consumer, so it is not one.
 */
export function memberConnectionSql(): string {
  return `("connectorKey" IS NOT NULL AND NOT COALESCE((metadata::jsonb) ? 'managedBy', false))`;
}

/**
 * A member connection as it was the moment it was wiped: `previousConfig`
 * still holds the (encrypted) secrets, so the grant can be revoked at the
 * provider once the wipe has committed. Held in memory only, never
 * written anywhere.
 */
export interface WipedConnection {
  id: string;
  organizationId: string;
  name: string | null;
  visibility: string | null;
  connectorKey: string | null;
  metadata: Record<string, any> | null;
  previousConfig: Record<string, any> | null;
  grantsRemoved: number;
}

type Row = Omit<WipedConnection, 'grantsRemoved'>;

/** manager.query on an UPDATE/DELETE ... RETURNING yields [rows, rowCount]. */
function returned<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[];
  return Array.isArray(result) ? (result as T[]) : [];
}

/**
 * Wipe a departing person's own connections in `organizationId` (every
 * organization when null): the stored secret is emptied, the row is
 * marked revoked and inactive, and every grant on it is dropped. The row
 * stays, so whatever referenced it fails visibly and can be reconnected.
 *
 * Runs on the caller's manager (inside its transaction). What it returns
 * carries the secrets as they were, for `ConnectionOffboardingService.
 * revokeAtProviders` to use after commit: nothing is sent to a provider
 * from inside a transaction.
 */
export async function wipeMemberConnections(
  manager: EntityManager,
  args: { organizationId: string | null; ownerUserId: string; healthError: string },
): Promise<WipedConnection[]> {
  const { organizationId, ownerUserId, healthError } = args;
  const params: unknown[] = organizationId ? [organizationId, ownerUserId] : [ownerUserId];
  const scope = organizationId ? `"organizationId" = $1 AND "ownerUserId" = $2` : `"ownerUserId" = $1`;
  const rows = returned<Row>(
    await manager.query(
      `WITH target AS (
         SELECT id, config AS "previousConfig" FROM credentials
          WHERE ${scope} AND ${memberConnectionSql()}
          FOR UPDATE
       )
       UPDATE credentials c
          SET config = '{}'::json, "isActive" = false, "healthStatus" = 'revoked',
              "healthError" = $${params.length + 1}, "healthCheckedAt" = now()
         FROM target
        WHERE c.id = target.id
        RETURNING c.id, c."organizationId", c.name, c.visibility, c."connectorKey", c.metadata, target."previousConfig"`,
      [...params, healthError],
    ),
  );
  if (rows.length === 0) return [];

  const removed = returned<{ id: string; connectionId: string }>(
    await manager.query(
      `DELETE FROM connection_grants WHERE "connectionId" = ANY($1::uuid[]) RETURNING id, "connectionId"`,
      [rows.map((r) => r.id)],
    ),
  );
  return rows.map((row) => ({
    ...row,
    grantsRemoved: removed.filter((g) => g.connectionId === row.id).length,
  }));
}
