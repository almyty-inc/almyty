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

## Confirmed remaining gap

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
hosted-chat suite passed **41/41** focused tests; TypeScript passed.

The September 15 full-suite attempt was **987 passed / 1 failed** (hosted-chat
timeout), not a clean run. Upstream has since explicitly quarantined this known
contention-sensitive test group with retry; that is not a proven root-cause fix.

Staging advanced to `da918030`, including #622 and #624. The Anthropic route now
exists, but source review found that its controller drops inbound tool definitions
and tool choice, hardcodes the finish reason to `stop`, and serializes output as
text without outbound tool calls. This was reported to the implementing peer;
translator unit coverage does not establish a working client-side tool loop.
Issue #621 must not be considered fully verified on route availability alone.
