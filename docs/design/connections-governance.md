# Connections governance (EE)

The Connections layer follows one rule: safety is free, governance is
paid. Everything a single team needs to connect safely ships in the
Apache core: the connector catalog and connect methods, the single
credential store, validation and health, grants with user and agent
principals, the `allowUserScopedConnections` toggle, audit events,
manual rotation and disconnect. What an organization needs to govern
many teams ships under the `connections_governance` entitlement in
`backend/ee/modules/connections-governance` (Business and Enterprise
plans):

| Concern | Core (free) | EE governance (paid) |
|---------|-------------|----------------------|
| Who may use a connection | grants to `user` and `agent` principals; `team`, `role`, `workspace` rows honoured when present | team and role principals kept in step with SSO/SCIM groups |
| Grant budgets | `budgetId` stored and validated | enforced at resolve time (`CONNECTION_BUDGET_EXHAUSTED`) |
| Org-wide rules | the `allowUserScopedConnections` toggle | connector allow/deny lists, scope rules, expiry rules, rotation rules |
| Oversight | masked list, per-connection grants | review dashboard of user-scoped connections granted to agents and workspaces, one-click revoke |
| Rotation | manual, in place | scheduled, through provider APIs, with manual fallbacks reported to owners |
| Expiry | provider `expiresAt` on the row | maximum secret age, warnings, enforcement that revokes grants |
| Audit | `connection_*` events, in-app query | export of the connections event stream (JSON, CSV) with an Annex IV mapping, retention window |

An org without the entitlement gets exactly the core behaviour, whatever
policy rows it holds: the hook and the sweep check the entitlement per
organization at call time, and every HTTP route answers 402.

## Storage

`connection_policies` (migration `1750764000000-ConnectionsGovernance`,
entity `backend/src/entities/connection-policy.entity.ts`):

| Column | Meaning |
|--------|---------|
| `organizationId` | owning org; cascade on delete |
| `kind` | `connector_allowlist`, `connector_denylist`, `scope_rule`, `expiry_rule`, `rotation_rule` |
| `name` | optional label |
| `rule` | json, validated per kind before write (`connection-policy.rules.ts`) |
| `enabled` | disabled rows are kept but never evaluated |
| `createdBy` | actor |

Enabled policies are read through a per-process cache of 30 seconds per
organization, dropped by every write in the same process.

## Rules

Every rule below is one row. Several rows of one kind combine as
described; a `PATCH` may change `rule`, `name` and `enabled` but not
`kind`.

### `connector_allowlist`

```json
{ "kind": "connector_allowlist", "rule": { "connectorKeys": ["openai", "anthropic", "aws"], "owners": ["org"] } }
```

Applies to connect and rotate. When at least one allow list applies to
the owner (`owners` absent means both `org` and `user`), the connector
must be on one of them; the lists are unioned. Without an allow list
every connector may be connected.

### `connector_denylist`

```json
{ "kind": "connector_denylist", "rule": { "connectorKeys": ["openrouter"], "owners": ["user"] } }
```

A deny list hit refuses the connect whatever the allow lists say.

### `scope_rule`

```json
{ "kind": "scope_rule", "rule": { "principalKinds": ["agent", "workspace"], "environments": ["production"], "requireOwner": "org", "approvedConnectorsOnly": true } }
```

"Production agents and workspaces may only use organization-scoped
connections from approved connectors." Evaluated on every resolve, after
the grant check allowed the use, so a rule can only narrow what grants
permit. A use counts as the kinds of its run context: `agent` when an
agent runs, `workspace` when it runs in a workspace, `team` or `role`
when a team or role grant carried the decision, `user` otherwise. The
environment is the agent's `metadata.environment` (or
`settings.environment`, or `production` when `metadata.tags` contains
it); a rule without `environments` applies everywhere, a rule with them
never applies to a run whose environment is unknown. `requireOwner:
'org'` refuses user-scoped connections; `approvedConnectorsOnly`
additionally requires the connector to be on an enabled allow list for
org connections, and refuses when the org has no such list.

### `expiry_rule`

```json
{ "kind": "expiry_rule", "rule": { "maxAgeDays": 90, "warnDays": 7, "enforce": true } }
```

The secret's age counts from `metadata.secretRotatedAt` (else
`metadata.rotatedAt`, else `createdAt`). Inside the last `warnDays`
owners are notified (`connections.expiring`). Past `maxAgeDays` the row
is marked `healthStatus: expired` with the reason in `healthError`, a
`connection_validate` event with `source: governance.expiry` is
written, and owners are notified (`connections.expired`). With
`enforce` every grant on the connection is revoked as well
(`connection_revoke_grant`, `via: governance.expiry`), so nothing keeps
resolving it until it is rotated. Rows already `expired` are left
alone. Several expiry rules: the smallest `maxAgeDays` wins, together
with its `enforce`.

### `rotation_rule`

```json
{ "kind": "rotation_rule", "rule": { "connectorKeys": ["openai"], "everyDays": 30, "requireProviderApi": true } }
```

A connection whose secret is `everyDays` or older is due. Connectors
that rotate through their provider API (catalog `capabilities` contains
`rotate`, or the rotator seam says so) are rotated by the sweep and the
outcome is written as `connection_rotate` with `source:
governance.schedule`. Connectors without API rotation are reported to
their owners (`connections.rotation_due`) as manual rotations.
`connectorKeys` absent means every connector; several rules: the
smallest `everyDays` among the matching ones wins.

## HTTP

All under `/ee/connections`, owner/admin, entitlement
`connections_governance` (402 without it), org from the JWT user or the
`X-Organization-Id` header.

