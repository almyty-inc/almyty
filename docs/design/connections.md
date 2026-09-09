# Connections: one sign-in and key layer for every third party

Status: accepted (Frane). Gate 1 shipped; gates 2 and 3 open.

almyty talks to many outside parties: inference vendors, deployment
providers, memory backends, MCP servers, tool sources, chat channels,
clouds and model registries. Every one of them used to have its own
way of taking a key. Connections is the single layer that replaces
those: a catalog of connectors that says how to connect, a
Credential row per connection that holds the secret, and one resolver
consumers call to use it.

## Concepts

### Connector (catalog, data)

A connector describes one third party. It is data, not code: the
built-in list is a TypeScript array in
`backend/src/modules/connections/connector-catalog.ts`, org admins add
their own through `POST /connectors`, and connectors of kind
`deployment` are derived at runtime from the deployment adapter
registry (`AdapterRegistry.describe()`): the adapter's `x-secret`
config fields become the form, nothing is copied.

```
key            'openrouter'
kind           inference | deployment | memory | mcp | tool_source | channel | cloud | registry
displayName    'OpenRouter'
connect        ConnectMethod[]   ranked best-first
capabilities   ['chat', 'models', 'usage']
scopesNeeded   OAuth scopes the platform asks for
validation     how to prove a connection works (below)
revoke?        provider-side revoke called on disconnect
pricingSource? where prices come from
keyPageUrl     deep link to where the user creates a key
docsUrl        vendor docs
adapterKey?    deployment adapter this connector feeds
providerType?  LlmProviderType this connector feeds
```

Inference connectors reuse the LLM provider catalog
(`llm-provider-catalog.ts`) for names, key pages and docs and the
`LlmProvider` entity for base URLs, so a vendor is described once.

### ConnectMethod

How a user can connect. One connector can offer several; the first is
the best.

| type | what the user does | what we store |
| --- | --- | --- |
| `oauth2_pkce` | signs in at the provider; PKCE S256, verifier kept server-side | the key or token the provider returns |
| `oauth2_code` | standard authorization code with a platform client id | access + refresh token |
| `oauth2_client_credentials` | pastes tenant / client id / secret | those three, secret encrypted |
| `api_key` | pastes a key (deep link to the key page), validated live | the key and any plain fields |
| `cloud_iam` | AWS CloudFormation quick-create producing a role ARN; Azure consent; GCP workload identity | the ARN or identity |
| `service_account` | uploads a service account JSON | the JSON, encrypted |
| `installation` | Slack-style app install | the installation token |

Every method carries a JSON schema (flat object of string / number /
boolean properties) for whatever the user must supply. Properties
marked `"x-secret": true` are encrypted at rest and never returned by
the API. OAuth methods carry the authorize and token endpoints, scopes
and the PKCE flag, plus the knobs that let a non-standard provider fit
the same code path (`callbackParam`, `stateVia`, `tokenRequest`,
`tokenField`, `headlessCode`). `credentialType` names the
`CredentialType` the stored row gets (default `api_key`).

### Connection

A connection is an existing Credential row plus:

```
connectorKey     which connector made it
ownerUserId      null for an org connection, the user's id for a user connection
accountLabel     what the key resolves to at the provider (the OpenRouter key label, the HF username, bucket@endpoint, the AWS ARN)
healthStatus     valid | failed | expired | revoked | quota | unknown
healthCheckedAt  when validation last ran
healthError      the provider's answer when it is not valid
scopesGranted    OAuth scopes actually granted
```

