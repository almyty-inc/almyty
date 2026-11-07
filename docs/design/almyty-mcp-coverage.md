# Management MCP coverage

The management MCP is almyty's own MCP server, served at `/:org/almyty`
(`/mcp` is a different server: the organization's own API tools). It lets an AI
assistant set up and run an organization without the dashboard. This page
answers one question: can it do everything the dashboard can?

## The answer

Before the operations it covered 79 of the routes a signed-in member can
use, through 71 hand-written tools. Now it covers all 447 of them: 79
through the dedicated tools, the rest as operations. Nothing is held back:
deleting the organization, managing members and user accounts, minting API
keys, SSO, encryption keys, billing, data retention, editing a live gateway
and writing tools by hand are operations, under each route's own guards,
and the destructive ones run only through `call_destructive_operation`.
The remaining 142 routes are excluded because an MCP client must not or
cannot use them: sign-in flows, webhooks, visitor-facing chat pages, the
protocol endpoints themselves, health probes, live streams, binary
downloads, and the routes whose purpose is a secret (see
[No secret is an argument](#no-secret-is-an-argument)). The numbers below
are generated and checked in CI.

## How it works

There are two kinds of MCP tool.

**Dedicated tools** (`list_apis`, `create_agent`, `invoke_agent`,
`publish_channel` and about seventy more) cover the common journeys. Each
is written for an assistant: plain arguments, results that say what to do
next, secrets masked.

**Operations** cover everything else, without adding hundreds of tools to
the list an assistant has to read. Following the discovery design in
[code-mode.md](code-mode.md), five meta-tools reach them:

| Tool | What it does |
| --- | --- |
| `search_operations` | Keyword search over every operation: name, summary, effect, the tool that runs it |
| `get_operation` | One operation in full: summary, HTTP route, who may run it, JSON Schema of its arguments |
| `call_read_operation` | Runs an operation that only reads (`readOnlyHint: true`) |
| `call_write_operation` | Runs one that creates or changes something (`destructiveHint: false`) |
| `call_destructive_operation` | Runs one that deletes, revokes or erases (`destructiveHint: true`) |

An operation runs through the call tool for its effect, and is refused by
the other two. A client that asks the person before a destructive tool
therefore asks before every destructive operation.

### An operation is the route

An operation does not reimplement anything. `ManagementRouteInvoker`
(`backend/src/modules/mcp/management/route-invoker.service.ts`) calls the
route's own controller handler, the way Nest's router does:

- **Caller**: the user row with its memberships, as `JwtStrategy` loads it,
  fixed to the MCP endpoint's organization. Someone who is not an effective
  member of that organization is refused before anything runs. A path
  `:organizationId` is always that organization, never an argument.
- **Guards**: the ones the route declares, run as they are: `RolesGuard`
  (`@Roles`, `@Permissions`, `@RbacAction`, the EE custom-role and ABAC
  hook), `EntitlementGuard` (`@RequiresEntitlement`: 402 without the
  plan), the private-resource guards and `GatewayAuthManagementGuard`.
  Only `JwtAuthGuard` is skipped, because the MCP layer has already
  authenticated the caller.
- **Validation**: the global `ValidationPipe` with the exact options
  `main.ts` uses (`common/validation-options.ts`), `@UsePipes`, and each
  parameter's pipes. `get_operation`'s input schema is read from the same
  DTO decorators.
- **Audit and versions**: whatever the handler records, it records; the
  version-history store carries the caller, as the global interceptor
  does over HTTP.
- **Errors**: what `GlobalExceptionFilter` would send. Database errors and
  unexpected throws read as the same generic sentence.

Public routes, routes behind a non-user credential (runner, SCIM, password
login) and routes with an interceptor other than the optional upload are
refused at run time even if they were catalogued by mistake.

### Dedicated tools answer to their route too

Each dedicated tool names the REST route it mirrors
(`CURATED_TOOL_ROUTES`). Before the tool runs, that route's guards run
against the caller, so a viewer cannot delete an API over MCP when the
dashboard would refuse them. Before this change the dedicated tools
checked organization membership only where a service happened to.

### The guard

`backend/src/modules/mcp/management/__tests__/management-coverage.guard.spec.ts`
reads every controller's routes from source (EE included) and fails when a
route is in none of: a dedicated tool, `OPERATIONS`, `EXCLUDED_ROUTES`
(with a reason), `HELD_ROUTES` (with the open question). It also fails when
this page is stale: run `npm run mcp:coverage` in `backend/`.

### No secret is an argument

No dedicated tool and no operation takes a secret. `secret-arguments.ts`
names a secret the way the repo already redacts one (the version-snapshot
redaction and the tool-hub template sanitizer: `apiKey`, `token`,
`password`, `clientSecret`, `privateKey`, an `Authorization` header and
the like), and holds that in three places:

- **Excluded**: an operation whose purpose is a secret (adding, changing
  or rotating a credential, setting an API's key or credential, an OAuth
  client secret, visitor sign-in) is not an operation (`SECRET_OPERATIONS`,
  reason "Takes a secret; add it in the app"). Asking for one by name
  answers with the app page that takes it, as `start_connection` answers a
  form-based connect with the fields it wanted.
- **Dropped**: a route whose secret is optional stays an operation without
  it (`secretFields`: a current password, an MCP source's bearer token, a
  SIEM stream's token, a runner spawn's provider key).
- **Refused at call time**: every call, dedicated or operation, is refused
  when any argument at any depth is named like a secret and has a value,
  with a link to the page where it is added. That covers the free-form
  objects a DTO cannot describe (headers, auth configs, provider
  configuration). A tool's or an agent's own input (`passThrough`) is
  handed over as it is.

`secret-arguments.guard.spec.ts` fails when an operation's published
argument schema, or a dedicated tool's, has a secret-named field.

Operations that mint a key (`profile.create_api_key`,
`credentials.create_access_key`, `gateways.create_api_key`) return it once,
in plaintext, exactly as REST does: that is a secret going to the person
who asked for it, not one an assistant hands to almyty.

<!-- coverage:start -->
<!-- generated by `npm run mcp:coverage` (backend); do not edit by hand -->

## Numbers

| | Routes |
| --- | ---: |
| Controller routes (src/modules + ee/modules) | 589 |
| Excluded (an MCP client must not or cannot use them) | 142 |
| In scope | 447 |
| Covered by a dedicated tool | 79 (17.7%) |
| Covered by an operation | 368 (82.3%) |
| Covered in total | 447 (100.0%) |
| Held for a product decision | 0 (0.0%) |

## By resource

| Resource | Routes | Tool | Operation | Held | Excluded |
| --- | ---: | ---: | ---: | ---: | ---: |
| a2a | 7 | 0 | 7 | 0 | 0 |
| agent-channels | 21 | 12 | 8 | 0 | 1 |
| agent-constraints | 4 | 0 | 4 | 0 | 0 |
| agents | 65 | 10 | 46 | 0 | 9 |
| apis | 30 | 6 | 20 | 0 | 4 |
| approvals | 9 | 3 | 6 | 0 | 0 |
| audit-log | 2 | 0 | 2 | 0 | 0 |
| auth | 18 | 0 | 5 | 0 | 13 |
| budgets | 7 | 2 | 5 | 0 | 0 |
| connections | 5 | 2 | 1 | 0 | 2 |
| credentials | 21 | 4 | 11 | 0 | 6 |
| ee/approval-policies | 5 | 0 | 5 | 0 | 0 |
| ee/audit-export | 5 | 0 | 5 | 0 | 0 |
| ee/billing | 5 | 0 | 4 | 0 | 1 |
| ee/chargeback | 1 | 0 | 1 | 0 | 0 |
| ee/compliance | 3 | 0 | 3 | 0 | 0 |
| ee/connections-governance | 13 | 0 | 13 | 0 | 0 |
| ee/rbac | 12 | 0 | 12 | 0 | 0 |
| ee/sso | 31 | 0 | 7 | 0 | 24 |
| files | 5 | 0 | 3 | 0 | 2 |
| gateways | 79 | 6 | 40 | 0 | 33 |
| health | 3 | 0 | 0 | 0 | 3 |
| hosted-runners | 14 | 0 | 11 | 0 | 3 |
| kms | 4 | 0 | 4 | 0 | 0 |
| licensing | 1 | 0 | 1 | 0 | 0 |
| lifecycle | 1 | 0 | 0 | 0 | 1 |
| llm-providers | 19 | 2 | 17 | 0 | 0 |
| mcp | 22 | 0 | 0 | 0 | 22 |
| mcp-sources | 5 | 0 | 5 | 0 | 0 |
| memory | 22 | 11 | 11 | 0 | 0 |
| model-catalog | 10 | 5 | 5 | 0 | 0 |
| model-deployments | 7 | 1 | 6 | 0 | 0 |
| model-registry | 4 | 1 | 3 | 0 | 0 |
| monitoring | 19 | 6 | 8 | 0 | 5 |
| notifications | 5 | 0 | 5 | 0 | 0 |
| onboarding | 2 | 0 | 2 | 0 | 0 |
| organizations | 23 | 1 | 18 | 0 | 4 |
| promoted-skills | 5 | 0 | 5 | 0 | 0 |
| provider-usage | 3 | 0 | 3 | 0 | 0 |
| referrals | 4 | 0 | 3 | 0 | 1 |
| retention | 2 | 0 | 2 | 0 | 0 |
| runner | 21 | 1 | 12 | 0 | 8 |
| tool-hub | 9 | 2 | 7 | 0 | 0 |
| tools | 18 | 3 | 15 | 0 | 0 |
| users | 12 | 0 | 12 | 0 | 0 |
| versions | 2 | 0 | 2 | 0 | 0 |
| workspace | 4 | 1 | 3 | 0 | 0 |

## Matrix

Status: **tool** = a dedicated MCP tool; **operation** = `search_operations` / `get_operation` / `call_<effect>_operation`; **held** = waits for a product decision; **excluded** = see the next section.

| Resource | Operation (route) | MCP tool | Status |
| --- | --- | --- | --- |
| ee/approval-policies | `GET /approval-policies` (ApprovalPoliciesController.list) | `approval_policies.list` (read) | operation |
| ee/approval-policies | `POST /approval-policies` (ApprovalPoliciesController.create) | `approval_policies.create` (write) | operation |
| ee/approval-policies | `GET /approval-policies/:id` (ApprovalPoliciesController.get) | `approval_policies.get` (read) | operation |
| ee/approval-policies | `PATCH /approval-policies/:id` (ApprovalPoliciesController.update) | `approval_policies.update` (write) | operation |
| ee/approval-policies | `DELETE /approval-policies/:id` (ApprovalPoliciesController.remove) | `approval_policies.remove` (destructive) | operation |
| ee/audit-export | `GET /audit-export` (AuditExportController.download) | `audit.export` (read) | operation |
| ee/audit-export | `GET /audit-export/streams` (AuditExportController.listStreams) | `audit.list_streams` (read) | operation |
| ee/audit-export | `POST /audit-export/streams` (AuditExportController.createStream) | `audit.create_stream` (write) | operation |
| ee/audit-export | `PATCH /audit-export/streams/:id` (AuditExportController.updateStream) | `audit.update_stream` (write) | operation |
| ee/audit-export | `DELETE /audit-export/streams/:id` (AuditExportController.deleteStream) | `audit.delete_stream` (destructive) | operation |
| ee/billing | `POST /billing/webhook` (BillingWebhookController.handleWebhook) |  | excluded |
| ee/billing | `GET /billing/:organizationId` (BillingController.getStatus) | `billing.get_status` (read) | operation |
| ee/billing | `GET /billing/:organizationId/invoices` (BillingController.listInvoices) | `billing.list_invoices` (read) | operation |
| ee/billing | `POST /billing/:organizationId/checkout` (BillingController.createCheckout) | `billing.create_checkout` (write) | operation |
| ee/billing | `POST /billing/:organizationId/portal` (BillingController.createPortal) | `billing.open_portal` (write) | operation |
| ee/chargeback | `GET /chargeback/report` (ChargebackController.getReport) | `chargeback.get_report` (read) | operation |
| ee/compliance | `GET /compliance/policy` (ComplianceController.getPolicy) | `compliance.get_policy` (read) | operation |
| ee/compliance | `PUT /compliance/policy` (ComplianceController.upsertPolicy) | `compliance.set_policy` (write) | operation |
| ee/compliance | `GET /compliance/report` (ComplianceController.getReport) | `compliance.get_report` (read) | operation |
| ee/connections-governance | `GET /ee/credentials/policies` (ConnectionsGovernanceController.listPolicies) | `connection_governance.list_policies` (read) | operation |
| ee/connections-governance | `POST /ee/credentials/policies` (ConnectionsGovernanceController.createPolicy) | `connection_governance.create_policy` (write) | operation |
| ee/connections-governance | `GET /ee/credentials/policies/:id` (ConnectionsGovernanceController.getPolicy) | `connection_governance.get_policy` (read) | operation |
| ee/connections-governance | `PATCH /ee/credentials/policies/:id` (ConnectionsGovernanceController.updatePolicy) | `connection_governance.update_policy` (write) | operation |
| ee/connections-governance | `DELETE /ee/credentials/policies/:id` (ConnectionsGovernanceController.removePolicy) | `connection_governance.remove_policy` (destructive) | operation |
| ee/connections-governance | `GET /ee/credentials/review` (ConnectionsGovernanceController.review) | `connection_governance.review` (read) | operation |
| ee/connections-governance | `POST /ee/credentials/review/:connectionId/revoke-grants` (ConnectionsGovernanceController.revokeGrants) | `connection_governance.revoke_grants` (destructive) | operation |
| ee/connections-governance | `GET /ee/credentials/expiring` (ConnectionsGovernanceController.expiring) | `connection_governance.list_expiring` (read) | operation |
| ee/connections-governance | `POST /ee/credentials/expiring/enforce` (ConnectionsGovernanceController.enforceExpiry) | `connection_governance.enforce_expiry` (destructive) | operation |
| ee/connections-governance | `GET /ee/credentials/rotate-due` (ConnectionsGovernanceController.rotationCandidates) | `connection_governance.list_rotation_due` (read) | operation |
| ee/connections-governance | `POST /ee/credentials/rotate-due` (ConnectionsGovernanceController.rotateDue) | `connection_governance.rotate_due` (write) | operation |
| ee/connections-governance | `POST /ee/credentials/principals/sync` (ConnectionsGovernanceController.syncPrincipals) | `connection_governance.sync_principals` (write) | operation |
| ee/connections-governance | `GET /ee/credentials/audit-export` (ConnectionsGovernanceController.auditExport) | `connection_governance.export_audit` (read) | operation |
| ee/rbac | `GET /rbac/permissions` (RbacController.listPermissions) | `rbac.list_permissions` (read) | operation |
| ee/rbac | `GET /rbac/roles` (RbacController.listRoles) | `rbac.list_roles` (read) | operation |
| ee/rbac | `POST /rbac/roles` (RbacController.createRole) | `rbac.create_role` (write) | operation |
| ee/rbac | `GET /rbac/roles/:id` (RbacController.getRole) | `rbac.get_role` (read) | operation |
| ee/rbac | `PATCH /rbac/roles/:id` (RbacController.updateRole) | `rbac.update_role` (write) | operation |
| ee/rbac | `DELETE /rbac/roles/:id` (RbacController.deleteRole) | `rbac.delete_role` (destructive) | operation |
| ee/rbac | `POST /rbac/roles/:id/assignments` (RbacController.assign) | `rbac.assign_role` (write) | operation |
| ee/rbac | `DELETE /rbac/roles/:id/assignments/:userId` (RbacController.unassign) | `rbac.unassign_role` (destructive) | operation |
| ee/rbac | `GET /rbac/users/:userId/permissions` (RbacController.effective) | `rbac.get_effective_permissions` (read) | operation |
| ee/rbac | `GET /rbac/policies` (RbacController.listPolicies) | `rbac.list_policies` (read) | operation |
| ee/rbac | `POST /rbac/policies` (RbacController.createPolicy) | `rbac.create_policy` (write) | operation |
| ee/rbac | `DELETE /rbac/policies/:id` (RbacController.deletePolicy) | `rbac.delete_policy` (destructive) | operation |
| ee/sso | `GET /gateways/:gatewayId/hosted-chat-sso` (HostedChatSsoSettingsController.get) | `channels.get_hosted_chat_sso` (read) | operation |
| ee/sso | `GET /public/chat/:slug/auth/sso/login` (HostedChatSsoController.login) |  | excluded |
| ee/sso | `GET /public/chat/:slug/auth/sso/callback` (HostedChatSsoController.callback) |  | excluded |
| ee/sso | `POST /public/chat/:slug/auth/sso/saml/acs` (HostedChatSsoController.samlAcs) |  | excluded |
| ee/sso | `GET /public/chat/:slug/auth/sso/saml/complete` (HostedChatSsoController.samlComplete) |  | excluded |
| ee/sso | `POST /scim/v2/Users` (ScimController.createUser) |  | excluded |
| ee/sso | `GET /scim/v2/Users` (ScimController.listUsers) |  | excluded |
| ee/sso | `GET /scim/v2/Users/:id` (ScimController.getUser) |  | excluded |
| ee/sso | `PUT /scim/v2/Users/:id` (ScimController.replaceUser) |  | excluded |
| ee/sso | `PATCH /scim/v2/Users/:id` (ScimController.patchUser) |  | excluded |
| ee/sso | `DELETE /scim/v2/Users/:id` (ScimController.deleteUser) |  | excluded |
| ee/sso | `POST /scim/v2/Groups` (ScimController.createGroup) |  | excluded |
| ee/sso | `GET /scim/v2/Groups` (ScimController.listGroups) |  | excluded |
| ee/sso | `GET /scim/v2/Groups/:id` (ScimController.getGroup) |  | excluded |
| ee/sso | `PATCH /scim/v2/Groups/:id` (ScimController.patchGroup) |  | excluded |
| ee/sso | `DELETE /scim/v2/Groups/:id` (ScimController.deleteGroup) |  | excluded |
| ee/sso | `GET /sso/settings` (SsoConfigController.get) | `sso.get_settings` (read) | operation |
| ee/sso | `PUT /sso/settings` (SsoConfigController.upsert) | `sso.update_settings` (write) | operation |
| ee/sso | `POST /sso/settings/scim-token` (SsoConfigController.rotateScimToken) |  | excluded |
| ee/sso | `GET /sso/settings/scim-token` (SsoConfigController.revealScimToken) |  | excluded |
| ee/sso | `GET /sso/settings/domains` (SsoConfigController.listDomains) | `sso.list_domains` (read) | operation |
| ee/sso | `POST /sso/settings/domains` (SsoConfigController.addDomain) | `sso.add_domain` (write) | operation |
| ee/sso | `POST /sso/settings/domains/:id/verify` (SsoConfigController.verifyDomain) | `sso.verify_domain` (write) | operation |
| ee/sso | `DELETE /sso/settings/domains/:id` (SsoConfigController.removeDomain) | `sso.remove_domain` (destructive) | operation |
| ee/sso | `GET /sso/discover` (SsoController.discover) |  | excluded |
| ee/sso | `GET /sso/:orgId/saml/login` (SsoController.samlLogin) |  | excluded |
| ee/sso | `POST /sso/:orgId/saml/callback` (SsoController.samlCallback) |  | excluded |
| ee/sso | `GET /sso/:orgId/saml/complete` (SsoController.samlComplete) |  | excluded |
| ee/sso | `GET /sso/:orgId/saml/metadata` (SsoController.samlMetadata) |  | excluded |
| ee/sso | `GET /sso/:orgId/oidc/login` (SsoController.oidcLogin) |  | excluded |
| ee/sso | `GET /sso/:orgId/oidc/callback` (SsoController.oidcCallback) |  | excluded |
| a2a | `POST /external-agents/preview` (ExternalAgentsController.preview) | `external_agents.preview` (read) | operation |
| a2a | `POST /external-agents` (ExternalAgentsController.create) | `external_agents.add` (write) | operation |
| a2a | `GET /external-agents` (ExternalAgentsController.findAll) | `external_agents.list` (read) | operation |
| a2a | `GET /external-agents/:id` (ExternalAgentsController.findOne) | `external_agents.get` (read) | operation |
| a2a | `PATCH /external-agents/:id` (ExternalAgentsController.update) | `external_agents.update` (write) | operation |
| a2a | `DELETE /external-agents/:id` (ExternalAgentsController.remove) | `external_agents.remove` (destructive) | operation |
| a2a | `POST /external-agents/:id/refresh` (ExternalAgentsController.refresh) | `external_agents.refresh` (write) | operation |
| agent-channels | `GET /agents/:agentId/public-settings` (AgentChannelsController.publicSettings) | `get_public_settings` | tool |
| agent-channels | `PATCH /agents/:agentId/public-settings` (AgentChannelsController.updatePublicSettings) | `update_public_settings` | tool |
| agent-channels | `GET /agents/:agentId/public-settings/spend` (AgentChannelsController.spend) | `channels.get_spend` (read) | operation |
| agent-channels | `POST /agents/:agentId/visitor-data/lookup` (AgentChannelsController.lookupVisitorData) | `channels.lookup_visitor_data` (read) | operation |
| agent-channels | `POST /agents/:agentId/visitor-data/export` (AgentChannelsController.exportVisitorData) | `channels.export_visitor_data` (read) | operation |
| agent-channels | `POST /agents/:agentId/visitor-data/erase` (AgentChannelsController.eraseVisitorData) | `channels.erase_visitor_data` (destructive) | operation |
| agent-channels | `GET /agents/:agentId/channels` (AgentChannelsController.list) | `list_channels` | tool |
| agent-channels | `POST /agents/:agentId/channels` (AgentChannelsController.add) | `add_channel` | tool |
| agent-channels | `GET /agents/:agentId/channels/:channelId` (AgentChannelsController.get) | `get_channel` | tool |
| agent-channels | `PATCH /agents/:agentId/channels/:channelId` (AgentChannelsController.update) | `update_channel` | tool |
| agent-channels | `DELETE /agents/:agentId/channels/:channelId` (AgentChannelsController.remove) | `delete_channel` | tool |
| agent-channels | `GET /agents/:agentId/channels/:channelId/check` (AgentChannelsController.check) | `check_channel` | tool |
| agent-channels | `POST /agents/:agentId/channels/:channelId/publish` (AgentChannelsController.publish) | `publish_channel` | tool |
| agent-channels | `POST /agents/:agentId/channels/:channelId/unpublish` (AgentChannelsController.unpublish) | `unpublish_channel` | tool |
| agent-channels | `POST /agents/:agentId/channels/:channelId/build-record` (AgentChannelsController.recordBuild) | `channels.record_build` (write) | operation |
| agent-channels | `GET /agents/:agentId/channels/:channelId/platforms` (AgentChannelsController.platforms) | `channels.list_platforms` (read) | operation |
| agent-channels | `GET /agents/:agentId/channels/:channelId/capabilities` (AgentChannelsController.capabilities) | `channels.get_capabilities` (read) | operation |
| agent-channels | `POST /agents/:agentId/channels/:channelId/builds` (AgentChannelsController.requestBuild) | `build_channel` | tool |
| agent-channels | `GET /agents/:agentId/channels/:channelId/builds` (AgentChannelsController.listBuilds) | `list_builds` | tool |
| agent-channels | `GET /agents/:agentId/channels/:channelId/builds/:buildId/download` (AgentChannelsController.download) | `channels.get_build_download_link` (read) | operation |
| agent-channels | `GET /agents/:agentId/channels/:channelId/builds/:buildId/artifact` (AgentChannelsController.artifact) |  | excluded |
| agent-constraints | `GET /agents/:agentId/constraints` (AgentConstraintsController.list) | `agents.list_constraints` (read) | operation |
| agent-constraints | `POST /agents/:agentId/constraints` (AgentConstraintsController.add) | `agents.add_constraint` (write) | operation |
| agent-constraints | `PATCH /agents/:agentId/constraints/:id` (AgentConstraintsController.setActive) | `agents.set_constraint_active` (write) | operation |
| agent-constraints | `DELETE /agents/:agentId/constraints/:id` (AgentConstraintsController.remove) | `agents.remove_constraint` (destructive) | operation |
| agents | `POST /v1/messages` (AgentAnthropicCompatController.messages) |  | excluded |
| agents | `GET /agents/:id/api-access` (AgentApiAccessController.get) | `agents.get_api_access` (read) | operation |
| agents | `POST /agents/:id/api-access` (AgentApiAccessController.set) | `agents.set_api_access` (write) | operation |
| agents | `GET /agents/:agentId/execution` (AgentExecutionSettingsController.get) | `agents.get_execution_settings` (read) | operation |
| agents | `PUT /agents/:agentId/execution` (AgentExecutionSettingsController.put) | `agents.update_execution_settings` (write) | operation |
| agents | `POST /agents/:agentId/execution/eject` (AgentExecutionSettingsController.eject) | `agents.eject_execution_settings` (write) | operation |
| agents | `POST /agents/:id/invoke` (AgentExecutionController.invokeAgent) | `invoke_agent` | tool |
| agents | `POST /agents/:id/stream` (AgentExecutionController.streamAgent) |  | excluded |
| agents | `GET /agents/:id/executions` (AgentManagementController.getAgentExecutions) | `agents.list_executions` (read) | operation |
| agents | `GET /agents/:id/audit-log` (AgentManagementController.getAuditLog) | `agents.get_audit_log` (read) | operation |
| agents | `POST /agents/:id/versions` (AgentManagementController.saveVersion) | `agents.save_version` (write) | operation |
| agents | `GET /agents/:id/versions` (AgentManagementController.getVersionHistory) | `agents.list_versions` (read) | operation |
| agents | `POST /agents/:id/versions/:index/rollback` (AgentManagementController.rollbackToVersion) | `agents.rollback_to_version` (write) | operation |
| agents | `GET /agents/:id/export` (AgentManagementController.exportAgent) | `agents.export` (read) | operation |
| agents | `GET /agents/:id/technical-documentation` (AgentManagementController.getTechnicalDocumentation) | `agents.get_technical_documentation` (read) | operation |
| agents | `GET /agents/:id/cost-estimate` (AgentManagementController.getCostEstimate) | `agents.get_cost_estimate` (read) | operation |
| agents | `POST /v1/chat/completions` (AgentOpenAICompatController.chatCompletions) |  | excluded |
| agents | `GET /v1/models` (AgentOpenAICompatController.listModels) |  | excluded |
| agents | `GET /v1/models/:model` (AgentOpenAICompatController.retrieveModel) |  | excluded |
| agents | `GET /agents/:agentId/roles` (AgentRolesController.list) | `agents.list_roles` (read) | operation |
| agents | `POST /agents/:agentId/roles` (AgentRolesController.upsert) | `agents.upsert_role` (write) | operation |
| agents | `DELETE /agents/:agentId/roles/:key` (AgentRolesController.remove) | `agents.remove_role` (destructive) | operation |
| agents | `POST /agents/:agentId/roles/resolve` (AgentRolesController.resolve) | `agents.resolve_roles` (read) | operation |
| agents | `GET /agents/:id/executions/:executionId/trace` (AgentRunsController.trace) | `runs.get_execution_trace` (read) | operation |
| agents | `POST /agents/:id/runs` (AgentRunsController.startRun) | `invoke_agent` | tool |
| agents | `GET /agents/:id/runs` (AgentRunsController.listRuns) | `runs.list` (read) | operation |
| agents | `GET /agents/:id/runs/:runId` (AgentRunsController.getRun) | `get_run` | tool |
| agents | `GET /agents/:id/runs/:runId/code-executions` (AgentRunsController.listCodeExecutions) | `runs.list_code_executions` (read) | operation |
| agents | `GET /agents/:id/runs/:runId/code-executions/:codeExecutionId` (AgentRunsController.getCodeExecution) | `runs.get_code_execution` (read) | operation |
| agents | `GET /agents/:id/runs/:runId/stream` (AgentRunsController.streamRun) |  | excluded |
| agents | `POST /agents/:id/runs/:runId/input` (AgentRunsController.sendRunInput) | `answer_run` | tool |
| agents | `POST /agents/:id/runs/:runId/cancel` (AgentRunsController.cancelRun) | `runs.cancel` (write) | operation |
| agents | `GET /agents/:id/schedule` (AgentScheduleController.getSchedule) | `schedules.get` (read) | operation |
| agents | `POST /agents/:id/schedule/preview` (AgentScheduleController.previewSchedule) | `schedules.preview` (read) | operation |
| agents | `GET /agents/:id/schedule/destinations` (AgentScheduleController.destinations) | `schedules.list_destinations` (read) | operation |
| agents | `PATCH /agents/:id/schedule` (AgentScheduleController.updateSchedule) | `schedules.update` (write) | operation |
| agents | `POST /agents/:id/schedule` (AgentScheduleController.scheduleAgent) | `schedules.set` (write) | operation |
| agents | `DELETE /agents/:id/schedule` (AgentScheduleController.unscheduleAgent) | `schedules.remove` (destructive) | operation |
| agents | `POST /agents` (AgentsController.createAgent) | `create_agent` | tool |
| agents | `GET /agents` (AgentsController.getAgents) | `list_agents` | tool |
| agents | `GET /agents/templates` (AgentsController.getTemplates) | `agents.list_templates` (read) | operation |
| agents | `POST /agents/import` (AgentsController.importAgent) | `agents.import` (write) | operation |
| agents | `GET /agents/:id` (AgentsController.getAgent) | `agents.get` (read) | operation |
| agents | `PATCH /agents/:id` (AgentsController.updateAgent) | `update_agent` | tool |
| agents | `DELETE /agents/:id` (AgentsController.deleteAgent) | `delete_agent` | tool |
| agents | `GET /agents/:id/readiness` (AgentsController.getReadiness) | `agents.get_readiness` (read) | operation |
| agents | `POST /agents/:id/activate` (AgentsController.activateAgent) | `activate_agent` | tool |
| agents | `POST /agents/:id/deactivate` (AgentsController.deactivateAgent) | `deactivate_agent` | tool |
| agents | `POST /agents/:id/duplicate` (AgentsController.duplicateAgent) | `agents.duplicate` (write) | operation |
| agents | `GET /agents/:id/always-on` (AlwaysOnController.get) | `always_on.get` (read) | operation |
| agents | `PATCH /agents/:id/always-on` (AlwaysOnController.update) | `always_on.update` (write) | operation |
| agents | `POST /agents/:id/always-on/wake` (AlwaysOnController.wakeNow) | `always_on.wake_now` (write) | operation |
| agents | `GET /agents/:id/always-on/wakes` (AlwaysOnController.wakes) | `always_on.list_wakes` (read) | operation |
| agents | `GET /agents/:id/push-wakes` (PushWakesController.list) | `push_wakes.list` (read) | operation |
| agents | `GET /agents/:id/push-wakes/options` (PushWakesController.options) | `push_wakes.list_options` (read) | operation |
| agents | `GET /agents/:id/push-wakes/operations` (PushWakesController.operations) | `push_wakes.list_operations` (read) | operation |
| agents | `POST /agents/:id/push-wakes` (PushWakesController.create) | `push_wakes.create` (write) | operation |
| agents | `PATCH /agents/:id/push-wakes/:pushWakeId` (PushWakesController.update) | `push_wakes.update` (write) | operation |
| agents | `POST /agents/:id/push-wakes/:pushWakeId/subscribe` (PushWakesController.resubscribe) | `push_wakes.resubscribe` (write) | operation |
| agents | `DELETE /agents/:id/push-wakes/:pushWakeId` (PushWakesController.remove) | `push_wakes.remove` (destructive) | operation |
| agents | `POST /push-wakes/:subscriptionId` (PushWakeReceiverController.receive) |  | excluded |
| agents | `POST /v1/responses` (ModelPassThroughController.responses) |  | excluded |
| agents | `POST /v1/messages/count_tokens` (ModelPassThroughController.countTokens) |  | excluded |
| agents | `POST /promoted-skills/:id/replay` (PromotedSkillReplayController.replay) | `promoted_skills.replay` (write) | operation |
| agents | `GET /strategies` (StrategiesController.list) | `agents.list_strategies` (read) | operation |
| apis | `GET /apis/:id/key` (ApisCredentialsController.getKey) | `apis.get_key` (read) | operation |
| apis | `PUT /apis/:id/key` (ApisCredentialsController.setKey) |  | excluded |
| apis | `DELETE /apis/:id/key` (ApisCredentialsController.removeKey) | `apis.remove_key` (destructive) | operation |
| apis | `POST /apis/:id/credentials` (ApisCredentialsController.createCredential) |  | excluded |
| apis | `GET /apis/:id/credentials` (ApisCredentialsController.getCredentials) | `apis.list_credentials` (read) | operation |
| apis | `PUT /apis/:id/credentials/:credentialId` (ApisCredentialsController.updateCredential) |  | excluded |
| apis | `DELETE /apis/:id/credentials/:credentialId` (ApisCredentialsController.deleteCredential) | `apis.remove_credential` (destructive) | operation |
| apis | `POST /apis/:id/credentials/:credentialId/test` (ApisCredentialsController.testCredential) | `apis.test_credential` (read) | operation |
| apis | `GET /apis` (ApisController.findAll) | `list_apis` | tool |
| apis | `POST /apis/import` (ApisController.connect) | `apis.connect` (write) | operation |
| apis | `POST /apis/http` (ApisController.createHttpApi) | `apis.create_http` (write) | operation |
| apis | `POST /apis/sdk` (ApisController.createSdkApi) | `apis.create_sdk` (write) | operation |
| apis | `POST /apis/:id/analyse-sdk` (ApisController.analyseSdk) | `apis.analyse_sdk` (write) | operation |
| apis | `GET /apis/:id/sdk-maps` (ApisController.getSdkMaps) | `apis.get_sdk_maps` (read) | operation |
| apis | `GET /apis/:id` (ApisController.findOne) | `apis.get` (read) | operation |
| apis | `POST /apis` (ApisController.create) | `create_api` | tool |
| apis | `PUT /apis/:id` (ApisController.update) | `update_api` | tool |
| apis | `DELETE /apis/:id` (ApisController.remove) | `delete_api` | tool |
| apis | `POST /apis/:id/import-schema` (ApisController.importSchema) | `import_schema` | tool |
| apis | `GET /apis/:id/import-status/:jobId` (ApisController.getImportStatus) | `check_import_status` | tool |
| apis | `GET /apis/:id/import-status/:jobId/stream` (ApisController.streamImportStatus) |  | excluded |
| apis | `POST /apis/:id/generate-tools` (ApisController.generateTools) | `apis.generate_tools` (write) | operation |
| apis | `GET /apis/:id/operations` (ApisController.getOperations) | `apis.list_operations` (read) | operation |
| apis | `GET /apis/:id/operations/outline` (ApisController.getOperationOutline) | `apis.get_operation_outline` (read) | operation |
| apis | `POST /apis/:id/operations/selection` (ApisController.selectOperations) | `apis.select_operations` (write) | operation |
| apis | `GET /apis/:id/resources` (ApisController.getResources) | `apis.list_resources` (read) | operation |
| apis | `POST /apis/:id/test-connection` (ApisController.testConnection) | `apis.test_connection` (write) | operation |
| apis | `GET /apis/:id/schemas` (ApisController.getSchemas) | `apis.list_schemas` (read) | operation |
| apis | `GET /apis/:id/schemas/:schemaId/parsed` (ApisController.getParsedSchema) | `apis.get_parsed_schema` (read) | operation |
| apis | `PUT /apis/:id/status` (ApisController.updateStatus) | `apis.set_status` (write) | operation |
| approvals | `GET /approval-rules` (AmountRulesController.list) | `approval_rules.list` (read) | operation |
| approvals | `GET /approval-rules/:id` (AmountRulesController.get) | `approval_rules.get` (read) | operation |
| approvals | `POST /approval-rules` (AmountRulesController.create) | `approval_rules.create` (write) | operation |
| approvals | `PATCH /approval-rules/:id` (AmountRulesController.update) | `approval_rules.update` (write) | operation |
| approvals | `DELETE /approval-rules/:id` (AmountRulesController.remove) | `approval_rules.remove` (destructive) | operation |
| approvals | `GET /approvals` (ApprovalsController.list) | `list_approvals` | tool |
| approvals | `GET /approvals/:id` (ApprovalsController.get) | `approvals.get` (read) | operation |
| approvals | `POST /approvals/:id/approve` (ApprovalsController.approve) | `decide_approval` | tool |
| approvals | `POST /approvals/:id/reject` (ApprovalsController.reject) | `decide_approval` | tool |
| audit-log | `GET /audit-logs` (AuditLogController.findAll) | `audit.list` (read) | operation |
| audit-log | `GET /audit-logs/resource` (AuditLogController.getResourceHistory) | `audit.get_resource_history` (read) | operation |
| auth | `GET /auth/check-organization-name` (AuthController.checkOrganizationName) |  | excluded |
| auth | `POST /auth/register` (AuthController.register) |  | excluded |
| auth | `POST /auth/login` (AuthController.login) |  | excluded |
| auth | `POST /auth/token` (AuthController.token) |  | excluded |
| auth | `POST /auth/refresh` (AuthController.refresh) |  | excluded |
| auth | `POST /auth/logout` (AuthController.logout) |  | excluded |
| auth | `GET /auth/profile` (AuthController.getProfile) | `profile.get` (read) | operation |
| auth | `PATCH /auth/profile` (AuthController.updateProfile) | `profile.update` (write) | operation |
| auth | `POST /auth/api-keys` (AuthController.createApiKey) | `profile.create_api_key` (write) | operation |
| auth | `GET /auth/api-keys` (AuthController.getApiKeys) | `profile.list_api_keys` (read) | operation |
| auth | `DELETE /auth/api-keys/:keyId` (AuthController.revokeApiKey) | `profile.revoke_api_key` (destructive) | operation |
| auth | `POST /auth/forgot-password` (AuthController.forgotPassword) |  | excluded |
| auth | `POST /auth/reset-password` (AuthController.resetPassword) |  | excluded |
| auth | `PATCH /auth/change-password` (AuthController.changePassword) |  | excluded |
| auth | `POST /auth/verify-email` (AuthController.verifyEmail) |  | excluded |
| auth | `GET /auth/verify-email` (AuthController.verifyEmailLink) |  | excluded |
| auth | `POST /auth/resend-verification` (AuthController.resendVerification) |  | excluded |
| auth | `POST /auth/resend-verification-email` (AuthController.resendVerificationByEmail) |  | excluded |
| budgets | `GET /budgets/spend` (BudgetsController.getSpend) | `get_spend` | tool |
| budgets | `GET /budgets/alerts` (BudgetsController.listAlerts) | `budgets.list_alerts` (read) | operation |
| budgets | `GET /budgets` (BudgetsController.list) | `list_budgets` | tool |
| budgets | `GET /budgets/:id` (BudgetsController.get) | `budgets.get` (read) | operation |
| budgets | `POST /budgets` (BudgetsController.create) | `budgets.create` (write) | operation |
| budgets | `PATCH /budgets/:id` (BudgetsController.update) | `budgets.update` (write) | operation |
| budgets | `DELETE /budgets/:id` (BudgetsController.remove) | `budgets.remove` (destructive) | operation |
| connections | `GET /credentials/oauth/client-metadata.json` (CredentialSignInController.clientMetadata) |  | excluded |
| connections | `GET /credentials/oauth/callback` (CredentialSignInController.callback) |  | excluded |
| connections | `GET /credentials/:id/grants` (GrantsController.list) | `list_connection_grants` | tool |
| connections | `POST /credentials/:id/grants` (GrantsController.create) | `grant_connection` | tool |
| connections | `DELETE /credentials/:id/grants/:grantId` (GrantsController.revoke) | `credentials.revoke_grant` (destructive) | operation |
| credentials | `GET /credentials/services` (CredentialsController.listServices) | `list_connectors` | tool |
| credentials | `POST /credentials/services` (CredentialsController.createService) | `credentials.add_connector` (write) | operation |
| credentials | `POST /credentials/connect/:connectorKey` (CredentialsController.connect) | `start_connection` | tool |
| credentials | `POST /credentials/connect/:connectorKey/complete` (CredentialsController.completeConnect) | `complete_connection` | tool |
| credentials | `GET /credentials` (CredentialsController.findAll) | `list_connections`, `list_credentials` | tool |
| credentials | `POST /credentials` (CredentialsController.create) |  | excluded |
| credentials | `GET /credentials/:id` (CredentialsController.findById) | `credentials.get` (read) | operation |
| credentials | `PATCH /credentials/:id` (CredentialsController.update) |  | excluded |
| credentials | `DELETE /credentials/:id` (CredentialsController.delete) | `credentials.delete` (destructive) | operation |
| credentials | `POST /credentials/:id/validate` (CredentialsController.validate) | `credentials.check` (write) | operation |
| credentials | `POST /credentials/:id/rotate` (CredentialsController.rotate) |  | excluded |
| credentials | `PATCH /credentials/:id/sharing` (CredentialsController.setSharing) | `credentials.set_sharing` (write) | operation |
| credentials | `GET /credentials/:id/usage` (CredentialsController.getUsage) | `credentials.get_usage` (read) | operation |
| credentials | `GET /access-keys` (CredentialsController.findAllAccessKeys) | `credentials.list_access_keys` (read) | operation |
| credentials | `POST /access-keys` (CredentialsController.createAccessKey) | `credentials.create_access_key` (write) | operation |
| credentials | `DELETE /access-keys/:id` (CredentialsController.revokeAccessKey) | `credentials.revoke_access_key` (destructive) | operation |
| credentials | `GET /credentials/oauth2/presets` (OAuth2Controller.getPresets) | `credentials.list_oauth_presets` (read) | operation |
| credentials | `GET /credentials/oauth2/callback-url` (OAuth2Controller.getCallbackUrl) | `credentials.get_oauth_callback_url` (read) | operation |
| credentials | `POST /credentials/oauth2/authorize` (OAuth2Controller.authorize) |  | excluded |
| credentials | `GET /credentials/oauth2/callback` (OAuth2Controller.callback) |  | excluded |
| credentials | `POST /credentials/oauth2/client-credentials` (OAuth2Controller.clientCredentials) |  | excluded |
| files | `POST /files/upload` (FilesController.upload) |  | excluded |
| files | `GET /files` (FilesController.findAll) | `files.list` (read) | operation |
| files | `GET /files/:id` (FilesController.findById) | `files.get` (read) | operation |
| files | `GET /files/:id/download` (FilesController.download) |  | excluded |
| files | `DELETE /files/:id` (FilesController.remove) | `files.remove` (destructive) | operation |
| gateways | `GET /gateways/:gatewayId/channel` (ChannelLinkController.managedBy) | `channels.get_managing_channel` (read) | operation |
| gateways | `POST /channels/email/inbound` (ChannelEmailInboundController.inbound) |  | excluded |
| gateways | `GET /gateways/:id/events` (ChannelEventsController.listEvents) | `channels.list_events` (read) | operation |
| gateways | `POST /gateways/:id/test-connection` (ChannelEventsController.testConnection) | `channels.test_connection` (write) | operation |
| gateways | `GET /gateways/:id/install/slack` (ChannelInstallController.installSlack) |  | excluded |
| gateways | `GET /gateways/:id/install/slack/callback` (ChannelInstallController.installSlackCallback) |  | excluded |
| gateways | `GET /gateways/:id/installations` (ChannelInstallationsController.listInstallations) | `channels.list_installations` (read) | operation |
| gateways | `POST /gateways/:id/installations/:installationId/revoke` (ChannelInstallationsController.revokeInstallation) | `channels.revoke_installation` (destructive) | operation |
| gateways | `GET /gateways/:id/widget.js` (ChannelWidgetController.widgetScript) |  | excluded |
| gateways | `GET /gateways/:id/widget-preview` (ChannelWidgetController.widgetPreview) |  | excluded |
| gateways | `GET /gateways/:id/widget-preview.js` (ChannelWidgetController.widgetPreviewScript) |  | excluded |
| gateways | `GET /gateways/:id/widget-config` (ChannelWidgetController.widgetConfig) |  | excluded |
| gateways | `POST /gateways/:id/widget/attachments` (ChannelWidgetController.uploadAttachment) |  | excluded |
| gateways | `POST /gateways/:id/widget/messages` (ChannelWidgetController.postMessage) |  | excluded |
| gateways | `GET /gateways/:id/widget/messages` (ChannelWidgetController.listMessages) |  | excluded |
| gateways | `GET /gateways/:id/widget/stream` (ChannelWidgetController.streamReply) |  | excluded |
| gateways | `GET /gateways/:id/widget/threads/:threadId/export` (ChannelWidgetController.exportThread) |  | excluded |
| gateways | `DELETE /gateways/:id/widget/threads/:threadId` (ChannelWidgetController.deleteThread) |  | excluded |
| gateways | `GET /gateways/:gatewayId/custom-domain` (CustomDomainController.get) | `channels.get_custom_domain` (read) | operation |
| gateways | `PUT /gateways/:gatewayId/custom-domain` (CustomDomainController.set) | `channels.set_custom_domain` (write) | operation |
| gateways | `POST /gateways/:gatewayId/custom-domain/verify` (CustomDomainController.verify) | `channels.verify_custom_domain` (write) | operation |
| gateways | `DELETE /gateways/:gatewayId/custom-domain` (CustomDomainController.remove) | `channels.remove_custom_domain` (destructive) | operation |
| gateways | `POST /public/chat/:slug/auth/email/start` (HostedChatEmailAuthController.start) |  | excluded |
| gateways | `POST /public/chat/:slug/auth/email/verify` (HostedChatEmailAuthController.verify) |  | excluded |
| gateways | `GET /public/chat/:slug/auth/oauth/login` (HostedChatOAuthController.login) |  | excluded |
| gateways | `GET /public/chat/:slug/auth/oauth/callback` (HostedChatOAuthController.callback) |  | excluded |
| gateways | `GET /public/chat/by-host` (HostedChatController.byHost) |  | excluded |
| gateways | `GET /public/chat/:slug` (HostedChatController.branding) |  | excluded |
| gateways | `GET /public/chat/:slug/me` (HostedChatController.me) |  | excluded |
| gateways | `DELETE /public/chat/:slug/conversations/:conversationId` (HostedChatController.deleteConversation) |  | excluded |
| gateways | `DELETE /public/chat/:slug/me` (HostedChatController.deleteMe) |  | excluded |
| gateways | `GET /public/chat/:slug/export` (HostedChatController.exportMe) |  | excluded |
| gateways | `GET /public/chat/:slug/conversations` (HostedChatController.listConversations) |  | excluded |
| gateways | `POST /public/chat/:slug/attachments` (HostedChatController.uploadAttachment) |  | excluded |
| gateways | `POST /public/chat/:slug/messages` (HostedChatController.postMessage) |  | excluded |
| gateways | `GET /public/chat/:slug/stream` (HostedChatController.stream) |  | excluded |
| gateways | `GET /public/chat/:slug/conversations/:conversationId/messages` (HostedChatController.messages) |  | excluded |
| gateways | `GET /gateways/:gatewayId/visitor-oauth` (VisitorOAuthConfigController.get) | `channels.get_visitor_sign_in` (read) | operation |
| gateways | `PUT /gateways/:gatewayId/visitor-oauth` (VisitorOAuthConfigController.set) |  | excluded |
| gateways | `DELETE /gateways/:gatewayId/visitor-oauth` (VisitorOAuthConfigController.remove) | `channels.remove_visitor_sign_in` (destructive) | operation |
| gateways | `POST /gateways/:gatewayId/auth` (GatewayAuthController.createGatewayAuth) | `add_auth_to_gateway` | tool |
| gateways | `GET /gateways/:gatewayId/auth/company-signin-metadata` (GatewayAuthController.companyMetadata) | `gateways.get_company_sign_in_metadata` (read) | operation |
| gateways | `GET /gateways/:gatewayId/auth` (GatewayAuthController.getGatewayAuths) | `gateways.list_auth` (read) | operation |
| gateways | `PATCH /gateways/:gatewayId/auth/:authId` (GatewayAuthController.updateGatewayAuth) | `gateways.update_auth` (write) | operation |
| gateways | `DELETE /gateways/:gatewayId/auth/:authId` (GatewayAuthController.deleteGatewayAuth) | `remove_auth_from_gateway` | tool |
| gateways | `POST /gateways/:gatewayId/auth/api-keys` (GatewayAuthController.generateGatewayApiKey) | `gateways.create_api_key` (write) | operation |
| gateways | `GET /gateways/:gatewayId/auth/api-keys` (GatewayAuthController.listGatewayApiKeys) | `gateways.list_api_keys` (read) | operation |
| gateways | `DELETE /gateways/:gatewayId/auth/api-keys/:keyId` (GatewayAuthController.revokeGatewayApiKey) | `gateways.revoke_api_key` (destructive) | operation |
| gateways | `GET /gateways/skills/search` (GatewayInfoController.searchSkills) | `gateways.search_skills` (read) | operation |
| gateways | `GET /gateways/all-skills` (GatewayInfoController.getAllSkills) | `gateways.list_all_skills` (read) | operation |
| gateways | `GET /gateways/:gatewayId/stats` (GatewayInfoController.getGatewayStats) | `gateways.get_stats` (read) | operation |
| gateways | `POST /gateways/:gatewayId/health-check` (GatewayInfoController.performHealthCheck) | `gateways.health_check` (write) | operation |
| gateways | `GET /gateways/stats/overview` (GatewayInfoController.getOrganizationStats) | `gateways.get_overview_stats` (read) | operation |
| gateways | `GET /gateways/resolve/:orgSlug/:gatewaySlug` (GatewayInfoController.resolveGateway) | `gateways.resolve` (read) | operation |
| gateways | `GET /gateways/:gatewayId/skills` (GatewaySkillsController.getGatewaySkills) | `gateways.get_skills` (read) | operation |
| gateways | `GET /gateways/:gatewayId/skills/individual` (GatewaySkillsController.getGatewayIndividualSkills) | `gateways.list_skills` (read) | operation |
| gateways | `POST /gateways/:gatewayId/skills/:toolId/execute` (GatewaySkillsController.executeSkill) | `gateways.execute_skill` (write) | operation |
| gateways | `POST /gateways/:gatewayId/skills/run-code` (GatewaySkillsController.runCode) | `gateways.run_code` (write) | operation |
| gateways | `GET /gateways/:gatewayId/cli-bundle` (GatewaySkillsController.getGatewayCliBundle) | `gateways.get_cli_bundle` (read) | operation |
| gateways | `GET /gateways/:gatewayId/sdk` (GatewaySkillsController.getGatewaySdk) | `gateways.get_sdk` (read) | operation |
| gateways | `POST /gateways/:gatewayId/tools` (GatewayToolsController.associateTool) | `gateways.add_tool` (write) | operation |
| gateways | `POST /gateways/:gatewayId/tools/bulk` (GatewayToolsController.bulkAssociateTools) | `assign_tools_to_gateway` | tool |
| gateways | `DELETE /gateways/:gatewayId/tools/:toolId` (GatewayToolsController.removeToolFromGateway) | `gateways.remove_tool` (destructive) | operation |
| gateways | `PATCH /gateways/:gatewayId/tools/:gatewayToolId` (GatewayToolsController.updateGatewayTool) | `gateways.update_tool` (write) | operation |
| gateways | `DELETE /gateways/:gatewayId/tools` (GatewayToolsController.removeAllToolsFromGateway) | `gateways.remove_all_tools` (destructive) | operation |
| gateways | `GET /gateways/:gatewayId/tools` (GatewayToolsController.getGatewayTools) | `gateways.list_tools` (read) | operation |
| gateways | `GET /gateways/:gatewayId/tools/available` (GatewayToolsController.getAvailableTools) | `gateways.list_available_tools` (read) | operation |
| gateways | `GET /gateways/:gatewayId/tools/stats` (GatewayToolsController.getGatewayToolStats) | `gateways.get_tool_stats` (read) | operation |
| gateways | `POST /gateways` (GatewaysController.createGateway) | `create_gateway` | tool |
| gateways | `GET /gateways` (GatewaysController.getGateways) | `list_gateways` | tool |
| gateways | `GET /gateways/:gatewayId` (GatewaysController.getGateway) | `gateways.get` (read) | operation |
| gateways | `PATCH /gateways/:gatewayId` (GatewaysController.updateGateway) | `gateways.update` (write) | operation |
| gateways | `DELETE /gateways/:gatewayId` (GatewaysController.deleteGateway) | `delete_gateway` | tool |
| gateways | `POST /gateways/:gatewayId/activate` (GatewaysController.activateGateway) | `gateways.activate` (write) | operation |
| gateways | `POST /gateways/:gatewayId/deactivate` (GatewaysController.deactivateGateway) | `gateways.deactivate` (write) | operation |
| gateways | `ALL /.well-known/agent-card.json` (UnifiedEndpointController.handleRootAgentCard) |  | excluded |
| gateways | `ALL /` (UnifiedEndpointController.handleRootJsonRpc) |  | excluded |
| gateways | `ALL /:orgSlug/:resourceSlug` (UnifiedEndpointController.handleRequest) |  | excluded |
| gateways | `ALL /:orgSlug/:resourceSlug/*` (UnifiedEndpointController.handleSubPathRequest) |  | excluded |
| health | `GET /health` (HealthController.check) |  | excluded |
| health | `GET /health/live` (HealthController.liveness) |  | excluded |
| health | `GET /health/ready` (HealthController.readiness) |  | excluded |
| hosted-runners | `GET /environments` (EnvironmentsController.list) | `environments.list` (read) | operation |
| hosted-runners | `GET /environments/settings` (EnvironmentsController.settings) | `environments.get_settings` (read) | operation |
| hosted-runners | `GET /environments/usage` (EnvironmentsController.usage) | `environments.get_usage` (read) | operation |
| hosted-runners | `POST /environments` (EnvironmentsController.create) | `environments.create` (write) | operation |
| hosted-runners | `GET /environments/:id` (EnvironmentsController.get) | `environments.get` (read) | operation |
| hosted-runners | `PATCH /environments/:id` (EnvironmentsController.update) | `environments.update` (write) | operation |
| hosted-runners | `DELETE /environments/:id` (EnvironmentsController.remove) | `environments.remove` (destructive) | operation |
| hosted-runners | `GET /environments/:id/runs` (EnvironmentsController.runs) | `environments.list_runs` (read) | operation |
| hosted-runners | `GET /environments/:id/workspaces` (EnvironmentsController.workspaces) | `environments.list_workspaces` (read) | operation |
| hosted-runners | `POST /environments/:id/workspaces/:workspaceId/suspend` (EnvironmentsController.suspend) | `environments.suspend_workspace` (write) | operation |
| hosted-runners | `POST /environments/:id/workspaces/:workspaceId/release` (EnvironmentsController.release) | `environments.release_workspace` (destructive) | operation |
| hosted-runners | `POST /runners/enroll` (HostedRunnerEnrollmentController.enroll) |  | excluded |
| hosted-runners | `POST /runners/hosted/credential` (HostedRunnerEnrollmentController.renew) |  | excluded |
| hosted-runners | `POST /runners/hosted/model-token` (HostedRunnerEnrollmentController.renewModelToken) |  | excluded |
| kms | `GET /kms` (KmsController.get) | `kms.get` (read) | operation |
| kms | `PUT /kms` (KmsController.setCmk) | `kms.set_key` (write) | operation |
| kms | `POST /kms/rotate` (KmsController.rotate) | `kms.rotate_key` (write) | operation |
| kms | `PUT /kms/enabled` (KmsController.setEnabled) | `kms.set_enabled` (destructive) | operation |
| licensing | `GET /licensing/entitlements` (LicensingController.getEntitlements) | `organization.get_entitlements` (read) | operation |
| lifecycle | `GET /lifecycle/unsubscribe` (LifecycleController.unsubscribe) |  | excluded |
| llm-providers | `POST /llm-providers` (LlmProvidersController.createProvider) | `add_provider` | tool |
| llm-providers | `POST /llm-providers/connect` (LlmProvidersController.connectProvider) | `providers.connect` (write) | operation |
| llm-providers | `GET /llm-providers` (LlmProvidersController.getProviders) | `list_providers` | tool |
| llm-providers | `GET /llm-providers/provider-types` (LlmProvidersController.getProviderTypes) | `providers.list_types` (read) | operation |
| llm-providers | `GET /llm-providers/:providerId` (LlmProvidersController.getProvider) | `providers.get` (read) | operation |
| llm-providers | `GET /llm-providers/:providerId/usage` (LlmProvidersController.getProviderUsage) | `providers.get_usage` (read) | operation |
| llm-providers | `PATCH /llm-providers/:providerId` (LlmProvidersController.updateProvider) | `providers.update` (write) | operation |
| llm-providers | `GET /llm-providers/:providerId/agents` (LlmProvidersController.agentsUsingProvider) | `providers.list_agents_using` (read) | operation |
| llm-providers | `DELETE /llm-providers/:providerId` (LlmProvidersController.deleteProvider) | `providers.delete` (destructive) | operation |
| llm-providers | `POST /llm-providers/:providerId/chat` (LlmProvidersController.chat) | `providers.chat` (write) | operation |
| llm-providers | `POST /llm-providers/:providerId/test` (LlmProvidersController.performHealthCheck) | `providers.test` (write) | operation |
| llm-providers | `POST /llm-providers/models/by-type` (LlmProvidersController.getModelsByType) | `providers.list_models_by_type` (read) | operation |
| llm-providers | `POST /llm-providers/test-connection` (LlmProvidersController.testConnection) | `providers.test_connection` (read) | operation |
| llm-providers | `GET /llm-providers/:providerId/models` (LlmProvidersController.getProviderModels) | `providers.list_models` (read) | operation |
| llm-providers | `POST /llm-providers/:providerId/sessions` (LlmSessionsController.createSession) | `providers.create_session` (write) | operation |
| llm-providers | `GET /llm-providers/:providerId/sessions` (LlmSessionsController.getSessions) | `providers.list_sessions` (read) | operation |
| llm-providers | `GET /llm-providers/sessions/:sessionId` (LlmSessionsController.getSession) | `providers.get_session` (read) | operation |
| llm-providers | `PUT /llm-providers/sessions/:sessionId` (LlmSessionsController.updateSession) | `providers.update_session` (write) | operation |
| llm-providers | `DELETE /llm-providers/sessions/:sessionId` (LlmSessionsController.deleteSession) | `providers.delete_session` (destructive) | operation |
| mcp-sources | `POST /organizations/:organizationId/mcp-sources` (McpSourcesController.create) | `mcp_sources.add` (write) | operation |
| mcp-sources | `GET /organizations/:organizationId/mcp-sources` (McpSourcesController.findAll) | `mcp_sources.list` (read) | operation |
| mcp-sources | `GET /organizations/:organizationId/mcp-sources/:id` (McpSourcesController.findOne) | `mcp_sources.get` (read) | operation |
| mcp-sources | `POST /organizations/:organizationId/mcp-sources/:id/sync` (McpSourcesController.sync) | `mcp_sources.sync` (write) | operation |
| mcp-sources | `DELETE /organizations/:organizationId/mcp-sources/:id` (McpSourcesController.remove) | `mcp_sources.remove` (destructive) | operation |
| mcp | `GET /company-signin/:gatewayId/start` (CompanySigninController.start) |  | excluded |
| mcp | `GET /company-signin/:gatewayId/callback` (CompanySigninController.callback) |  | excluded |
| mcp | `POST /company-signin/:gatewayId/approve` (CompanySigninController.approve) |  | excluded |
| mcp | `GET /.well-known/oauth-authorization-server/:orgSlug/:gatewaySlug` (McpOAuthDiscoveryController.authServerMetadata) |  | excluded |
| mcp | `GET /.well-known/oauth-protected-resource/:orgSlug/:gatewaySlug` (McpOAuthDiscoveryController.protectedResourceMetadata) |  | excluded |
| mcp | `GET /:orgSlug/:gatewaySlug/.well-known/oauth-authorization-server` (McpOAuthController.getAuthorizationServerMetadata) |  | excluded |
| mcp | `GET /:orgSlug/:gatewaySlug/.well-known/oauth-protected-resource` (McpOAuthController.getProtectedResourceMetadata) |  | excluded |
| mcp | `GET /:orgSlug/:gatewaySlug/authorize` (McpOAuthController.authorize) |  | excluded |
| mcp | `GET /:orgSlug/:gatewaySlug/oauth-consent` (McpOAuthController.consentInfo) |  | excluded |
| mcp | `POST /:orgSlug/:gatewaySlug/authorize` (McpOAuthController.authorizePost) |  | excluded |
| mcp | `POST /:orgSlug/:gatewaySlug/token` (McpOAuthController.token) |  | excluded |
| mcp | `POST /:orgSlug/:gatewaySlug/register` (McpOAuthController.register) |  | excluded |
| mcp | `POST /:orgSlug/:gatewaySlug/revoke` (McpOAuthController.revoke) |  | excluded |
| mcp | `GET /mcp/sse` (McpTransportController.handleSse) |  | excluded |
| mcp | `POST /mcp/sse/:connectionId/message` (McpTransportController.sendSseMessage) |  | excluded |
| mcp | `GET /mcp/servers/:serverId/sse` (McpTransportController.handleServerSse) |  | excluded |
| mcp | `GET /mcp/transport/stats` (McpTransportController.getTransportStats) |  | excluded |
| mcp | `POST /mcp/broadcast` (McpTransportController.broadcast) |  | excluded |
| mcp | `GET /mcp/transport/health` (McpTransportController.getTransportHealth) |  | excluded |
| mcp | `POST /mcp` (McpController.handleMcp) |  | excluded |
| mcp | `GET /mcp/health` (McpController.health) |  | excluded |
| mcp | `GET /mcp/.well-known/mcp` (McpController.wellKnown) |  | excluded |
| memory | `GET /memory/canonical/backends` (CanonicalMemoryController.listBackends) | `memory_list_backends` | tool |
| memory | `GET /memory/canonical/backends/health` (CanonicalMemoryController.healthAll) | `memory_backends_health` | tool |
| memory | `GET /memory/canonical/accounts` (CanonicalMemoryController.listAccounts) | `memory.list_accounts` (read) | operation |
| memory | `GET /memory/canonical/config` (CanonicalMemoryController.getConfig) | `memory.get_config` (read) | operation |
| memory | `POST /memory/canonical/config` (CanonicalMemoryController.updateConfig) | `memory.update_config` (write) | operation |
| memory | `GET /memory/canonical/warnings/softcap` (CanonicalMemoryController.listSoftcapWarnings) | `memory.list_softcap_warnings` (read) | operation |
| memory | `POST /memory/canonical/consolidate` (CanonicalMemoryController.consolidate) | `memory_consolidate` | tool |
| memory | `POST /memory/canonical/sync` (CanonicalMemoryController.syncScope) | `memory_sync` | tool |
| memory | `POST /memory/canonical/transfer` (CanonicalMemoryController.transfer) | `memory_transfer` | tool |
| memory | `POST /memory/canonical/document/import` (CanonicalMemoryController.importDocument) | `memory.import_document` (write) | operation |
| memory | `GET /memory/canonical/accounts/overview` (CanonicalMemoryController.accountsOverview) | `memory.accounts_overview` (read) | operation |
| memory | `GET /memory/canonical/moves` (CanonicalMemoryController.listMoves) | `memory.list_moves` (read) | operation |
| memory | `GET /memory/canonical/moves/agents` (CanonicalMemoryController.moveAgents) | `memory.list_move_agents` (read) | operation |
| memory | `GET /memory/canonical/moves/:id` (CanonicalMemoryController.getMove) | `memory.get_move` (read) | operation |
| memory | `POST /memory/canonical/moves` (CanonicalMemoryController.startMove) | `memory.start_move` (write) | operation |
| memory | `POST /memory/canonical/moves/:id/resume` (CanonicalMemoryController.resumeMove) | `memory.resume_move` (write) | operation |
| memory | `POST /memory/canonical` (CanonicalMemoryController.put) | `memory_put` | tool |
| memory | `GET /memory/canonical/:id` (CanonicalMemoryController.get) | `memory_get` | tool |
| memory | `DELETE /memory/canonical/:id` (CanonicalMemoryController.remove) | `memory_delete` | tool |
| memory | `POST /memory/canonical/list` (CanonicalMemoryController.list) | `memory_list` | tool |
| memory | `POST /memory/canonical/search` (CanonicalMemoryController.search) | `memory_search` | tool |
| memory | `POST /memory/canonical/:id/supersede` (CanonicalMemoryController.supersede) | `memory_supersede` | tool |
| model-catalog | `POST /models/route-preview` (ModelCatalogController.routePreview) | `preview_model_routing` | tool |
| model-catalog | `GET /models` (ModelCatalogController.list) | `list_models` | tool |
| model-catalog | `GET /models/agents/:agentId/issues` (ModelCatalogController.agentIssues) | `agents.list_model_issues` (read) | operation |
| model-catalog | `POST /models` (ModelCatalogController.register) | `models.register` (write) | operation |
| model-catalog | `POST /models/sync` (ModelCatalogController.sync) | `sync_models` | tool |
| model-catalog | `GET /models/:id` (ModelCatalogController.get) | `models.get` (read) | operation |
| model-catalog | `PATCH /models/:id` (ModelCatalogController.update) | `models.update` (write) | operation |
| model-catalog | `POST /models/:id/validate` (ModelCatalogController.validate) | `validate_model` | tool |
| model-catalog | `DELETE /models/:id` (ModelCatalogController.remove) | `models.remove` (destructive) | operation |
| model-catalog | `GET /analytics/routing/failure-rate` (RoutingAnalyticsController.failureRate) | `get_analytics` | tool |
| model-deployments | `GET /model-adapters` (ModelDeploymentsController.listAdapters) | `model_deployments.list_adapters` (read) | operation |
| model-deployments | `GET /model-deployments` (ModelDeploymentsController.list) | `list_model_deployments` | tool |
| model-deployments | `GET /model-deployments/:id` (ModelDeploymentsController.get) | `model_deployments.get` (read) | operation |
| model-deployments | `POST /model-deployments` (ModelDeploymentsController.create) | `model_deployments.create` (write) | operation |
| model-deployments | `POST /model-deployments/:id/scale` (ModelDeploymentsController.scale) | `model_deployments.scale` (write) | operation |
| model-deployments | `POST /model-deployments/:id/teardown` (ModelDeploymentsController.teardown) | `model_deployments.tear_down` (destructive) | operation |
| model-deployments | `DELETE /model-deployments/:id` (ModelDeploymentsController.remove) | `model_deployments.remove` (destructive) | operation |
| model-registry | `GET /model-versions` (ModelVersionsController.list) | `list_model_versions` | tool |
| model-registry | `POST /model-versions` (ModelVersionsController.register) | `model_versions.register` (write) | operation |
| model-registry | `GET /model-versions/:id` (ModelVersionsController.get) | `model_versions.get` (read) | operation |
| model-registry | `DELETE /model-versions/:id` (ModelVersionsController.remove) | `model_versions.remove` (destructive) | operation |
| monitoring | `GET /analytics/overview` (AnalyticsController.getOverview) | `get_analytics` | tool |
| monitoring | `GET /analytics/requests` (AnalyticsController.getRequestLogs) | `analytics.list_requests` (read) | operation |
| monitoring | `GET /analytics/tool-usage` (AnalyticsController.getToolUsage) | `get_analytics` | tool |
| monitoring | `GET /analytics/script-usage` (AnalyticsController.getScriptUsage) | `analytics.get_script_usage` (read) | operation |
| monitoring | `GET /analytics/gateway-usage` (AnalyticsController.getGatewayUsage) | `get_analytics` | tool |
| monitoring | `GET /analytics/llm-usage` (AnalyticsController.getLlmUsage) | `get_analytics` | tool |
| monitoring | `GET /analytics/timeline` (AnalyticsController.getTimeline) | `analytics.get_timeline` (read) | operation |
| monitoring | `GET /analytics/audit-summary` (AnalyticsController.getAuditSummary) | `analytics.get_audit_summary` (read) | operation |
| monitoring | `GET /analytics/agent-runs` (AnalyticsController.getAgentRuns) | `get_analytics` | tool |
| monitoring | `GET /analytics/export` (AnalyticsController.exportLogs) | `analytics.export` (read) | operation |
| monitoring | `GET /monitoring/health` (MonitoringController.getHealth) |  | excluded |
| monitoring | `GET /monitoring/health/details` (MonitoringController.getHealthDetails) |  | excluded |
| monitoring | `GET /monitoring/metrics` (MonitoringController.getMetrics) |  | excluded |
| monitoring | `GET /monitoring/metrics/history` (MonitoringController.getMetricsHistory) |  | excluded |
| monitoring | `GET /monitoring/alerts` (MonitoringController.getAlerts) | `get_analytics` | tool |
| monitoring | `POST /monitoring/alerts/:alertId/resolve` (MonitoringController.resolveAlert) | `monitoring.resolve_alert` (write) | operation |
| monitoring | `GET /monitoring/metrics/prometheus` (MonitoringController.getPrometheusMetrics) |  | excluded |
| monitoring | `GET /monitoring/stats/live` (MonitoringController.getLiveStats) | `monitoring.get_live_stats` (read) | operation |
| monitoring | `GET /monitoring/enterprise/dashboard` (MonitoringController.getEnterpriseDashboard) | `monitoring.get_enterprise_dashboard` (read) | operation |
| notifications | `GET /notifications` (NotificationsController.list) | `notifications.list` (read) | operation |
| notifications | `GET /notifications/preferences` (NotificationsController.getPreferences) | `notifications.get_preferences` (read) | operation |
| notifications | `PUT /notifications/preferences` (NotificationsController.updatePreferences) | `notifications.update_preferences` (write) | operation |
| notifications | `POST /notifications/read-all` (NotificationsController.readAll) | `notifications.mark_all_read` (write) | operation |
| notifications | `POST /notifications/:id/read` (NotificationsController.read) | `notifications.mark_read` (write) | operation |
| onboarding | `GET /organizations/:organizationId/onboarding` (OnboardingController.getOnboarding) | `organization.get_onboarding` (read) | operation |
| onboarding | `PATCH /organizations/:organizationId/onboarding` (OnboardingController.patchOnboarding) | `organization.update_onboarding` (write) | operation |
| organizations | `GET /invites/membership/:membershipId` (InvitesController.getMembershipInvite) |  | excluded |
| organizations | `POST /invites/membership/:membershipId/accept` (InvitesController.acceptMembershipInvite) |  | excluded |
| organizations | `GET /invites/:token` (InvitesController.getInviteDetails) |  | excluded |
| organizations | `POST /invites/:token/accept` (InvitesController.acceptInvite) |  | excluded |
| organizations | `GET /organizations` (OrganizationsController.getUserOrganizations) | `organization.list_mine` (read) | operation |
| organizations | `POST /organizations` (OrganizationsController.createOrganization) | `organization.create` (write) | operation |
| organizations | `GET /organizations/:organizationId` (OrganizationsController.getOrganization) | `organization.get` (read) | operation |
| organizations | `PATCH /organizations/:organizationId` (OrganizationsController.updateOrganization) | `organization.update` (write) | operation |
| organizations | `DELETE /organizations/:organizationId` (OrganizationsController.deleteOrganization) | `organization.delete` (destructive) | operation |
| organizations | `GET /organizations/:organizationId/members` (OrganizationsController.getOrganizationMembers) | `list_org_members` | tool |
| organizations | `POST /organizations/:organizationId/members` (OrganizationsController.inviteUserToOrganization) | `members.invite` (write) | operation |
| organizations | `GET /organizations/:organizationId/invites` (OrganizationsController.listPendingInvites) | `organization.list_pending_invites` (read) | operation |
| organizations | `DELETE /organizations/:organizationId/invites/:inviteId` (OrganizationsController.revokePendingInvite) | `members.revoke_invite` (destructive) | operation |
| organizations | `PUT /organizations/:organizationId/members/:userId` (OrganizationsController.updateMemberRole) | `members.update_role` (write) | operation |
| organizations | `DELETE /organizations/:organizationId/members/:userId` (OrganizationsController.removeMember) | `members.remove` (destructive) | operation |
| organizations | `GET /organizations/:organizationId/teams` (OrganizationsController.getOrganizationTeams) | `teams.list` (read) | operation |
| organizations | `POST /organizations/:organizationId/teams` (OrganizationsController.createTeam) | `teams.create` (write) | operation |
| organizations | `PUT /organizations/:organizationId/teams/:teamId` (OrganizationsController.updateTeam) | `teams.update` (write) | operation |
| organizations | `DELETE /organizations/:organizationId/teams/:teamId` (OrganizationsController.deleteTeam) | `teams.delete` (destructive) | operation |
| organizations | `GET /organizations/:organizationId/teams/:teamId/members` (OrganizationsController.getTeamMembers) | `teams.list_members` (read) | operation |
| organizations | `POST /organizations/:organizationId/teams/:teamId/members` (OrganizationsController.addMemberToTeam) | `teams.add_member` (write) | operation |
| organizations | `PUT /organizations/:organizationId/teams/:teamId/members/:userId` (OrganizationsController.updateTeamMemberRole) | `teams.update_member_role` (write) | operation |
| organizations | `DELETE /organizations/:organizationId/teams/:teamId/members/:userId` (OrganizationsController.removeMemberFromTeam) | `teams.remove_member` (destructive) | operation |
| promoted-skills | `POST /promoted-skills` (PromotedSkillsController.promote) | `promoted_skills.promote` (write) | operation |
| promoted-skills | `GET /promoted-skills` (PromotedSkillsController.list) | `promoted_skills.list` (read) | operation |
| promoted-skills | `GET /promoted-skills/:id` (PromotedSkillsController.get) | `promoted_skills.get` (read) | operation |
| promoted-skills | `GET /promoted-skills/:id/skill.md` (PromotedSkillsController.raw) | `promoted_skills.get_skill_md` (read) | operation |
| promoted-skills | `DELETE /promoted-skills/:id` (PromotedSkillsController.remove) | `promoted_skills.remove` (destructive) | operation |
| provider-usage | `GET /provider-usage/capabilities` (ProviderUsageController.getCapabilities) | `provider_usage.list_capabilities` (read) | operation |
| provider-usage | `GET /provider-usage/reconciliation` (ProviderUsageController.reconciliation) | `provider_usage.reconciliation` (read) | operation |
| provider-usage | `POST /provider-usage/sync` (ProviderUsageController.sync) | `provider_usage.sync` (write) | operation |
| referrals | `GET /referrals/code` (ReferralsController.getCode) | `referrals.get_code` (read) | operation |
| referrals | `GET /referrals/stats` (ReferralsController.getStats) | `referrals.get_stats` (read) | operation |
| referrals | `GET /referrals` (ReferralsController.list) | `referrals.list` (read) | operation |
| referrals | `GET /referrals/attribute/:code` (ReferralsController.attribute) |  | excluded |
| retention | `GET /organizations/:organizationId/retention` (RetentionController.getRetentionPolicy) | `organization.get_retention` (read) | operation |
| retention | `PUT /organizations/:organizationId/retention` (RetentionController.updateRetentionPolicy) | `organization.update_retention` (destructive) | operation |
| runner | `POST /runners/register` (RunnerController.register) |  | excluded |
| runner | `POST /runners` (RunnerController.create) | `runners.create` (write) | operation |
| runner | `GET /runners` (RunnerController.list) | `list_runners` | tool |
| runner | `GET /runners/:id` (RunnerController.getOne) | `runners.get` (read) | operation |
| runner | `PATCH /runners/:id` (RunnerController.update) | `runners.update` (write) | operation |
| runner | `DELETE /runners/:id` (RunnerController.unregister) | `runners.remove` (destructive) | operation |
| runner | `GET /runners/:id/agents` (RunnerController.agentList) | `runners.list_agents` (read) | operation |
| runner | `POST /runners/:id/agents/spawn` (RunnerController.agentSpawn) | `runners.spawn_agent` (write) | operation |
| runner | `POST /runners/:id/agents/status` (RunnerController.agentStatus) | `runners.get_agent_status` (read) | operation |
| runner | `GET /runners/:id/coding/agents` (RunnerController.codingAgents) | `runners.list_coding_agents` (read) | operation |
| runner | `POST /runners/:id/coding/sessions` (RunnerController.codingStart) | `runners.start_coding_session` (write) | operation |
| runner | `GET /runners/:id/coding/sessions/:sessionId` (RunnerController.codingStatus) | `runners.get_coding_session` (read) | operation |
| runner | `POST /runners/:id/coding/sessions/:sessionId/input` (RunnerController.codingInput) | `runners.send_coding_input` (write) | operation |
| runner | `POST /runners/:id/coding/sessions/:sessionId/stop` (RunnerController.codingStop) | `runners.stop_coding_session` (write) | operation |
| runner | `GET /runners/:id/coding/sessions/:sessionId/events` (RunnerController.codingEvents) |  | excluded |
| runner | `POST /runners/stream` (WorkerStreamController.post) |  | excluded |
| runner | `GET /runners/stream` (WorkerStreamController.open) |  | excluded |
| runner | `POST /mcp/streamable` (WorkerStreamController.legacyPost) |  | excluded |
| runner | `GET /mcp/streamable` (WorkerStreamController.legacyOpen) |  | excluded |
| runner | `POST /runners/hosted/stream` (WorkerStreamController.hostedPost) |  | excluded |
| runner | `GET /runners/hosted/stream` (WorkerStreamController.hostedOpen) |  | excluded |
| tool-hub | `GET /tool-hub/templates` (ToolHubController.listTemplates) | `list_tool_templates` | tool |
| tool-hub | `GET /tool-hub/providers` (ToolHubController.getProviders) | `tool_hub.list_providers` (read) | operation |
| tool-hub | `GET /tool-hub/categories` (ToolHubController.getCategories) | `tool_hub.list_categories` (read) | operation |
| tool-hub | `GET /tool-hub/templates/:id` (ToolHubController.getTemplate) | `tool_hub.get_template` (read) | operation |
| tool-hub | `POST /tool-hub/templates/:id/install` (ToolHubController.installTemplate) | `install_tool_template` | tool |
| tool-hub | `POST /tool-hub/providers/:provider/install` (ToolHubController.installProviderTemplates) | `tool_hub.install_provider_templates` (write) | operation |
| tool-hub | `POST /tool-hub/templates` (ToolHubController.publishTemplate) | `tool_hub.publish_template` (write) | operation |
| tool-hub | `PATCH /tool-hub/templates/:id` (ToolHubController.updateTemplate) | `tool_hub.update_template` (write) | operation |
| tool-hub | `DELETE /tool-hub/templates/:id` (ToolHubController.deleteTemplate) | `tool_hub.delete_template` (destructive) | operation |
| tools | `GET /organizations/:organizationId/tools/:toolId/skill` (ToolsExportController.getToolSkill) | `tools.export_skill` (read) | operation |
| tools | `GET /organizations/:organizationId/tools/:toolId/cli` (ToolsExportController.getToolCli) | `tools.export_cli` (read) | operation |
| tools | `GET /organizations/:organizationId/tools/:toolId/sdk` (ToolsExportController.getToolSdk) | `tools.export_sdk` (read) | operation |
| tools | `POST /organizations/:organizationId/tools` (ToolsController.createTool) | `tools.create` (write) | operation |
| tools | `GET /organizations/:organizationId/tools` (ToolsController.getTools) | `list_tools` | tool |
| tools | `POST /organizations/:organizationId/tools/search` (ToolsController.searchTools) | `tools.search` (read) | operation |
| tools | `GET /organizations/:organizationId/tools/:toolId/signature` (ToolsController.toolSignature) | `tools.get_signature` (read) | operation |
| tools | `GET /organizations/:organizationId/tools/:toolId` (ToolsController.getTool) | `tools.get` (read) | operation |
| tools | `PUT /organizations/:organizationId/tools/:toolId` (ToolsController.updateTool) | `tools.update` (write) | operation |
| tools | `DELETE /organizations/:organizationId/tools/:toolId` (ToolsController.deleteTool) | `delete_tool` | tool |
| tools | `POST /organizations/:organizationId/tools/:toolId/activate` (ToolsController.activateTool) | `activate_tool` | tool |
| tools | `POST /organizations/:organizationId/tools/:toolId/deactivate` (ToolsController.deactivateTool) | `tools.deactivate` (write) | operation |
| tools | `POST /organizations/:organizationId/tools/:toolId/execute` (ToolsController.executeTool) | `tools.execute` (write) | operation |
| tools | `GET /organizations/:organizationId/tools/:toolId/versions` (ToolsController.getToolVersions) | `tools.list_versions` (read) | operation |
| tools | `GET /organizations/:organizationId/tools/:toolId/stats` (ToolsController.getToolStats) | `tools.get_stats` (read) | operation |
| tools | `POST /organizations/:organizationId/tools/generate-from-api/:apiId` (ToolsController.generateToolsFromApi) | `tools.generate_from_api` (write) | operation |
| tools | `POST /organizations/:organizationId/tools/:toolId/regenerate` (ToolsController.regenerateTool) | `tools.regenerate` (write) | operation |
| tools | `GET /organizations/:organizationId/tools/stats/overview` (ToolsController.getOrganizationStats) | `tools.get_overview_stats` (read) | operation |
| users | `GET /users` (UsersController.findAll) | `users.list` (read) | operation |
| users | `GET /users/search` (UsersController.searchUsers) | `users.search` (read) | operation |
| users | `GET /users/me` (UsersController.getCurrentUser) | `users.get_me` (read) | operation |
| users | `GET /users/me/activity` (UsersController.getCurrentUserActivity) | `users.get_my_activity` (read) | operation |
| users | `GET /users/:id` (UsersController.findOne) | `users.get` (read) | operation |
| users | `PATCH /users/me` (UsersController.updateCurrentUser) | `users.update_me` (write) | operation |
| users | `PATCH /users/:id` (UsersController.update) | `users.update` (write) | operation |
| users | `POST /users/:id/deactivate` (UsersController.deactivate) | `users.deactivate` (write) | operation |
| users | `POST /users/:id/reactivate` (UsersController.reactivate) | `users.reactivate` (write) | operation |
| users | `DELETE /users/:id` (UsersController.remove) | `users.delete` (destructive) | operation |
| users | `GET /users/:id/stats` (UsersController.getUserStats) | `users.get_stats` (read) | operation |
| users | `GET /users/:id/activity` (UsersController.getUserActivity) | `users.get_activity` (read) | operation |
| versions | `GET /versions/detail/:versionId` (VersionsController.getVersion) | `versions.get` (read) | operation |
| versions | `GET /versions/:entityType/:entityId` (VersionsController.getVersions) | `versions.list` (read) | operation |
| workspace | `POST /workspaces` (WorkspaceController.create) | `workspaces.create` (write) | operation |
| workspace | `GET /workspaces` (WorkspaceController.list) | `list_runners` | tool |
| workspace | `GET /workspaces/:id` (WorkspaceController.getOne) | `workspaces.get` (read) | operation |
| workspace | `DELETE /workspaces/:id` (WorkspaceController.release) | `workspaces.release` (destructive) | operation |

## Exclusions

- Sign-in, sign-up and session handling: an MCP client is already signed in through the MCP OAuth flow and must not create, refresh or end sessions, or handle passwords and email verification.
  `AuthController.checkOrganizationName`, `AuthController.register`, `AuthController.login`, `AuthController.token`, `AuthController.refresh`, `AuthController.logout`, `AuthController.forgotPassword`, `AuthController.resetPassword`, `AuthController.changePassword`, `AuthController.verifyEmail`, `AuthController.verifyEmailLink`, `AuthController.resendVerification`, `AuthController.resendVerificationByEmail`, `InvitesController.getMembershipInvite`, `InvitesController.acceptMembershipInvite`, `InvitesController.getInviteDetails`, `InvitesController.acceptInvite`, `ReferralsController.attribute`
- Single sign-on browser flow (redirects, IdP callbacks, SAML posts): run by a browser and an identity provider, not by an MCP client.
  `SsoController.discover`, `SsoController.samlLogin`, `SsoController.samlCallback`, `SsoController.samlComplete`, `SsoController.samlMetadata`, `SsoController.oidcLogin`, `SsoController.oidcCallback`
- SCIM provisioning: authenticated by the organization's SCIM token and called by its identity provider, not by a signed-in user.
  `ScimController.createUser`, `ScimController.listUsers`, `ScimController.getUser`, `ScimController.replaceUser`, `ScimController.patchUser`, `ScimController.deleteUser`, `ScimController.createGroup`, `ScimController.listGroups`, `ScimController.getGroup`, `ScimController.patchGroup`, `ScimController.deleteGroup`
- Returns the SCIM bearer token in plaintext: the credential the identity provider provisions with, set up in the app together with the provider, not a key for the MCP client.
  `SsoConfigController.rotateScimToken`, `SsoConfigController.revealScimToken`
- OAuth redirect callback or OAuth client document: reached by a browser coming back from a provider, or fetched by the provider itself.
  `CredentialSignInController.clientMetadata`, `CredentialSignInController.callback`, `OAuth2Controller.callback`, `ChannelInstallController.installSlack`, `ChannelInstallController.installSlackCallback`, `CompanySigninController.start`, `CompanySigninController.callback`, `CompanySigninController.approve`
- Public endpoint for visitors of a published chat, widget or hosted-chat page: what an agent's channel serves, not organization management.
  `HostedChatSsoController.login`, `HostedChatSsoController.callback`, `HostedChatSsoController.samlAcs`, `HostedChatSsoController.samlComplete`, `HostedChatEmailAuthController.start`, `HostedChatEmailAuthController.verify`, `HostedChatOAuthController.login`, `HostedChatOAuthController.callback`, `HostedChatController.byHost`, `HostedChatController.branding`, `HostedChatController.me`, `HostedChatController.deleteConversation`, `HostedChatController.deleteMe`, `HostedChatController.exportMe`, `HostedChatController.listConversations`, `HostedChatController.uploadAttachment`, `HostedChatController.postMessage`, `HostedChatController.stream`, `HostedChatController.messages`, `ChannelWidgetController.widgetScript`, `ChannelWidgetController.widgetPreview`, `ChannelWidgetController.widgetPreviewScript`, `ChannelWidgetController.widgetConfig`, `ChannelWidgetController.uploadAttachment`, `ChannelWidgetController.postMessage`, `ChannelWidgetController.listMessages`, `ChannelWidgetController.streamReply`, `ChannelWidgetController.exportThread`, `ChannelWidgetController.deleteThread`
- Inbound webhook from a third party (Stripe, an email provider, a push-wake subscription): authenticated by the sender's signature, not by a user.
  `BillingWebhookController.handleWebhook`, `ChannelEmailInboundController.inbound`, `PushWakeReceiverController.receive`
- A protocol endpoint itself (MCP, A2A, UTCP, OAuth for MCP clients, the OpenAI- and Anthropic-compatible APIs): the MCP client already speaks to agents and gateways through these, and invoke_agent runs an agent.
  `UnifiedEndpointController.handleRootAgentCard`, `UnifiedEndpointController.handleRootJsonRpc`, `UnifiedEndpointController.handleRequest`, `UnifiedEndpointController.handleSubPathRequest`, `McpOAuthDiscoveryController.authServerMetadata`, `McpOAuthDiscoveryController.protectedResourceMetadata`, `McpOAuthController.getAuthorizationServerMetadata`, `McpOAuthController.getProtectedResourceMetadata`, `McpOAuthController.authorize`, `McpOAuthController.consentInfo`, `McpOAuthController.authorizePost`, `McpOAuthController.token`, `McpOAuthController.register`, `McpOAuthController.revoke`, `McpTransportController.handleSse`, `McpTransportController.sendSseMessage`, `McpTransportController.handleServerSse`, `McpTransportController.getTransportStats`, `McpTransportController.broadcast`, `McpTransportController.getTransportHealth`, `McpController.handleMcp`, `McpController.health`, `McpController.wellKnown`, `AgentOpenAICompatController.chatCompletions`, `AgentOpenAICompatController.listModels`, `AgentOpenAICompatController.retrieveModel`, `AgentAnthropicCompatController.messages`, `ModelPassThroughController.responses`, `ModelPassThroughController.countTokens`
- Runner daemon channel: called by the runner on its own machine with its runner credential (registration, credential renewal, the work stream), not by a person.
  `RunnerController.register`, `HostedRunnerEnrollmentController.enroll`, `HostedRunnerEnrollmentController.renew`, `HostedRunnerEnrollmentController.renewModelToken`, `WorkerStreamController.post`, `WorkerStreamController.open`, `WorkerStreamController.legacyPost`, `WorkerStreamController.legacyOpen`, `WorkerStreamController.hostedPost`, `WorkerStreamController.hostedOpen`
- A live event stream (server-sent events). An MCP tool call returns once; the same state is read with the matching get operation (get_run, check_import_status, runners.get_coding_session) or the run is followed as an MCP task.
  `AgentExecutionController.streamAgent`, `AgentRunsController.streamRun`, `ApisController.streamImportStatus`, `RunnerController.codingEvents`
- A binary file transfer (upload or download). An MCP tool call carries JSON; the file's metadata is read with files.get, and a build is fetched through channels.get_build_download_link.
  `FilesController.upload`, `FilesController.download`, `AgentChannelsController.artifact`
- Unauthenticated operational endpoint (health and system-wide metrics for probes and scrapers), not organization data.
  `HealthController.check`, `HealthController.liveness`, `HealthController.readiness`, `MonitoringController.getHealth`, `MonitoringController.getHealthDetails`, `MonitoringController.getMetrics`, `MonitoringController.getMetricsHistory`, `MonitoringController.getPrometheusMetrics`
- One-click link in an email (unsubscribe), authenticated by the token in the link.
  `LifecycleController.unsubscribe`
- Takes a secret; add it in the app. No MCP argument carries a secret, so calling it answers with the app page instead.
  `CredentialsController.create`, `CredentialsController.update`, `CredentialsController.rotate`, `OAuth2Controller.authorize`, `OAuth2Controller.clientCredentials`, `ApisCredentialsController.setKey`, `ApisCredentialsController.createCredential`, `ApisCredentialsController.updateCredential`, `VisitorOAuthConfigController.set`

## Held for a product decision

None: every route is a tool, an operation or an exclusion.

<!-- coverage:end -->
