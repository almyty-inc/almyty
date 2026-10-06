# Enterprise features

almyty is open core. Everything in `backend/src` is Apache-2.0 and stays
open: agents, tools of every type, gateways, every protocol, BYOK,
single-org RBAC, memory, and the runner. `backend/ee` holds the features
enterprises need and individuals never miss.

This page is the list, what each one actually does, and which plan grants
it. The authoritative source is `PLAN_ENTITLEMENTS` in
`backend/ee/modules/billing/billing.constants.ts`; the customer-facing
mirror is `frontend/src/lib/plan-catalog.ts`, and a test asserts the two
agree.

## How gating works

Licensing is **per organization**, not per deployment. Billing mints a
signed token per org on a Stripe webhook; `EntitlementGuard` resolves the
requesting org's entitlements on every guarded route, and
`GET /licensing/entitlements` answers for the requesting org. Each minted
token carries an `organizationId` claim and `resolveToken` honours a
stored token only for that org, so a token copied into another org's
billing record grants nothing there. An environment token without the
claim is install-wide; one with it serves that org alone and is never
applied process-wide.

There is a second, deployment-global `LicenseService` that reads a token
from the environment. It answers a different question — "is this
deployment licensed at all" — and must not be used to decide what an
organization may do. An EE hook holds an `organizationId`, so it uses
`OrgLicenseResolver.hasForOrg(organizationId, key)`. A guard test
(`backend/ee/__tests__/entitlements-are-per-org.spec.ts`) forbids a hook
importing `LicenseService`, because four of them once did and every paid
feature was silently inert on the hosted deployment as a result.

Entitlement checks **fail closed**: a database error or an unreadable
token resolves to community, never to allowed.

## Business

| Entitlement | What it does |
|---|---|
| `sso` | SAML and OIDC sign-in, plus SCIM provisioning from Okta or Entra. Configured per org under Settings → People and access → Single sign-on. Also unlocks visitor sign-in (the `sso` auth mode) on an agent's channels. |
| `advanced_rbac` | Custom roles and attribute-based rules beyond the built-in owner/admin/member tiers. |
| `approval_policy` | Multi-step and quorum approval gates. Without it, a request is decided by a single approver. |
| `compliance_pack` | Org-enforced plugin policy — PII filtering and the security scanner applied to every run rather than per agent. |
| `audit_export` | Bulk export of the org's audit trail as CSV or JSON, lifting the in-app 200-row cap, plus streaming to a customer SIEM. |
| `credentials_governance` | Policy over which connectors may be connected, by whom, and how their grants are used. |
| `agent_identity` | An agent can act as itself instead of as the person who made it: it uses only the connections granted to it, and the audit log names the agent as the one who acted. Turned on per agent under Capabilities → Acts as. See [Agents that act as themselves](#agents-that-act-as-themselves). |

## Enterprise

Everything in Business, plus:

| Entitlement | What it does |
|---|---|
| `byo_kms` | Customer-managed encryption keys. Channel and credential secrets are wrapped with your own AWS KMS CMK instead of the platform key. Configured under Settings → Advanced → Encryption. The route is `/kms`. |
| `chargeback` | Cost attribution per team and per agent, with a projection for the rest of the period, under Analytics → Chargeback. |
| `white_label` | Removes the almyty mark from an agent's channels, and permits turning a channel's AI disclosure off. |

### A note on `white_label` and the AI disclosure

White label governs two separate things, and the second is a compliance
control rather than branding.

Removing the almyty mark is cosmetic. **Clearing the AI disclosure is
not**: EU AI Act Art. 50 requires that a person interacting with an AI
system is told so. The entitlement permits removal because some
deployments satisfy that obligation elsewhere — in a wrapper application,
or in terms the visitor has already accepted. It does not remove the
obligation, and clearing the line without another disclosure in place is
a decision for your counsel, not a product setting.

Mechanically there are two ways to remove it. Every channel that talks to
people has an **AI disclosure** switch (`configuration.aiDisclosure`, on
unless it is turned off), and the agent's branding carries the line itself
(`branding.aiDisclosure`: unset means "use the default line" and is always
allowed; an empty string is a deliberate removal). Turning the switch off
or emptying the line requires the entitlement. Both are enforced on the
server when the channel is saved and when it is published, and the
entitlement is re-read when a web chat page is served, so a web chat published under
Enterprise and then downgraded gets the mark and the disclosure back rather
than keeping them off indefinitely.

## Agents that act as themselves

Normally, when an agent works on its own (on a schedule, say), it acts as
the person who made it. It can use whatever that person can use: their
connections, their tools, their model providers. The audit log names that
person.

On Business and Enterprise an agent can act as itself instead. Open the
agent, go to **Capabilities → Acts as**, and pick **Itself, with its own
access**. From then on:

- It uses only the connections you give it. Give one under Credentials, in
  "Who can use each credential": pick the credential, then add the agent.
  Your own personal and private connections are never used, even though you
  own the agent.
- It reaches tools, model providers and machines the way a team or the
  organization would: what is shared with the whole organization, what
  belongs to the agent's own team if it is a team agent, and what is private
  to you only if the agent itself is private to you. Model providers private
  to you are never used.
- The audit log names the agent as the one who acted, with no person
  attached.

If the plan stops including it, the agent keeps the setting but its runs go
back to acting as its owner until the plan includes it again. Turning it on
without the plan is refused when you save.

Today this applies to scheduled runs. Runs someone starts by hand, through
a channel or from the API act as whoever started them, as before.

### For developers

- The setting is `agents.agentConfig.runAs` (`'owner'` | `'agent'`),
  checked on save by `AgentIdentityService.assertMaySave` (only when it is
  newly turned on, so an agent saved before a downgrade can still be edited).
- `unattendedPrincipal(agent, licensed, source)` in
  `backend/src/modules/agents/agent-identity.ts` returns the principal an
  unattended run acts as; `AgentIdentityService.principalFor(agent, source)`
  reads the entitlement for you. The scheduler uses it; the run row then has
  `userId = null`.
- The principal is `AgentPrincipal` (`kind: 'agent'`) in
  `common/authorization/execution-access.service.ts`.
  `ExecutionAccessService.canAgentExecute` mirrors the gateway rule: the
  agent itself, org resources, its own team's resources, and private
  resources only when the agent is private to the same owner.
  `actingUserId` is null for it, so private credentials never resolve.
- Connections: `GrantsUsePolicy` judges it as
  `agentGrantPrincipal` (no user, no role, its team for a team agent, its
  own id pinned as the agent a grant may name), so only `agent` grants (and
  team grants for a team agent) let it use a connection. Org governance sees
  it as principal kind `agent`.
- Audit: the step processor and the workflow engine put
  `actor: { kind: 'agent', agentId }` in the request scope, and
  `AuditLogService` writes it as `details.actor` on every row written in
  that scope.

## What is deliberately not gated

Agents, tools, gateways, protocols, BYOK, memory, the runner, scheduling,
webhooks, analytics, the basic audit log, and single-org RBAC. That
surface is the product and the adoption path; gating it would cost more
in trust than it earns in revenue.