These are columns on `credentials` (migration
`1750761000000-Connections`). There is deliberately no second table:
secrets live in exactly one place, envelope-encrypted (platform GCM or
the org's BYO KMS). The owner is the org or a user; workspaces are
never owners and become grant targets in gate 2.

### Validation

Every connector must say how to prove a connection works. Kinds:

| kind | what runs |
| --- | --- |
| `http` | one request (usually `GET <base>/models` or a `whoami`) with the secret in the declared place; 2xx is valid, 401/403/400 failed, 402/429 quota; `accountLabelPath` reads the label from the JSON |
| `format` | regex and URL checks only, for providers without a probe endpoint (Modal) |
| `aws_caller_identity` / `aws_assume_role` | STS `GetCallerIdentity` with the key pair, or `AssumeRole` with the platform identity and the org id as ExternalId, then `GetCallerIdentity`; label is the ARN |
| `gcp_service_account` | RS256 JWT bearer grant against the key's `token_uri`; label is `client_email (project)` |
| `oauth2_client_credentials` | the client credentials grant against the templated token URL; label is `clientId@tenantId` |
| `s3_bucket` | `HeadBucket` then `ListObjectsV2(MaxKeys=1)` through `@aws-sdk/client-s3` (lazily required); label is `bucket@endpoint-or-region` |
| `mcp_initialize` | JSON-RPC `initialize` against the server URL; label is `serverInfo.name` |

Every URL a probe fetches passes the SSRF guard
(`common/security/url-validator`) first; private ranges are allowed
only for connectors that name an escape-hatch env var
(`OLLAMA_ALLOW_PRIVATE_URLS`, `MCP_ALLOW_PRIVATE_URLS`).

## Rules

- Single store: secrets live only in Credential rows. API responses
  expose `accountLabel`, health, scopes, method and owner; never values.
- A connect that does not end in a validated connection is a failed
  connect. The API answers 422 `CONNECTION_VALIDATION_FAILED` with the
  provider's error and the connection (health `failed`). The row is
  kept rather than deleted so the user can retry the validation after
  fixing the key at the provider, or rotate in place, without redoing
  the whole flow, and so the audit trail shows the attempt.
- PKCE S256. The verifier never leaves the server: it is stored keyed
  by the state with a 10 minute TTL, single use. Redis when the API has
  a client bound (any replica can take the callback), an in-memory map
  otherwise; the store is injectable for specs.
- Redirect URL: `<PUBLIC_API_URL | BASE_URL | API_BASE_URL | request
  host>/connections/oauth/callback`, the same resolution the Slack
  install and hosted-chat SSO use.
- Headless: `mode: 'headless'` on a provider that prints the code
  on-screen (OpenRouter) omits the callback URL; the client then calls
  `POST /connections/connect/:connectorKey/complete { state, code }`.
- Audit: `connection_connect`, `connection_validate`,
  `connection_rotate`, `connection_disconnect`, `connection_resolve`
  and `connector_create` on resource `connection` / `connector`, with
  connector key, method, owner and outcome in the details.
- RBAC: `connections:read` (viewer and up) and `connections:manage`
  (admin and up), listed in `UserOrganization.hasPermission` so the
  RolesGuard and the service agree; an EE custom role can grant them
  through the membership `permissions` column. Org connections need
  `connections:manage`. A user manages their own user-scoped
  connections with `connections:read`.
- Org setting `settings.allowUserScopedConnections`: default on for
  free / personal orgs (`plan` missing, `free` or `personal`), off for
  paid tiers; an admin flips it through `PATCH /organizations/:id
  { settings: { allowUserScopedConnections } }` (settings are patched,
  not replaced).

## API (gate 1)

| route | who | does |
| --- | --- | --- |
| `GET /connectors?kind=` | connections:read | catalog: built-in, adapter-derived, custom; cloud_iam methods carry a rendered `quickCreateUrl` when `CONNECTIONS_AWS_CFN_TEMPLATE_URL` and `CONNECTIONS_AWS_TRUSTED_ACCOUNT_ID` are set |
| `POST /connectors` | admin, connections:manage | custom connector; validated with `validateConnectorDefinition`, may not shadow a built-in key |
| `POST /connections/connect/:connectorKey` | connections:read (+manage for owner org) | `{ method?, owner: 'org' \| 'user', mode?, input?, name? }`. Form methods validate live and return `{ pending: false, connection }`; OAuth methods return `{ pending: true, authorizeUrl, state, completeWith }` |
| `GET /connections/oauth/callback?code&state` | nobody (state is the credential) | completes the exchange; 302 to `FRONTEND_URL/connections?connection=&status=` when configured, JSON otherwise |
| `POST /connections/connect/:connectorKey/complete` | member | `{ state, code }` headless completion |
| `GET /connections` | connections:read | masked list; user connections visible to their owner and to connections:manage |
| `GET /connections/:id` | same | one connection |
| `POST /connections/:id/validate` | owner or manage | re-runs validation, updates health and label |
| `POST /connections/:id/rotate` | owner or manage | form methods: without `input` returns the form, with `input` replaces the secret in place; OAuth: returns a new `authorizeUrl` whose completion updates the same row |
| `DELETE /connections/:id` | owner or manage | calls the connector's revoke endpoint when declared, then deletes |

`/credentials` and `/oauth2` stay as primitives.

Error codes: `CONNECTOR_UNKNOWN`, `CONNECT_METHOD_UNSUPPORTED`,
`CONNECT_INPUT_INVALID`, `CONNECTIONS_PERMISSION_REQUIRED`,
`NOT_A_MEMBER`, `USER_CONNECTIONS_DISABLED`, `CONNECT_STATE_INVALID`,
`CONNECT_EXCHANGE_FAILED`, `CONNECT_DENIED`,
`CONNECT_CLIENT_NOT_CONFIGURED`, `CONNECTION_VALIDATION_FAILED`,
`CONNECTION_NOT_FOUND`, `CONNECTION_FORBIDDEN`, `CONNECTION_INACTIVE`,
`CONNECTOR_INVALID`, `CONNECTOR_KEY_TAKEN`.

## Seams

Gate 2 (grants) and gate 3 (consumer switch) build on these names:

- `ConnectionsResolverService.resolveForUse(principal, connectionId, { purpose, resourceType?, resourceId? })`
  in `backend/src/modules/connections/connections-resolver.service.ts`.
  Returns `{ connection, connector, config }` where `config` is the
  decrypted secret set. Gate 1 checks ownership (org connection: any
  member with `connections:read`; user connection: its owner) and
  writes `connection_resolve`. Gate 2 adds grant lookup at the marked
  block before the deny; the signature does not change.
- `ConnectionsResolverService.resolveForOrg(organizationId, connectionId, { purpose, actorUserId? })`
  for jobs without a user (schedulers, reconcile loops): org
  connections only, a user connection only with its owner as actor.
- `ConnectionsService.decryptConfig(row)` and `ConnectionsService.view(row, connector)`
  for anything that already holds the Credential row.
- `ConnectorCatalogService.list(organizationId, kind?)` / `require(organizationId, key)`
  for pickers: consumers filter by `kind` and read `providerType` /
  `adapterKey` to map a connection onto their own vocabulary.
- `CONNECTIONS_HTTP` and `CONNECTIONS_S3_FACTORY` injection tokens
  swap the outbound HTTP call and the S3 client in specs.
- `Credential.connectorKey` is the discriminator: a Credential row
  without it is a plain credential and is invisible to this layer.

Gate 3 targets, in order: LLM providers (`credentialId` on
`LlmProvider`), the model registry (`CredentialType.S3_COMPATIBLE`
rows, resolved per org), deployment adapters (`adapterKey`), memory
backends (`BackendCredentialsResolver`), MCP sources, channels.

## Gate 1 scope

Shipped: catalog + `ConnectMethod` schema, PKCE exports in the OAuth2
service, `connections:*` permissions, the connect / validate / rotate
/ disconnect API, custom connectors, the resolver seam, the
`s3_compatible` credential type and the `registry-s3` connector, the
migration, specs, these docs.

Not in gate 1: grants (workspace, agent, team), the consumer switch,
the dashboard page, refresh of expiring OAuth tokens, connectors for
SambaNova / Novita (their `/models` answer without a key, so a probe
proves reachability only), Slack-style `installation` connectors
(the Slack install stays on the gateway until gate 3).

## Verified connector facts (2026-09-08)

Checked with the vendor docs and an unauthenticated request to each
probe URL; "401" below means the endpoint exists and rejects a bad key,
which is what a validation needs.

| connector | connect | validation | label |
| --- | --- | --- | --- |
| OpenRouter | `https://openrouter.ai/auth?callback_url=...&code_challenge=...&code_challenge_method=S256` (no client id; omit `callback_url` for headless, the code is shown on-screen), then `POST https://openrouter.ai/api/v1/auth/keys` JSON `{ code, code_verifier, code_challenge_method }` -> `{ key }`; codes expire after 10 minutes; also api_key at `https://openrouter.ai/keys` | `GET https://openrouter.ai/api/v1/key` Bearer -> `{ data: { label, usage, limit, limit_remaining, is_free_tier } }` (401 without key; `/api/v1/auth/key` answers the same) | `data.label` |
| OpenAI | api_key, `https://platform.openai.com/api-keys` | `GET https://api.openai.com/v1/models` Bearer (401) | key suffix |
| Anthropic | api_key, `https://console.anthropic.com/settings/keys` | `GET https://api.anthropic.com/v1/models` with `x-api-key` and `anthropic-version: 2023-06-01` (401) | key suffix |
| Google Gemini | api_key, `https://aistudio.google.com/apikey` | `GET https://generativelanguage.googleapis.com/v1beta/models` with `x-goog-api-key` (401) | key suffix |
| Mistral | api_key | `GET https://api.mistral.ai/v1/models` (401) | key suffix |
| Groq | api_key | `GET https://api.groq.com/openai/v1/models` (401) | key suffix |
| Together | api_key | `GET https://api.together.xyz/v1/models` (401) | key suffix |
| xAI | api_key | `GET https://api.x.ai/v1/models` (400 on a bad key) | key suffix |
| DeepSeek | api_key | `GET https://api.deepseek.com/v1/models` (401) | key suffix |
| Cohere | api_key | `GET https://api.cohere.com/v1/models` Bearer (401) | key suffix |
| Hugging Face | api_key, `https://huggingface.co/settings/tokens` | `GET https://huggingface.co/api/whoami-v2` Bearer (401 "Invalid username or password") | `name` |
| Ollama | api_key (optional) + baseUrl | `GET {{baseUrl}}/api/tags`; note `https://ollama.com/api/tags` answers 200 without a key, so for Ollama Cloud this proves reachability, not the key; localhost needs `OLLAMA_ALLOW_PRIVATE_URLS=true` | baseUrl |
| Fireworks | api_key | `GET https://api.fireworks.ai/inference/v1/models` (401) | key suffix |
| Cerebras | api_key | `GET https://api.cerebras.ai/v1/models` (401) | key suffix |
| DeepInfra | api_key | `GET https://api.deepinfra.com/v1/openai/models` (401) | key suffix |
| Perplexity | api_key | `GET https://api.perplexity.ai/router/v1/models` (401; the legacy `api.perplexity.ai` host has no `/models`) | key suffix |
| Z.ai | api_key | `GET https://api.z.ai/api/paas/v4/models` (401) | key suffix |
| Nebius Token Factory | api_key, `https://tokenfactory.nebius.com/settings/api-keys` | `GET https://api.tokenfactory.nebius.com/v1/models` Bearer (401) | key suffix |
| OpenAI-compatible endpoint | api_key + baseUrl | `GET {{baseUrl}}/models` | baseUrl |
| Modal | api_key pair `tokenId` (`ak-`) + `tokenSecret` (`as-`), `https://modal.com/settings/tokens` | format only: Modal has no REST endpoint that answers to a token; the first deploy is the live check | workspace |
| Baseten | api_key, `https://app.baseten.co/settings/api_keys` | `GET https://api.baseten.co/v1/models` Bearer (403 on a bad key) | key suffix |
| RunPod | api_key, `https://www.console.runpod.io/user/settings` | `GET https://rest.runpod.io/v1/pods` Bearer (401); REST v1 retires 2026-11-15, revisit | key suffix |
| AWS | cloud_iam: quick-create `https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL=...&stackName=...&param_X=...` (parameters as `param_<Name>`, NoEcho ones ignored) producing a role ARN, assumed with `ExternalId` = org id; fallback access key pair | STS `AssumeRole` / `GetCallerIdentity` (`Action=...&Version=2011-06-15`, SigV4) -> `Arn`, `Account`, `UserId` | ARN |
| GCP | service_account JSON (`type: service_account`, `project_id`, `private_key`, `client_email`, `token_uri`), `https://console.cloud.google.com/iam-admin/serviceaccounts` | JWT bearer grant at `https://oauth2.googleapis.com/token` | `client_email (project)` |
| Azure | oauth2_client_credentials tenant / client / secret | `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` form `client_id, client_secret, scope=https://management.azure.com/.default, grant_type=client_credentials` -> `access_token` | `clientId@tenantId` |
| DigitalOcean | api_key, `https://cloud.digitalocean.com/account/api/tokens` | `GET https://api.digitalocean.com/v2/account` Bearer (401) | `account.email` |
| S3-compatible registry | api_key form: endpoint?, region, bucket, prefix?, accessKeyId, secretAccessKey | `HeadBucket` + `ListObjectsV2(MaxKeys=1)` | `bucket@endpoint-or-region` |
| Hugging Face Hub (registry) | api_key | whoami-v2 as above | `name` |
| Memory backend (HTTP) | api_key + baseUrl | `GET {{baseUrl}}{{healthPath}}` Bearer | baseUrl |
| MCP server | api_key (optional) + serverUrl | JSON-RPC `initialize` | `serverInfo.name` |
| OpenAPI document | api_key (optional) + specUrl | `GET {{specUrl}}` | specUrl |
| Outbound webhook | url + secret | format: https URL | url |
