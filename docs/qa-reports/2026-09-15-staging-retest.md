# Staging re-test — 2026-09-15

## Environment and evidence

VibeSurfer MCP browser testing against `https://app.staging.almyty.com` and
`https://customer-care-console.staging.almyty.app`, using the existing Ava
fixture in Northwind AI. These addresses identify the QA environment only;
they are not public documentation base URLs. No production deployment was made.

## Hosted chat

On the pre-promotion staging build `015bca8d`:

| Check | Result |
| --- | --- |
| New conversation | PASS: received a reply and identified the assistant as an unconnected customer-support demo. |
| Fictional contract follow-up | PASS: explained renewal/cancellation language and suggested questions for a lawyer rather than blanket-refusing. This tests functionality, not legal accuracy. |
| Reload and reopen | PASS: conversation remained in the sidebar and both replies returned. |
| Mobile, 390 × 844 | PASS: messages wrapped, navigation collapsed, composer remained visible. |

- [Desktop conversation](2026-09-15-chat-replies.png)
- [Mobile conversation after reload](2026-09-15-chat-mobile.png)

These are two successful turns, not a load test or an assertion that every
provider and failure mode works.

## Promotion

Organization-creation fix #616 and runtime orchestrator fix #619 were already
merged into development, but promotion #618 remained open. GitHub reported a
conflict despite a clean local merge. Merging staging's history into development
produced `8ed062c3` with **no file differences** from `dd43d528` and restored
mergeability. Fresh backend, frontend, typecheck and audit checks passed.

#618 merged into staging at `dfc6e26d` on September 15, 13:45:48 UTC. Image build
34977119217 succeeded. Infrastructure run 34977715451 targeted staging, completed
migrations, rolled out API and frontend, and passed its smoke checks. API readiness
was 2/2. No production deployment was made.

## Gap recorded September 15

