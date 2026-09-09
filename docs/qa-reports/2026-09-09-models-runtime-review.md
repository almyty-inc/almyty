# Models runtime review — 2026-09-09

## Scope and status

Initial high-risk runtime review of [PR #586](https://github.com/almyty-inc/almyty/pull/586), pinned to `1cc4f343d11bab8ff9ec39433c2a171c14022ce9`. This is **not** a completed review of the entire PR. Models changes were excluded from our staging promotion #589; the implementing team subsequently fixed and merged #586 and promoted it separately, followed by the #592 boot correction in promotion #593.

Initial independent focused run: 4 suites / 27 tests passed, covering lifecycle hardening, real deployment credential grants, and router selection/resolution. Those tests did not cover the request/persistence boundaries below. Findings were sent to the implementing peer in `#almyty`; the follow-up verification is recorded at the end.

## Findings at the original reviewed commit

1. **Governance hook bypass.** `CredentialRefResolver` invokes `GrantsUsePolicy`, but that policy does not invoke `CONNECTIONS_GOVERNANCE_HOOK.beforeUse`, unlike `ConnectionsResolverService.resolveForUse`. Consumers using the credential resolver can miss a configured governance denial. Add a test with a real denying governance hook across credential-backed consumers.

2. **Missing principal on nonstream route planning.** `LlmChatHelper.chat` calls `headProviderForRoute(organizationId, request)` without the caller, while subsequent routing uses `session.userId`. A personal connection can be rejected during the first plan despite an authorized caller. Pass and test the principal consistently.

3. **Unresolvable credentials do not close the endpoint route.** `ModelRouterService.providerFor` can receive null from `tryResolve`, then construct an active custom provider without authentication. A configured credential reference that is inactive, expired, missing, or denied must reject that candidate, not send the request without its key.

4. **Endpoint URL does not match the dispatch contract.** The router places an endpoint base URL into `configuration.apiUrl`; `callCustomProvider` POSTs that URL verbatim. Ollama deployment produces a `/v1` base and Hugging Face produces an endpoint root, not the expected chat-completion path. Registered endpoint documentation likewise describes a base URL. Define protocol/path handling explicitly and test the actual dispatch URL, bearer header, and request body.

5. **Register endpoint bypasses credential-store persistence.** `ModelCatalogService.registerEndpoint` directly creates and encrypts a provider containing the key, instead of using the provider credential-store helper. Reuse the canonical helper and test that new keys have a credential reference, no inline secret, and working rotation.

6. **A transient teardown failure loses delete intent.** `ModelDeploymentsProcessor.recordError` changes `tearing_down` to `degraded`/`failed`; the next reconcile only takes the teardown branch for `tearing_down`. A failed delete can therefore reconcile back to ready. Preserve desired teardown across retries; test one failed teardown followed by a successful retry without reactivating the model card.

7. **Transient provider identity reaches database foreign keys and statistics.** Endpoint-only cards produce provider id `endpoint:<card UUID>`, not a stored provider row. Both nonstream and streaming chat persist that id into `Conversation.providerId`, whose relation targets `llm_providers`, and later use it in provider-stat updates. Keep transient identities out of stored-provider foreign keys/statistics and test real conversation persistence for an endpoint-only routed model.

## Already checked improvements

The reviewed commit includes real owner/grantee/no-principal credential-grant coverage; lifecycle tests cover temporary read failures, terminal jobs after teardown, missing-resource grace, and clearing inactive endpoint cards. The focused suites passed locally. They do not resolve or invalidate the open findings above.

No paid model endpoint was provisioned or torn down during this review. No models-layer code was merged or deployed as part of the initial chat QA promotion #589.

## Resolution follow-up at deployed staging `4f937e17`

Source review confirmed the fixes reported in peer commit `083a2820`: credential resolution calls the governance hook; nonstream planning receives the caller; the router rejects an unresolvable referenced credential; endpoint providers are real stored OpenAI-compatible rows; registration uses `EndpointProviderHelper` and `LlmProviderSecretsHelper.applyKey`; and teardown intent survives retries in desired state. The dispatch regression exercises `callWithRetries` and asserts the actual POST URL, bearer header, and body.

Independent regression run on staging commit `4f937e178b01db28139da7d3be0e687c8428ad32`: **6 suites / 45 tests passed**. Suites: endpoint dispatch, credential-ref resolver, deployment lifecycle hardening, deployment credential grants, router service, and pure router selection. This includes the transient teardown failure/retry and missing referenced-credential rejection. A fresh fetch at approximately 16:36 UTC still resolved `origin/staging` to this commit.

This is a bounded verification, not certification of every provider. Live paid-provider conformance, a database-backed routed-chat persistence test, and a consumer-to-EE-governance denial integration test were not run in this pass. The implementing team also flagged Bedrock dispatch and Perplexity endpoint/default support for separate follow-up; those reports were not independently reproduced here.
