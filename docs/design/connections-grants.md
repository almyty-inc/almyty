# Connections: grants

Gate 2 of the Connections layer. A connection (a `credentials` row with a
`connectorKey`) is owned by an organization or by one user. Anything that
is not the owner uses it only through a grant, and every resolve-for-use
is audited as principal x connection x run.

Gate 1 (`docs/design/connections.md`) covers the connector catalog,
connect methods and the resolver seam. Gate 3 moves the consumers (LLM
providers, deployment adapters, memory backends, MCP sources) onto that
seam.

## Vocabulary

| Term | Meaning |
|------|---------|
| Owner | `org` (row has no `ownerUserId`) or `user` (`ownerUserId` set). Never a team, agent or workspace. |
| Principal | Who is asking: a user with their org role and team memberships, plus the run context (agent, workspace). |
| Grant | One `connection_grants` row: (connection, principalType, principalId) with `use` or `manage`, optional expiry and budget. |
| `connections:manage` | The org permission owners and admins hold (EE custom roles may add it to a membership). |

## Storage

Table `connection_grants` (migration `1750762000000-ConnectionGrants`):

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | |
| `organizationId` | uuid | FK organizations, cascade |
| `connectionId` | uuid | FK credentials, cascade: disconnecting removes every grant |
| `principalType` | `user`, `team`, `role`, `agent`, `workspace` | check constraint |
| `principalId` | varchar(64) | uuid, or the role name for `role` |
| `permission` | `use`, `manage` | default `use` |
| `budgetId` | uuid, nullable | FK spend_budgets, set null; stored for EE, not enforced in core |
| `grantedBy` | uuid, nullable | |
| `createdAt` | timestamptz | |
| `expiresAt` | timestamptz, nullable | an expired grant counts as absent |

Unique on (`connectionId`, `principalType`, `principalId`): re-granting the
same principal refreshes permission, budget and expiry in place.

Entity: `backend/src/entities/connection-grant.entity.ts`.

## Principal

`GrantsService.principalFrom(req, context)` builds:

| Field | Source |
|-------|--------|
| `userId` | JWT user |
| `roles` | the user's role in the connection's organization (`owner`, `admin`, `member`, `viewer`) |
| `permissions` | the membership row's `permissions` column (EE custom roles) |
| `teamIds` | active `user_teams` rows joined to teams of that organization |
| `agentId`, `workspaceId` | the run context |

The resolver seam passes the request user through; `assertCanUse` builds
the principal itself when it is handed a JWT user rather than a prebuilt
one. A resolver context naming an agent or workspace as its resource
(`resourceType: 'agent', resourceId`) is treated as that run context.

## Rules

Pure functions in `backend/src/modules/connections/grants/grant-check.ts`.
Both return `{ allowed, reason, via?, grant? }`; refusals always carry a
reason string.

### `canUse(connection, principal, grants, context)`

Checked top to bottom; the first row that applies decides.

| Connection | Principal | Decision |
|------------|-----------|----------|
| user-scoped | its owner | allow, `via: owner` |
| team-visibility (`visibility = team`) | not a member of `teamId` and without `connections:manage` | deny `not a member of the connection team` |
| org-scoped | has `connections:manage` | allow, `via: connections:manage` |
| any | has a matching, unexpired `use` or `manage` grant | allow, `via: grant` |
| user-scoped | anyone else, admins included | deny `no grant on this user-scoped connection` |
| org-scoped | anyone else | deny `no grant on this org-scoped connection` |

### `canManage(connection, principal, grants, context)`

| Connection | Principal | Decision |
|------------|-----------|----------|
| user-scoped | its owner | allow |
| team-visibility | not a member of `teamId` and without `connections:manage` | deny |
| org-scoped | has `connections:manage` | allow |
| any | has a matching, unexpired `manage` grant | allow |
| user-scoped | anyone else, admins included | deny `only the owner or a manage grant can manage a user-scoped connection` |
| org-scoped | anyone else | deny `connections:manage or a manage grant is required` |

### Grant matching

| `principalType` | Matches when |
|-----------------|--------------|
| `user` | `principalId === principal.userId` |
| `team` | `principal.teamIds` contains `principalId` |
| `role` | `principal.roles` contains `principalId` |
| `agent` | the run context's `agentId` (context wins over the principal's own) equals `principalId` |
| `workspace` | the run context's `workspaceId` equals `principalId` |

`expiresAt <= now` makes a grant invisible to both checks. Several
matching grants sort `manage` first so the strongest one is reported.

### Who may add a grant (service layer)

On top of `canManage`, `GrantsService.grant` checks the target:

| Target | Must | Without `connections:manage`, additionally |
|--------|------|--------------------------------------------|
| `user` | be an active member of the organization | |
| `team` | exist in the organization | |
| `role` | be one of `owner`, `admin`, `member`, `viewer` | |
| `agent` | exist in the organization | be an agent the actor created |
| `workspace` | exist in the organization | be a workspace the actor owns |
| `budgetId` | belong to the organization | |

So a member grants their own user-scoped connection to their own agent
with no admin involved; binding it to somebody else's agent is an admin
decision.

### Who may list and revoke