| Route | Does |
|-------|------|
| `GET /policies`, `POST /policies`, `GET /policies/:id`, `PATCH /policies/:id`, `DELETE /policies/:id` | rule CRUD; invalid rules answer 400 `CONNECTION_POLICY_INVALID` with `errors[]` |
| `GET /review?environment=production\|any` | user-scoped connections currently granted to agents or workspaces: connection (masked, health, `secretSetAt`), owner, unexpired grants with the agent's name and environment, last `connection_resolve` |
| `POST /review/:connectionId/revoke-grants { principalTypes? }` | revokes the agent and workspace grants (default) on that connection |
| `GET /expiring` | the warn and expire lists the sweep would act on, without acting |
| `POST /expiring/enforce` | runs the expiry enforcement now for the org |
| `GET /rotate-due` | the due and manual lists |
| `POST /rotate-due` | runs the scheduled rotation now for the org |
| `POST /principals/sync` | aligns `user_teams` with the identity provider's groups |
| `GET /audit-export?format=json\|csv&from&to&limit` | the connections event stream, see below |

Policy changes are audited as `create` / `update` / `delete` on resource
`organization` with `resourceName: connection_policy:<kind>` and the
full rule in `details`.

## Audit export and retention

`GET /ee/connections/audit-export` collects, newest first and capped at
50,000 rows, every audit row on resources `connection` and `connector`
plus the `connection_policy:*` rows above. JSON wraps the events in the
same envelope as the agent technical documentation export
(`documentType: connections-audit-export`, `standard: EU AI Act Annex
IV (informative mapping)`) with an `annexIvMapping` that says which
events answer which Annex IV item, and a `retention` block. CSV uses
the audit exporter's column order (`id, createdAt, organizationId,
userId, userEmail, action, resourceType, resourceId, resourceName,
status, ipAddress, details`) with RFC 4180 quoting. Both carry
`X-Audit-Export-Count` and `X-Audit-Retention-Days`.

Retention: `CONNECTIONS_AUDIT_RETENTION_DAYS` (unset means keep
everything). When set, the nightly sweep deletes `connection` and
`connector` events older than the window for every licensed org with an
enabled expiry rule and writes one `retention_sweep` event with the
count. Policy events are kept.

## Team and role principals

Nothing new is stored. SCIM groups already land as `teams` +
`user_teams` (`ScimService.createGroup` / `patchGroup`), and a grant to
a `team` or `role` principal matches through the principal's `teamIds`
and `roles`. `GroupPrincipalSyncService.principalsFor(user,
organizationId)` is the one answer to "which teams and roles does this
user hold right now" (active membership, active teams of that org), so
a user removed from an IdP group stops matching the team's grants on
the next resolve. `syncGroups(organizationId)` re-reads the org's
groups through `ScimService.listGroups` and activates or deactivates
`user_teams` rows to match; it is exposed as `POST
/ee/connections/principals/sync` for an admin who wants to force it
between IdP pushes.

## Scheduler

Queue `connections-governance`, two repeatable jobs with stable ids
(`connections-governance-expiry`, `connections-governance-rotation`),
cron from `CONNECTIONS_GOVERNANCE_CRON` (default `0 3 * * *`, `off`
disables), never registered under `NODE_ENV=test`. A changed cron evicts
the previous registration at boot; a Redis failure at boot is logged and
does not stop the API. Each job iterates the organizations that hold an
enabled rule of its kind, skips those without the entitlement, and
isolates failures per org. The expiry job runs `enforceExpiry` then the
retention sweep; the rotation job runs `rotateDue`.

## Seams into core

Every seam is an injection token with an interface in `seams.ts` and a
default binding, so the module boots on its own; the lead swaps the real
service in with one provider line.

| Token | Interface | Default | Wire with |
|-------|-----------|---------|-----------|
| `CONNECTIONS_GOVERNANCE_HOOK` | `beforeConnect(orgId, connectorKey, owner)`, `beforeUse(orgId, connection, principal, context, decision)`, `evaluateUse(...)` | the module's implementation | core calls it `@Optional()` at the two sites below |
| `CONNECTION_GRANT_REVOKER` | `revoke(grantId, actor, organizationId)`, `invalidate(connectionId)` | none: rows removed directly, same audit event | `{ provide: CONNECTION_GRANT_REVOKER, useExisting: GrantsService }` |
| `CONNECTION_ROTATOR` | `rotate(connectionId) -> { rotated, manual?, error? }`, `canRotate?(connectorKey)` | `NoopConnectionRotator`: nothing rotates, everything is manual | `{ provide: CONNECTION_ROTATOR, useExisting: RotationService }` |
| `CONNECTION_PRINCIPAL_SOURCE` | `principalsFor(user, organizationId) -> { teamIds, roles }` | `GroupPrincipalSyncService` | `GrantsService.principalFor` reads it `@Optional()` |

Call sites in core (both `@Optional() @Inject(CONNECTIONS_GOVERNANCE_HOOK)`):

- `ConnectionsService.connect` and `rotate`, before the row is written:
  `await this.governance?.beforeConnect(organizationId, connector.key, owner)`.
- `ConnectionsResolverService.resolveForUse`, after
  `const decision = await this.grants.assertCanUse(principal, row, context)`
  and before `materialize` / `recordResolve`:
  `await this.governance?.beforeUse(row.organizationId, row, { userId: principal.id, agentId: context.agentId, workspaceId: context.workspaceId }, context, decision)`.

Refusals are `ForbiddenException` with `code: CONNECTION_POLICY_DENIED`
(`reason`, `policyId`) or `CONNECTION_BUDGET_EXHAUSTED` (`budgetId`,
`spentCents`, `limitCents`).

Notification types emitted: `connections.expiring`,
`connections.expired`, `connections.rotation_due`; the pipeline applies
its in-app + email defaults until they are added to
`NOTIFICATION_EVENT_TYPES`.
