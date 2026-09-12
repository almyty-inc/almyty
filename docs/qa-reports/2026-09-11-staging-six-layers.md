# Staging browser QA — 2026-09-11

## Scope and environment

VibeSurfer browser QA against `https://app.staging.almyty.com` and
`https://customer-care-console.staging.almyty.app`, signed in as the Ava fixture
in Northwind AI. The deployed baseline was `21a9187b` (#612, including #603).
These are QA environment addresses, not the base URLs for public documentation.
No production resources or paid model deployments were changed.

## Browser results

| Check | Observed result |
| --- | --- |
| Sign in | Passed with the existing Ava fixture account. |
| Hosted-chat response | A new conversation received a reply identifying the assistant as an unconnected demo. No busy error or missing reply in these two turns. |
| Follow-up | Explained a pasted fictional renewal clause and suggested questions for a lawyer, rather than blanket-refusing document discussion. This is a functionality check, not certification of legal accuracy. |
| History after reload | The new conversation remained listed; reopening restored both replies. |
| Mobile chat | At 390 × 844, messages wrapped and the composer remained visible. |
| Visitor export | Download my data produced an 11,109-byte JSON download. No deletion was attempted on existing visitor history. |
| Models catalog | Loaded 205 unvalidated cards from five existing providers. Validating `gpt-4o-mini` completed a real provider call and changed its card to Passed / Selectable. The summary became 1 usable model across 1 vendor. |
| Routing-set selection | The validated model could be added to a routing set. This does not establish that route-preview or a routed execution works. |
| Create organization | **Failed:** name plus optional description returned to the unchanged dialog, with no organization created. Reproduced twice. Backend logs confirmed HTTP 500 (see below). |
| Execution tab | Roles, five built-in strategies and Orchestrator rendered. Strategy seeds were available without a separate seeding step. |
| Empty-role recovery | **Failed:** the draft had no roles; all five strategies required missing roles, but the page offered no Add role control. |
| Orchestrator persistence | **Failed:** enable Orchestrator → Overview → Execution returned it to disabled. The component uses local state rather than a save mutation. |

Evidence:

- [Chat replies](2026-09-11-chat-replies.png)
- [Mobile chat](2026-09-11-chat-mobile.png)
- [Organization creation failure](2026-09-11-org-create-before.png)
- [Execution empty-role dead end](2026-09-11-execution-no-roles.png)
- [Orchestrator enabled before leaving the tab](2026-09-11-orchestrator-before-leaving.png)

## Organization creation fix

At 16:09:18 and 16:09:37 UTC, the staging API logged the exact cause:

> Undefined value encountered in property 'Organization.slug' of a where condition.

The UI correctly omits the optional slug. `OrganizationsService.create` passed
that missing field into the duplicate query before generating the slug for the
insert. Strict TypeORM rejects the query before any insert occurs.

The fix calculates the effective slug first and uses it for both the duplicate
check and the saved entity. This also detects generated-slug collisions before
an insert. It does **not** weaken the database's undefined-value protection.
The creation dialog now retains an inline, accessible API error, reads the
wrapped backend error shape, preserves entered values and clears the old error
when retrying or reopening the dialog.

### Local verification

- New backend regression first reproduced the exact TypeORM error by compiling
  the service's actual find options through the real TypeORM query builder.
  No database socket is used in that test; it is not a DB-integration claim.
- Both new backend checks failed on the original implementation. After the
  fix, the organizations suite passed **79/79** tests.
- The new UI regression failed because the original dialog had no alert;
  after the fix it passed, including preserved input and clearing on retry.
- Focused UI, API-error and toast suites passed **9/9** tests.
- Backend TypeScript check and frontend TypeScript/production build passed.
- Full frontend suite passed **124 files / 980 tests**, including hosted chat.
  One green full-suite run does not close the independently tracked chat flake.
- Live post-deploy verification of the organization fix is still pending.

## Still open / not claimed

The new-organization → connect provider → select model → run chain is blocked
at organization creation on the deployed baseline. No new organization was
created by the failed attempts. Only the existing QA model's validation state
was changed. The existing disposable draft was never activated.

Execution persistence and role creation were reported to the implementing
agent with reproduction steps. They are not fixed by the organization patch.
Authenticated route-preview, pinned/resolved role persistence, strategy
pick/eject execution, orchestrator fallback and the unmodified-model Anthropic
SDK inbound test remain unverified. Fixture-only deployment adapters are not
represented as live-tested.