`canManage`, plus one exception: `connections:manage` may list and
revoke (never add) grants on a user-scoped connection. An admin can stop
a personal secret from being shared without being able to hand it out.

| Connection | Actor | list | grant | revoke |
|------------|-------|------|-------|--------|
| user-scoped | owner | yes | yes | yes |
| user-scoped | `manage` grant holder | yes | yes | yes |
| user-scoped | `connections:manage` | yes | no | yes |
| user-scoped | anyone else | no | no | no |
| org-scoped | `connections:manage` | yes | yes | yes |
| org-scoped | `manage` grant holder (team member when team-visibility) | yes | yes | yes |
| org-scoped | anyone else | no | no | no |

### Defaults that follow from the tables

- A plain member does not use an org-scoped connection until something
  grants it. To make a connection org-wide, grant `role: member` (and
  `role: viewer` if viewers run agents).
- Owners and admins use every org-scoped connection without a grant.
- A user-scoped connection is invisible to everyone but its owner until
  the owner grants it, typically to one of their agents.

## HTTP

All under `JwtAuthGuard` + `RolesGuard`, roles member / admin / owner,
permission `connections:read`; the per-connection decision is the
service's.

| Method | Path | Body | Result |
|--------|------|------|--------|
| GET | `/connections/:id/grants` | | `GrantView[]` |
| POST | `/connections/:id/grants` | `{ principalType, principalId, permission?, budgetId?, expiresAt? }` | `GrantView` |
| DELETE | `/connections/:id/grants/:grantId` | | the removed `GrantView` |

`GrantView`: `{ id, connectionId, principalType, principalId, permission,
budgetId, grantedBy, createdAt, expiresAt, expired }`.

Error codes: `CONNECTION_NOT_FOUND`, `CONNECTION_GRANT_FORBIDDEN`,
`GRANT_NOT_FOUND`, `GRANT_PRINCIPAL_INVALID`, `GRANT_PRINCIPAL_NOT_FOUND`,
`GRANT_AGENT_NOT_OWNED`, `GRANT_WORKSPACE_NOT_OWNED`,
`GRANT_PERMISSION_INVALID`, `GRANT_EXPIRES_INVALID`,
`GRANT_EXPIRES_IN_PAST`, `GRANT_BUDGET_NOT_FOUND`.

## The resolve seam

`ConnectionsResolverService.resolveForUse(principal, connectionId, context)`
loads the row, checks membership, then asks grants:

```ts
const decision = await this.grants.assertCanUse(principal, row, context);
// ... decrypt ...
await this.grants.recordResolve(principal, row, context, decision);
```

`assertCanUse` throws `ConnectionNotGrantedError` (a `ForbiddenException`
with `code: CONNECTION_NOT_GRANTED`, `reason`, `connectionId`) and
returns the decision otherwise. Grants are read through a per-process
cache of 30 seconds per connection, dropped by grant and revoke in the
same process; a revoke on another instance is honoured within 30
seconds. Expiry is evaluated against the clock on every call, cached or
not.

`recordResolve` writes one `CONNECTION_RESOLVE` audit row per use:

```
{ principal: { userId, agentId, workspaceId }, connectionId, connectorKey,
  owner, runId, agentId, workspaceId, purpose, via, grantId }
```

Grant and revoke write `CONNECTION_GRANT` and `CONNECTION_REVOKE_GRANT`
on the connection with the grant's principal, permission, budget, expiry
and how the actor was authorised (`via`).

The system path `resolveForOrg` (schedulers, reconcile loops) is
unchanged: org-owned connections resolve for the organization; a
user-owned one needs `actorUserId` to be its owner, or a grant to the
run's agent or workspace once the caller passes that context.

## Where the EE governance module hangs off

Core keeps every principal type stored and evaluated: `user` and
`agent` principals are fully self-service, and `team`, `role` and
`workspace` grants are honoured whenever the rows exist. Nothing here is
gated behind an entitlement. The EE module adds the sources and the
enforcement:

| Concern | Core | EE governance |
|---------|------|---------------|
| Team and role membership | manual teams, the four built-in roles | SCIM / SSO group sync writes `user_teams` and custom roles with `connections:manage`; grants keep matching without change |
| `budgetId` | stored, validated against `spend_budgets`, returned in views | enforced at resolve time: a grant whose budget is exhausted is refused with `CONNECTION_BUDGET_EXHAUSTED` before the secret is decrypted |
| Policy rules | the tables above | a policy hook between `canUse` and the decision (for example: no user-scoped connection may be granted to a workspace on a shared runner; agents in a `restricted` team may only use team-visibility connections) |
| Audit | `CONNECTION_GRANT`, `CONNECTION_REVOKE_GRANT`, `CONNECTION_RESOLVE` rows | SIEM streaming through the existing audit hook |
| Approvals | | a grant to a `role` or `team` on an org-scoped connection can require an approval before it becomes active (`expiresAt` and a pending state on the same row) |

The hook shape the EE module implements is a single optional provider
consulted by `GrantsService.assertCanUse` after `canUse` allows:
`beforeUse(decision, connection, principal, context): Promise<void>` that
throws a `ConnectionNotGrantedError` subclass to refuse. It is not
declared in core until the EE module lands; the call site is the single
`return decision` at the end of `assertCanUse`.