[Issue #621](https://github.com/almyty-inc/almyty/issues/621): Anthropic Messages
inbound support is not connected to an HTTP controller. At `8ed062c3`, the
`fromAnthropicRequest` / `toAnthropicResponse` translators have only unit-test
callers. A staging `POST /v1/messages` probe returned HTTP 404 at 13:37:50 UTC.
The probe used an intentionally invalid key; it verifies route availability,
not authenticated SDK execution. The existing OpenAI-format controller is not
an Anthropic Messages endpoint. The implementing peer has since opened PR #622
with a controller and its own documentation update. The overlapping QA docs
edit was dropped; #621 remains open until live verification. Reported limits
include explicit HTTP 400 rejection of streaming and no measured input/output
token split. This is not a claim of full Claude Code compatibility.

## Post-deploy checks

On `dfc6e26d`, organization creation without a supplied slug **passed**. The new
`QA First Run 20260915` organization appeared in the list and became current.
[Creation evidence](2026-09-15-org-created.png).

Hard reload exposed a separate **failure**: the new organization still existed,
but current selection changed to Tour Demo Two. The layout initialized memberships
from the persisted, pre-creation user profile before `checkAuth` answered. This
overwrote the saved selection, which the later fresh profile then preserved.

The fix gates layout initialization on a completed, authenticated server check.
It does not weaken membership validation. The regression reproduced `old-org`
instead of `new-org` before the fix; after the fix the selection survives the
delayed profile response, while a truly revoked membership still falls back.
Twelve focused tests and TypeScript passed on the September 15 baseline.

A disposable, tool-free workflow agent was then saved in the new organization,
and its first `principal` role was created. Single-call strategy became selectable.
The no-model resolution path displayed a generic server error: this was reported
to the owner and subsequently fixed in #624. Orchestrator was enabled, but a
recorded fallback execution was not yet verified in this session.

Two login redirects were observed while the agent builder was open. A repeat save
was disabled because the default model node lacked a provider/routing policy;
the redirects are not attributed to a save request without server evidence.
After the rollout settled, agent creation succeeded without a login redirect.

## September 17 continuation

Recovered the QA change onto development `4c18e147` after the temporary worktree
was partially removed during the pause. Organization/auth regressions and the
hosted-chat suite passed **41/41** focused tests; TypeScript passed. The current
full frontend run passed **131 files / 1,014 tests**. Fix #628 merged into
development as `560c15ec`; staging promotion is #629.

The September 15 full-suite attempt was **987 passed / 1 failed** (hosted-chat
timeout), not a clean run. Upstream has since explicitly quarantined this known
contention-sensitive test group with retry; that is not a proven root-cause fix.

Staging advanced to `da918030`, including #622 and #624. The Anthropic route now
exists, but source review found that its controller drops inbound tool definitions
and tool choice, hardcodes the finish reason to `stop`, and serializes output as
text without outbound tool calls. This was reported to the implementing peer;
translator unit coverage does not establish a working client-side tool loop.
Issue #621 must not be considered fully verified on route availability alone.

Live re-probe returned **401** with the Anthropic authentication-error shape,
replacing the earlier 404. This used an intentionally invalid key, not an
authenticated tool-loop test.

### Roles and orchestrator: persistence is not execution

- The principal role, selected single-call strategy and enabled orchestrator
  survived session/browser reopening. [Settings evidence](2026-09-17-orchestrator-persisted.png).
- Role preview now names the failure, but the exact reason is **routing is not
  available on this install**, not a missing model/key. [Evidence](2026-09-17-routing-unavailable.png).
  `AgentsModule` does not import `ModelCatalogModule`, which exports the router
  required by the optional role and orchestrator dependencies. Reported to owner.
- Activated only the disposable QA agent and invoked it once through the UI.
  Run `92dee506-dcb9-4f47-8551-d57b07aa3749` failed, saying `principal` was not
  defined even though its role was visible. The node executor expects
  `options.resolvedRoles`, but the engine never resolves/passes them. This is a
  second runtime handoff defect, not a missing provider credential.
- A read-only check of that exact execution confirmed `strategyKey=single`,
  `strategyChosenBy=fallback`, and `strategyFallbackReason=no model is wired to
  decide with`. Fallback **recording passes**; successful execution does not.
- Deactivated the disposable agent after the test. No schedule or paid
  deployment was created.

The two role/routing handoff defects are tracked in
[issue #632](https://github.com/almyty-inc/almyty/issues/632).

### Current chat and free-plan gates

A fresh hosted-chat request on September 17 returned the correct unconnected-demo
description without a busy/no-response error. [Reply](2026-09-17-chat-reply.png).
For the free QA organization, Analytics → Chargeback, Settings → Audit streaming,
and Settings → Encryption each rendered the corresponding upgrade prompt.
This verifies the unentitled path only; it does not test a paid configuration,
audit delivery, or live KMS provisioning.

Promotion #629 merged into staging at `b9b995b6`; at the end of the September 17
session, its rollout and fresh create/reload check were still unverified.

## September 18 deployed verification

Staging is now `c3086d07541d436a5088b89104b34aee782d6929` (#643), which includes
the organization-selection fix from #628/#629 and the first runtime wiring
patch #631. [Image build 35250558320](https://github.com/almyty-inc/almyty/actions/runs/35250558320)
succeeded. Deployment verification explicitly targeted staging, completed migrations, rolled out API and frontend,
and passed smoke checks. This report does not certify the separate uncommitted
runtime changes described by the implementing peer on September 18.

### Organization-selection regression: PASS

Created a fresh `QA Reload Verify 20260918` organization using only its name.
It became current. Immediately navigated the browser to the same organizations
URL (a full document reload, not an SPA route transition); after authentication
and membership hydration settled, the new organization remained selected and
present in the list. No profile refresh or manual organization switch was
performed between creation and reload.
[Post-reload evidence](2026-09-18-org-selection-after-reload.png).
This completes the previously pending live check for #628/#629; the
revoked-membership fallback remains covered by the automated regression tests.

### Hosted chat: PASS for the tested turn

A new conversation answered the product/account-context question and identified
itself as an unconnected customer-support demo without account access.
No busy/no-response error occurred in this turn.
[Reply evidence](2026-09-18-chat-reply.png).
This is a functional smoke check, not a load, provider-matrix, or legal-quality test.

### Role wiring: improved failure path, successful model run still unverified

The existing disposable `QA Strategy Runtime 20260915` agent retained its
`principal` role, single-call strategy and enabled orchestrator. Preview now
reports **no models are registered for this organization**, with a suggestion
to add or pin a model, instead of **routing is not available on this install**.
[Preview evidence](2026-09-18-role-preview.png).

Activated only this test agent and invoked it once through the UI. The run at
11:30:03 Europe/Berlin on September 18 failed with **Role 'principal' could not
be filled: no models are registered for this organization**. This replaces the
September 17 false claim that the visible role was undefined and confirms the
execution path reaches role resolution. It does not prove a successful pinned
or routed model run, nor orchestration decisions with a working decider model.
The agent was deactivated again after this check; no schedule or provider
credential was added. [Invocation evidence](2026-09-18-role-invocation.png).
Issue #632 remains open for the remaining acceptance checks.

### Compatibility follow-up remains open

Issue #621 is still open. On the deployed revision, the node executor builds
messages from configured prompt templates, forwards `config.toolIds`, and does
not consume the compatibility controller's input tool definitions, tool choice,
or conversation history. Its output is reduced to message content. A controller
test with a mocked engine cannot establish the provider round trip. The peer
owns the in-flight executor/compatibility fixes; no duplicate runtime edit was
made in this QA pass. No authenticated Anthropic SDK/tool-loop success is
claimed here.
