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
| `sso` | SAML and OIDC sign-in, plus SCIM provisioning from Okta or Entra. Configured per org under Settings → SSO. |
| `advanced_rbac` | Custom roles and attribute-based rules beyond the built-in owner/admin/member tiers. |
| `approval_policy` | Multi-step and quorum approval gates. Without it, a request is decided by a single approver. |
| `compliance_pack` | Org-enforced plugin policy — PII filtering and the security scanner applied to every run rather than per agent. |
| `audit_export` | Bulk export of the org's audit trail as CSV or JSON, lifting the in-app 200-row cap, plus streaming to a customer SIEM. |
| `connections_governance` | Policy over which connectors may be connected, by whom, and how their grants are used. |

## Enterprise

Everything in Business, plus:

| Entitlement | What it does |
|---|---|
| `byo_kms` | Customer-managed encryption keys. Channel and credential secrets are wrapped with your own AWS KMS CMK instead of the platform key. Configured under Settings → Encryption. The route is `/kms`. |
| `chargeback` | Cost attribution per team and per agent, with a projection for the rest of the period, under Analytics → Chargeback. |
| `white_label` | Removes the almyty mark from published surfaces, and permits removing the AI disclosure line. |

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

Mechanically: `aiDisclosure: null` means "use the default line" and is
always allowed. An empty string is a deliberate removal and requires the
entitlement. Both are enforced on the server when a hosted-chat surface
is saved, and the entitlement is re-read when the public page is served —
so a surface published under Enterprise and then downgraded gets the mark
and the disclosure back rather than keeping them off indefinitely.

## What is deliberately not gated

Agents, tools, gateways, protocols, BYOK, memory, the runner, scheduling,
webhooks, analytics, the basic audit log, and single-org RBAC. That
surface is the product and the adoption path; gating it would cost more
in trust than it earns in revenue.
