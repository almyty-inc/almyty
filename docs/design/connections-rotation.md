# Connections gate 5: rotation, revocation and expiry reminders

Status: built (core mechanics and provider facts). Scheduled
auto-rotation and expiry enforcement are EE and call into this.

A connection's secret should be replaceable without a human pasting a
new key, wherever the provider offers an API for it, and should at
least be revocable on disconnect and described (name, created, last
used, expiry) for the account label and health. This document records
what each provider actually offers, verified against vendor docs on
2026-09-08, and how the code in
`backend/src/modules/connections/rotation/` uses it.

## Fact table

Columns: (a) create a new key programmatically, (b) revoke or delete a
key, (c) key metadata, (d) OAuth token refresh or revoke where the
connect method is OAuth. Values: verified, unavailable, unclear.

| connector | (a) create | (b) revoke | (c) metadata | (d) OAuth | credential that drives it | sources |
| --- | --- | --- | --- | --- | --- | --- |
| openrouter | verified: `POST /api/v1/keys` (name, limit) with a provisioning key | verified: `DELETE /api/v1/keys/{hash}` | verified: `GET /api/v1/key` with the key itself (label, limit, limit_remaining, usage, is_free_tier); `GET /api/v1/keys/{hash}` adds created_at | n/a: the PKCE flow returns a plain API key, no refresh token | `provisioningKey` (Settings, Provisioning keys) | [provisioning API](https://openrouter.ai/docs/features/provisioning-api-keys), [current key](https://openrouter.ai/docs/api-reference/limits) |
| openai | verified: `POST /v1/organization/projects/{project_id}/service_accounts` returns `api_key.value` once; there is no create for plain project keys; `POST /v1/organization/admin_api_keys` mints admin keys (not used) | verified: `DELETE /v1/organization/projects/{project_id}/api_keys/{key_id}`, `DELETE .../service_accounts/{id}` | verified: `GET .../api_keys` (name, created_at, last_used_at, redacted_value) | n/a | `adminKey` (sk-admin, organization owner) and `projectId` | [OpenAPI spec](https://raw.githubusercontent.com/openai/openai-openapi/manual_spec/openapi.yaml) paths `/organization/admin_api_keys`, `/organization/projects/{project_id}/api_keys`, `/organization/projects/{project_id}/service_accounts`; [admin keys reference](https://platform.openai.com/docs/api-reference/admin-api-keys) (rejects automated fetches) |
| anthropic | unavailable: the Admin API has list, get and update only | verified: `POST /v1/organizations/api_keys/{id}` with `status: inactive` (or `archived`) | verified: `GET /v1/organizations/api_keys` (name, created_at, expires_at, partial_key_hint, status, principal, scope) | n/a | `adminKey` (sk-ant-admin) in `x-api-key` with `anthropic-version: 2023-06-01` | [list](https://platform.claude.com/docs/en/api/admin-api/apikeys/list-api-keys), [update](https://platform.claude.com/docs/en/api/admin-api/apikeys/update-api-key), [Admin API overview](https://platform.claude.com/docs/en/manage-claude/admin-api) |
| google (Gemini) | unavailable with the Gemini key: keys are created in AI Studio; unclear through the GCP API Keys API, which would need a GCP credential the connector does not hold | unavailable | unavailable | n/a | none | [API key docs](https://ai.google.dev/gemini-api/docs/api-key) |
| mistral | verified: `POST /v1/admin/api-keys` (user_id, workspace_uuid, name, expiration) returns `key` once with `key_id`, `hidden_key` | verified: `DELETE /v1/admin/api-keys/{key_id}` | verified: `GET /v1/admin/api-keys` (`keys[]`: name, created_at, last_used, expiration_date, workspace) | n/a | `adminKey`, `workspaceId`, `userId` (beta Admin API) | [admin api-keys](https://docs.mistral.ai/api/endpoint/beta/admin/api-keys) |
| groq | unavailable | unavailable | unavailable | n/a | none | [API reference](https://console.groq.com/docs/api-reference), [index](https://console.groq.com/llms.txt) |
| together | unavailable | unavailable | unavailable | n/a | none | [docs index](https://docs.together.ai/llms.txt) |
| xai | verified: `POST /auth/teams/{teamId}/api-keys` (name, acls, qps, qpm, tpm, expireTime) returns `apiKey` once with `apiKeyId`, `redactedApiKey`; also `POST /auth/api-keys/{id}/rotate` (secret rotation with `oldSecretExpireTime`, not used yet) | verified: `DELETE /auth/api-keys/{apiKeyId}` | verified: `GET /auth/teams/{teamId}/api-keys` (name, createTime, modifyTime, expireTime, disabled); list envelope field name unclear, the provider reads a bare array or `apiKeys` | n/a | `managementKey`, `teamId` (Management API at management-api.x.ai) | [management auth](https://docs.x.ai/developers/rest-api-reference/management/auth) |
| deepseek | unavailable | unavailable | unavailable | n/a | none | [API docs](https://api-docs.deepseek.com/) |
| cohere | unavailable | unavailable | unavailable | n/a | none | [docs index](https://docs.cohere.com/llms.txt) (v1 and v2 indexes carry no key endpoints) |
| huggingface, registry-huggingface | unavailable: tokens are created in Settings only (Enterprise orgs have an OAuth token exchange, RFC 8693, not a token-management API) | verified: `POST /api/credentials/revoke` with `{"credentials": [token]}`, no auth, always 202 | verified: `GET /api/whoami-v2` (name, auth.accessToken.displayName, role, createdAt, auth.expiresAt) | n/a | the token itself | [user access tokens](https://huggingface.co/docs/hub/security-tokens), [whoami types](https://raw.githubusercontent.com/huggingface/huggingface.js/main/packages/hub/src/lib/who-am-i.ts), [Hub API](https://huggingface.co/docs/hub/api) |
| fireworks | verified: `POST /v1/accounts/{account_id}/users/{user_id}/apiKeys` (`apiKey.displayName`, `expireTime`) returns `key` once with `keyId` | verified: `POST .../apiKeys:delete` with `keyId` | verified: `GET .../apiKeys` (keyId, displayName, createTime, expireTime; no key values, so only keys almyty minted can be matched) | n/a | the key itself plus `accountId`, `userId` | [create](https://docs.fireworks.ai/api-reference/create-api-key), [list](https://docs.fireworks.ai/api-reference/list-api-keys), [delete](https://docs.fireworks.ai/api-reference/delete-api-key) |
| cerebras | unavailable | unavailable | unavailable | n/a | none | [API reference](https://inference-docs.cerebras.ai/api-reference/chat-completions) |
| deepinfra | unavailable | unavailable | unavailable | n/a | none | [docs index](https://docs.deepinfra.com/llms.txt) |
| novita | unavailable | unavailable | unavailable | n/a | none | [docs index](https://docs.novita.ai/llms.txt) |
| perplexity | verified: `POST /generate_auth_token` (token_name) with an existing key returns `auth_token` once | verified: `POST /revoke_auth_token` with `auth_token` | unavailable: no list or metadata endpoint | n/a | the key itself | [API key management](https://docs.perplexity.ai/docs/admin/api-key-management) |
| zai | unavailable | unavailable | unavailable | n/a | none | [API reference](https://docs.z.ai/api-reference/introduction) |
| baseten | verified: `POST /v1/api_keys` (name, type) returns `api_key` once | verified: `DELETE /v1/api_keys/{api_key_prefix}` | verified: `GET /v1/api_keys` (prefix, name, type, team_name); the prefix is the part before the first dot of a key (observed, not documented) | n/a | `managementKey` (type WORKSPACE_MANAGE_API_KEYS) | [API keys](https://docs.baseten.co/organization/api-keys), [create](https://docs.baseten.co/reference/management-api/api-keys/creates-an-api-key), [list](https://docs.baseten.co/reference/management-api/api-keys/lists-the-users-api-keys), [delete](https://docs.baseten.co/reference/management-api/api-keys/delete-an-api-key) |
| nebius | unavailable (Token Factory keys are console-only; Nebius Cloud IAM is a different product) | unavailable | unavailable | n/a | none | [API reference](https://docs.tokenfactory.nebius.com/api-reference/introduction) |
| sambanova | unclear: the docs site refuses automated fetches; search snippets say keys come from the cloud portal | unclear | unclear | n/a | none | [API keys and URLs](https://docs.sambanova.ai/docs/en/get-started/api-keys-urls) |
| ollama | unclear: ollama.com keys are managed on the settings page; no key API found | unclear | unavailable | n/a | none | [key page](https://ollama.com/settings/keys) |
| modal | unavailable: `modal token new` is a browser-session flow, no HTTP API | unavailable | unavailable | n/a | none | [CLI token](https://modal.com/docs/reference/cli/token) |
| runpod | unavailable: console only | unavailable | unavailable | n/a | none | [manage API keys](https://docs.runpod.io/get-started/api-keys) |
| digitalocean | unavailable: the public OpenAPI spec has no personal-access-token resource (account, apps, droplets, ... but no tokens); tokens are created in the control panel | unavailable | unavailable | n/a: the connect method is a PAT, not OAuth | none | [openapi repo](https://github.com/digitalocean/openapi/tree/main/specification/resources), [create a PAT](https://docs.digitalocean.com/reference/api/create-personal-access-token/) |
| aws | verified: IAM `CreateAccessKey` (UserName optional, inferred from the signing key; two keys per user) | verified: `DeleteAccessKey` | verified: `ListAccessKeys` (CreateDate, Status), `GetAccessKeyLastUsed` (LastUsedDate, ServiceName, Region) | n/a | the access key pair itself (needs iam:CreateAccessKey, iam:DeleteAccessKey, iam:ListAccessKeys, iam:GetAccessKeyLastUsed on itself); a cross-account role has nothing to rotate | [CreateAccessKey](https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateAccessKey.html), [DeleteAccessKey](https://docs.aws.amazon.com/IAM/latest/APIReference/API_DeleteAccessKey.html), [ListAccessKeys](https://docs.aws.amazon.com/IAM/latest/APIReference/API_ListAccessKeys.html), [GetAccessKeyLastUsed](https://docs.aws.amazon.com/IAM/latest/APIReference/API_GetAccessKeyLastUsed.html) |
| gcp | verified: `POST /v1/projects/{project}/serviceAccounts/{email}/keys` (privateKeyType TYPE_GOOGLE_CREDENTIALS_FILE) returns `privateKeyData`, the base64 key file | verified: `DELETE .../keys/{private_key_id}` | verified: `GET .../keys/{id}` (validAfterTime, validBeforeTime, disabled) | n/a | the key file itself (needs iam.serviceAccountKeys.create/delete/get on its own account) | [keys.create](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts.keys/create), [keys.delete](https://docs.cloud.google.com/iam/docs/reference/rest/v1/projects.serviceAccounts.keys/delete) |
| azure | verified: Graph `POST /applications(appId='{clientId}')/addPassword` returns `secretText` once with `keyId`, `hint`, `endDateTime` (default two years) | verified: `POST .../removePassword` with `keyId`, 204 | verified: `GET /applications(appId='...')?$select=passwordCredentials` (displayName, startDateTime, endDateTime, hint) | n/a: client credentials issue no refresh token | the app's own client credentials with Application.ReadWrite.OwnedBy (or .All) over itself | [addPassword](https://learn.microsoft.com/en-us/graph/api/application-addpassword?view=graph-rest-1.0), [removePassword](https://learn.microsoft.com/en-us/graph/api/application-removepassword?view=graph-rest-1.0) |
| registry-s3 | depends on the backing store: AWS keys rotate through the `aws` facts above; R2, MinIO and Spaces keys are unclear and stay manual | same | same | n/a | none | see aws |

Not researched beyond the catalog: memory-custom, mcp-custom,
toolsource-openapi and channel connectors are org-defined endpoints
with no vendor to ask.

## Per-connector capabilities (what the registry serves)

`RotationRegistry.describe()` is the data version of this table; the
registry spec pins it.

| connector key | create | revoke | metadata | refresh | extra config fields (`requires()`) | handle kept in config after a mint |
| --- | --- | --- | --- | --- | --- | --- |
| openrouter | yes | yes | yes | no | `provisioningKey` | `keyHash` |
| openai | yes | yes | yes | no | `adminKey`, `projectId` | `keyId`, `serviceAccountId` |
| anthropic | no | yes | yes | no | `adminKey` | `keyId` (when known) |
| huggingface, registry-huggingface | no | yes | yes | no | none | none |
| aws | yes | yes | yes | no | none (`iamUserName` optional) | none: the access key id is the handle |
| gcp | yes | yes | yes | no | none | none: `private_key_id` inside the key file |
| azure | yes | yes | yes | no | none | `secretKeyId` |
| xai | yes | yes | yes | no | `managementKey`, `teamId` | `keyId` |
| mistral | yes | yes | yes | no | `adminKey`, `workspaceId`, `userId` | `keyId` |
| fireworks | yes | yes | yes | no | `accountId`, `userId` | `keyId` (required for revoke and describe) |
| perplexity | yes | yes | no | no | none | none |
| baseten | yes | yes | yes | no | `managementKey` | `keyPrefix` |
| every other connector | no | no | no | no | | |

`refresh` is false everywhere: no built-in connector stores an OAuth
refresh token (OpenRouter's PKCE flow returns a plain key, Azure uses
client credentials).

The extra fields are optional inputs on the connector's connect method
schema (`x-secret` for the admin, provisioning and management keys;
plain for ids). A connection without them still connects and
validates; it just rotates manually. The handles are plain fields the
rotation service writes back through `persist`, so the persist seam
must keep unknown plain fields rather than drop them.

## Mechanics

Files in `backend/src/modules/connections/rotation/`:

- `rotation.interface.ts`: `ConnectorRotation` (key, `capabilities()`,
  optional `requires()`, `rotate()`, `revoke()`, `describe()`),
  `RotationError` with codes `ROTATION_UNSUPPORTED`, `ROTATION_AUTH`,
  `ROTATION_FAILED`, `assertRotationContract`.
- `rotation.registry.ts`: register / get / list / describe, as data.
- `rotation.http.ts`: `callJson`, `failOn` (401 and 403 are
  `ROTATION_AUTH`, other non-2xx `ROTATION_FAILED`, a transport error
  `ROTATION_FAILED`), redacted-hint matching, the default key label
  `almyty <first 8 of connection id> <date>`.
- `providers/*.rotation.ts`: one class per row above, each with an
  injected `RotationHttp` so specs assert exact requests.
- `rotation.service.ts`: `rotate`, `revoke`, `describe`,
  `remindersFor`.
- `rotation.module.ts`: `RotationModule` wires the built-ins with the
  default fetch client and exports `RotationService`,
  `RotationRegistry` and the `ROTATION_HTTP` token.

Error messages never carry secret values; provider bodies are cut to
160 characters. Every provider URL is a fixed vendor host; the GCP
token URL is hard-coded rather than read from the key file, and ids
that land in a path (tenant, project, team, account) are validated as
single segments.

### rotate(connection, seams)

```
1. no provider, or capabilities().create false      -> { manual: true, reason, keyPageUrl }
2. a requires() field missing on the connection      -> { manual: true, reason: 'rotation needs adminKey ...' }
3. provider.rotate(current)                          -> ROTATION_UNSUPPORTED becomes manual; AUTH / FAILED audit and throw
4. next = merge(current, minted.next)                (empty string drops a field, e.g. a stale sessionToken)
5. seams.validate(next)                              -> on failure: revoke the NEW secret (best effort), audit, throw ROTATION_FAILED
6. seams.persist(next, { label, expiresAt, rotatedAt, accountLabel })
7. provider.revoke(current, { successor: next })     -> best effort; failure is reported, not thrown
8. audit CONNECTION_ROTATE with ok, provider, label, expiresAt, previousRevoked, revokeError
```

The previous secret is revoked only after the new one is validated and
persisted, so a failure anywhere leaves the connection working on the
old secret. Providers whose revoke endpoint needs a live credential
(Perplexity, Fireworks, AWS, GCP, Azure) authenticate the revoke with
the successor.

### The seams gate 1 supplies

`RotationService` never touches the Credential repository or the vault.
`ConnectionsService` is the one writer and calls it like this:

```ts
// POST /connections/:id/rotate
const row = await this.load(organizationId, id);
this.assertCanManage(principal, row);
const connector = await this.catalog.require(organizationId, row.connectorKey);
const method = this.pickMethod(connector, row.metadata?.connectMethod);
const secrets = await this.decryptConfig(row);

const outcome = await this.rotation.rotate(
  { id: row.id, organizationId, connectorKey: row.connectorKey, name: row.name, secrets,
    keyPageUrl: method.keyPageUrl ?? connector.keyPageUrl ?? null },
  {
    userId: principal.id,
    validate: (next) => this.validation.validate(connector, next, { organizationId }),
    persist: async (next, meta) => {
      // encrypt secret fields of `next` into row.config, keep plain fields (handles included)
      row.accountLabel = meta.accountLabel ?? meta.label ?? row.accountLabel;
      row.expiresAt = meta.expiresAt;
      row.metadata = { ...(row.metadata ?? {}), rotatedAt: meta.rotatedAt.toISOString() };
      row.healthStatus = 'valid'; row.healthCheckedAt = new Date(); row.healthError = null;
      await this.credentials.save(row);
    },
  },
);
if (outcome.manual) {
  // today's path: re-run the connect method (redirect for PKCE, form for api_key), carrying outcome.reason
} else {
  return { pending: false, connection: this.view(row, connector) };
}
```

```ts
// DELETE /connections/:id
const result = await this.rotation.revoke(
  { id: row.id, organizationId, connectorKey: row.connectorKey, name: row.name, secrets: await this.decryptConfig(row) },
  { userId: principal.id },
);
// result.supported false: fall back to the catalog's `revoke` HttpProbe (validation.revoke) when the connector declares one
// then remove the row and audit CONNECTION_DISCONNECT with { revoked: result.revoked, revokeError: result.error }
```

```ts
// health / account label
const d = await this.rotation.describe({ ...connection, secrets });
// d.supported && d.description: label, createdAt, lastUsedAt, expiresAt, scopes -> accountLabel and expiresAt on the row
```

`RotationError` maps to HTTP as: `ROTATION_AUTH` 422 (the admin
credential was rejected), `ROTATION_FAILED` 502 (the provider failed),
`ROTATION_UNSUPPORTED` never leaves the service (it becomes `manual`).

Audit rows: `CONNECTION_ROTATE` (success and every failed stage, with
`stage` and `code`) and `CONNECTION_REVOKE` (provider-side revoke
outcome). `CONNECTION_DISCONNECT` stays gate 1's row for the deletion.

### remindersFor(connections, now, options)

Pure. Input rows carry `id`, `connectorKey`, `expiresAt`, `createdAt`
and `rotatedAt` (from `metadata.rotatedAt`). Output:

- `expired`: `expiresAt` at or before `now`;
- `expiring`: within `expiryWindowDays` (default 7) with `daysLeft`;
- `stale`: no expiry, and the secret (rotatedAt, else createdAt) is
  older than `maxAgeDays`; off unless the org sets it.

`maxAgeDaysFromSetting(org.settings.connections.maxSecretAgeDays)`:
`true` means the 90-day default, a positive number is explicit,
anything else is off. A dated secret is governed by its expiry, never
by age, and no connection appears in two lists.

## What stays manual

- Creating the first key anywhere: rotation only replaces a key that
  already works.
- Anthropic and Hugging Face keys (no create endpoint): the rotate
  call answers `manual` with the key page; revoke and describe still
  work.
- Gemini, Groq, Together, DeepSeek, Cohere, Cerebras, DeepInfra,
  Novita, Z.ai, Nebius, SambaNova, Ollama, Modal, RunPod,
  DigitalOcean, non-AWS S3 registries: nothing but the connect method.
- Any provider whose extra field (`adminKey`, `provisioningKey`,
  `managementKey`, ids) the org did not supply.
- AWS cross-account roles: the role is the credential; nothing expires.
- Granting the extra permissions: an OpenAI admin key must belong to an
  organization owner; a GCP service account must hold
  `iam.serviceAccountKeys.*` on itself; an Azure app must hold
  `Application.ReadWrite.OwnedBy` and own itself; an AWS user must be
  allowed the four IAM actions on its own user.

## What the EE scheduler will call

Scheduled auto-rotation and expiry enforcement live in `ee/` and use
only the public surface above:

1. `remindersFor(rows, now, { maxAgeDays: maxAgeDaysFromSetting(setting) })`
   over an org's connections (the scheduler reads the rows, the
   service stays pure).
2. For each `expiring` or `stale` row whose
   `registry.capabilitiesOf(connectorKey).create` is true and whose
   `requires()` fields are present: `rotation.rotate(connection, seams)`
   with the same seams gate 1 uses, `userId` unset (system actor) and
   `label` such as `almyty auto <date>`.
3. For the rest: a notification (email, in-app) carrying `keyPageUrl`
   and `daysLeft` or `ageDays`.
4. Enforcement: an `expired` row flips `healthStatus` to `expired` so
   the resolver refuses it; the core never disables a connection on
   its own.
