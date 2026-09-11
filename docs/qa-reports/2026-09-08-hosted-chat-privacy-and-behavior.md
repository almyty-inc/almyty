# Hosted chat privacy and behavior QA — 2026-09-08–09

## Release and environment

- Privacy UI: [PR #584](https://github.com/almyty-inc/almyty/pull/584), merged to development.
- Staging promotion: [PR #585](https://github.com/almyty-inc/almyty/pull/585), merge `79cf3985462961b00b3aeb48d4561609c8cbf67f`.
- [Image build](https://github.com/almyty-inc/almyty/actions/runs/34200683518) and [infra deployment](https://github.com/almyty-inc/infra/actions/runs/34200967341) passed, including migrations, rollout, and post-deploy smoke checks.
- Browser: VibeSurfer MCP. Dashboard: `https://app.staging.almyty.com`; public chat: `https://customer-care-console.staging.almyty.app`.
- Public docs examples and screenshot manifest base remain production: `https://app.almyty.com`.

## Live privacy checks

| Check | Result |
|---|---|
| Receive a real model reply after rollout | Passed: `DELETE-QA OK`, `FRESH-ID OK`, and `DOCS-QA OK` |
| Download visitor data | Passed: valid JSON with app, visitor, exportedAt, and all three existing QA conversations |
| Delete one disposable conversation | Passed: selected conversation removed; three earlier QA conversations preserved |
| Delete all data belonging to the QA visitor | Passed: reload, new visitor id, and export with zero conversations |
| Chat after full deletion | Passed: new visitor received `FRESH-ID OK` |
| Mobile layout at 390×844 | Passed: composer, response, and all three privacy menu actions visible and usable |
| Owner privacy settings card | Passed under Ava / Northwind AI: retention inherits organization; export and deletion on; shared memory off |
| Invalid retention input | Passed: 0 shows “Enter a whole number of at least 1 day”; restored blank without saving |
| Docs | Production build passed: 97 static pages, 95 searchable pages |

The deletion checks permanently removed the disposable QA visitor's records. Export evidence was saved before deletion. A new VibeSurfer session reused the origin cookie, so session creation was not treated as proof of visitor isolation. The existing Northwind app's settings were inspected, not published.

Automated frontend verification for the privacy implementation passed (89 files / 669 tests before the final create-dialog regression addition; the focused create-dialog suite then passed 10 tests). Frontend production build and promotion CI passed. Local lint was blocked by the repository's TypeScript 7 / typescript-eslint compatibility issue before file analysis.

## Test-user report: vague scope and contract refusal

The user's three-turn sequence was reproduced on the public chat:

1. “hi there, what can you do?” → generic customer-support introduction.
2. “queries to what topic or product_” → asks the visitor to identify a product without explaining the demo's scope.
3. “can you review my contract and let me know what you think of it?” → refuses contract review.

The active public URL resolves to:

- Organization: Almyty Apps QA UI 20260831 (`77d80c93-60ce-481a-b5b6-0f0a173c70b9`).
- Gateway: `c480d90d-8534-436e-86a0-951afdd615c0`.
- Agent: Customer Support Copilot (`d21eccd4-9275-4890-b08b-675a06498018`).
- Model: GPT-4o; no attached product tools, no organization defaults, no agent constraints.

Its original instruction was:

> Resolve customer support questions clearly and concisely. Ask one clarifying question when needed. Use the supplied context only; never invent account details. End with a short next-step summary.

There was no product identity or documented policy for informational document review. The refusal was model behavior under an underspecified support role; no explicit legal prohibition was present in this active agent.

A same-named **inactive** Northwind app points to Customer Support Orchestrator. An initial diagnosis mistakenly selected that agent and edited its legal-escalation sentence. The exact original instruction was restored through the dashboard and verified in the database before changing the active QA agent.

## Applied staging configuration fix

Only the active QA agent's instructions changed. A guarded transaction checked the unique active slug, organization, agent id, and exact prior instructions; it recorded before/after instructions in `audit_logs`. No platform-wide policy or provider changed.

The instructions now identify the surface as a demo with no company-specific product/account system connected. They permit plain-language summaries of supplied contracts and questions for counsel, while excluding claims to be a lawyer, enforceability judgments, and signing decisions. Missing text should lead to a request to paste the relevant clauses.

Live regression results:

- Contract review request: now offers a plain-language review and asks for the text, with a non-legal-advice qualification.
- Fictional renewal clause: correctly explains 12-month renewal, cancellation at least 60 days before renewal, and a fee increase of up to 15%; offers questions to ask.
- “Which specific product or company do you support?”: explicitly says the demo is not connected to a particular company's product or account system.
- Final three-turn retest completed on September 9 in a fresh conversation: greeting identifies an unconnected demo; product question explains its scope; contract request asks for the text and offers a plain-language review. The screenshot below records this sequence.
- Additional live check on September 9 at approximately 11:42 UTC: supplied fictional renewal, 60-day cancellation, and 15% price-increase terms in that conversation. The assistant returned an explanation and four questions for counsel; it did not reproduce the blanket refusal or busy/no-response state.
- Fresh post-deploy conversation at approximately 16:37 UTC, after staging rollout #593: the assistant again identified itself as an unconnected customer-support demo and offered to explain a pasted fictional contract clause. No busy/no-response error appeared.

This configuration change does not add product knowledge or document-upload support. A real product deployment still needs its own product context and tools. Start a new chat when retesting so earlier refusals do not shape the conversation.

## Screenshots

- [Owner privacy settings](../../docs-site/public/screenshots/apps-settings.png)
- [Hosted privacy menu](../../docs-site/public/screenshots/apps-hosted-chat-privacy.png)
- [Contract review after the fix](chat-contract-review-after.png)
- [Fictional clause explanation and questions for counsel](chat-fictional-clause-review-after.png)
- [Fresh post-deploy scope and contract-review response](chat-post-deploy-after.png)

The docs now distinguish shared-memory opt-in from its off-by-default behavior and describe the new visitor identity after full deletion.
