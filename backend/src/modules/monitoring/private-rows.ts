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
 * (no known caller) keeps no private resource's rows, and a private row
 * with no recorded owner is nobody's, so it is kept from everyone.
 *
 * The owner comparison is made as text on both sides. Owner columns are
 * uuid on gateways/providers but varchar on tools/agents (`createdBy`), and
 * one query often binds `:privateViewerId` in several of these fragments:
 * Postgres gives a reused parameter one type, so an uncast mix fails with
 * "operator does not exist: character varying = uuid".
 *
 * "Not the viewer's" is `(owner = viewer) IS NOT TRUE`, not
 * `owner IS DISTINCT FROM viewer`: IS DISTINCT FROM treats two nulls as
 * equal, so an ownerless private row read by a caller with no id matched
 * as that caller's own and was shown. `=` is only true when both sides are
 * present and equal; null on either side leaves the row someone else's.
 */
const OWNER_IS_NOT_VIEWER = (ownerColumn: string) =>
  `(${ownerColumn}::text = CAST(:privateViewerId AS text)) IS NOT TRUE`;

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
/**
 * The same rows as the fragments above, plus the team tier: a row tied to
 * a team resource is kept only for an org owner/admin or an active member
 * of that team -- AccessPolicyService.canAccess, which is what the lists
 * of those resources filter by. Analytics and the onboarding guide use
 * these: a request log line, a usage row or a checklist tick for a team
 * gateway tells a member outside the team that it exists and how it is
 * used, when the gateway list itself does not show it to them.
 *
 * Membership is read the way AccessPolicyService reads it: an org
 * membership counts when it is active and not a pending invite
 * (common/authorization/membership.ts), a team membership when it is
 * active and the team is in the resource's organization. A team row with
 * no teamId is kept from everyone but owners/admins, as canAccess denies
 * it. Each binds `:privateViewerId`; a null viewer is no member and no
 * owner, so it keeps neither tier.
 */
const VIEWER = 'CAST(:privateViewerId AS text)';

function viewerMaySeeTeamRow(alias: string): string {
  return `(EXISTS (SELECT 1 FROM user_organizations vo WHERE vo."organizationId" = ${alias}."organizationId" ` +
    `AND vo."userId"::text = ${VIEWER} AND vo."isActive" IS NOT FALSE ` +
    `AND (vo."inviteAccepted" = true OR vo."inviteToken" IS NULL) AND vo.role IN ('owner', 'admin')) ` +
    `OR EXISTS (SELECT 1 FROM user_teams vt JOIN teams vtt ON vtt.id = vt."teamId" ` +
    `WHERE vt."teamId" = ${alias}."teamId" AND vtt."organizationId" = ${alias}."organizationId" ` +
    `AND vt."userId"::text = ${VIEWER} AND vt."isActive" = true))`;
}

function outsideViewerScope(alias: string, ownerColumn: string): string {
  return `((${alias}.visibility = 'private' AND ${OWNER_IS_NOT_VIEWER(`${alias}."${ownerColumn}"`)}) ` +
    `OR (${alias}.visibility = 'team' AND NOT ${viewerMaySeeTeamRow(alias)}))`;
}

export function inViewerScopeGateway(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM gateways pg WHERE pg.id = ${column} AND ${outsideViewerScope('pg', 'ownerUserId')})`;
}

export function inViewerScopeProvider(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM llm_providers pp WHERE pp.id = ${column} AND ${outsideViewerScope('pp', 'ownerUserId')})`;
}

export function inViewerScopeTool(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM tools pt WHERE pt.id = ${column} AND ${outsideViewerScope('pt', 'createdBy')})`;
}

export function inViewerScopeAgent(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM agents pa WHERE pa.id = ${column} AND ${outsideViewerScope('pa', 'createdBy')})`;
}

/** A row keyed by agent run id: dropped when the run's agent is outside the viewer's scope. */
export function inViewerScopeAgentRun(column: string): string {
  return `NOT EXISTS (SELECT 1 FROM agent_runs pr JOIN agents pra ON pra.id = pr."agentId" ` +
    `WHERE pr.id = ${column} AND ${outsideViewerScope('pra', 'createdBy')})`;
}
