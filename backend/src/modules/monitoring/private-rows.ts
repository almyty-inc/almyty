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
 * no provider) is kept: it belongs to no private resource. A null viewer
 * (no known caller) keeps no private resource's rows.
 *
 * The owner comparison is made as text on both sides. Owner columns are
 * uuid on gateways/providers but varchar on tools/agents (`createdBy`), and
 * one query often binds `:privateViewerId` in several of these fragments:
 * Postgres gives a reused parameter one type, so an uncast mix fails with
 * "operator does not exist: character varying = uuid".
 */
const OWNER_IS_NOT_VIEWER = (ownerColumn: string) =>
  `${ownerColumn}::text IS DISTINCT FROM CAST(:privateViewerId AS text)`;

export function notOthersPrivateGateway(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM gateways pg WHERE pg.id = ${column} ` +
    `AND pg.visibility = 'private' AND ${OWNER_IS_NOT_VIEWER('pg."ownerUserId"')})`;
}

export function notOthersPrivateProvider(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM llm_providers pp WHERE pp.id = ${column} ` +
    `AND pp.visibility = 'private' AND ${OWNER_IS_NOT_VIEWER('pp."ownerUserId"')})`;
}

export function notOthersPrivateTool(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM tools pt WHERE pt.id = ${column} ` +
    `AND pt.visibility = 'private' AND ${OWNER_IS_NOT_VIEWER('pt."createdBy"')})`;
}

export function notOthersPrivateAgent(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM agents pa WHERE pa.id = ${column} ` +
    `AND pa.visibility = 'private' AND ${OWNER_IS_NOT_VIEWER('pa."createdBy"')})`;
}

/** A row keyed by agent run id: dropped when the run's agent is another member's private agent. */
export function notOthersPrivateAgentRun(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM agent_runs pr JOIN agents pra ON pra.id = pr."agentId" ` +
    `WHERE pr.id = ${column} ` +
    `AND pra.visibility = 'private' AND ${OWNER_IS_NOT_VIEWER('pra."createdBy"')})`;
}