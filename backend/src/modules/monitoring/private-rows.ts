/**
 * Analytics rows that belong to someone else's private resource.
 *
 * Request logs, usage metrics and conversations are keyed by gateway or
 * provider id. A per-gateway or per-provider breakdown, a log line with a
 * private gateway's path, or an export row naming a private provider tells
 * another member -- an org admin included -- that the "just me" resource
 * exists and how it is used. These fragments drop such rows; the caller's
 * own private resources stay in.
 *
 * Each binds `:privateViewerId`. A null column (a row with no gateway or
 * no provider) is kept: it belongs to no private resource.
 */
export function notOthersPrivateGateway(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM gateways pg WHERE pg.id = ${column} ` +
    `AND pg.visibility = 'private' AND pg."ownerUserId" IS DISTINCT FROM :privateViewerId)`;
}

export function notOthersPrivateProvider(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM llm_providers pp WHERE pp.id = ${column} ` +
    `AND pp.visibility = 'private' AND pp."ownerUserId" IS DISTINCT FROM :privateViewerId)`;
}

export function notOthersPrivateTool(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM tools pt WHERE pt.id = ${column} ` +
    `AND pt.visibility = 'private' AND pt."createdBy" IS DISTINCT FROM :privateViewerId)`;
}

export function notOthersPrivateAgent(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM agents pa WHERE pa.id = ${column} ` +
    `AND pa.visibility = 'private' AND pa."createdBy" IS DISTINCT FROM :privateViewerId)`;
}
