# Connections

Connections is where almyty keeps every key, token and account it uses
on your behalf: inference vendors, deployment providers, memory
backends, MCP servers, chat channels, clouds and model registries. You
connect once; agents, models, deployments and the registry use the
connection.

## Connect

Open the catalog (`GET /connectors`) and pick a connector. Each one
offers one or more ways to connect, best first:

- Sign in at the provider (OpenRouter today): you are sent to the
  provider, approve, and come back connected. Nothing to paste. From a
  terminal or a machine without a browser, start with `mode:
  'headless'`; the provider shows a code and you paste it into
  `POST /connections/connect/openrouter/complete`.
- Paste an API key: the form links straight to the page where the key
  is created. The key is checked against the provider before it is
  saved.
- Cloud identity: AWS through a CloudFormation quick-create link that
  makes a role in your account (no long-lived keys), or an access key
  pair; Google Cloud through a service account JSON; Azure through an
  app registration.
- Bucket: an S3-compatible registry takes endpoint, region, bucket and
  access keys and is checked with a HeadBucket.

A connect ends in one of two states. Connected: the provider accepted
the credential and told us what it is (the OpenRouter key label, your
Hugging Face username, the bucket, the AWS role). Failed: the provider
said no; the answer is shown, the connection is kept with a failed
status so you can fix the key at the provider and hit Validate, or
rotate it, without starting over.

## Org or personal

A connection belongs to the organization or to you.

- Organization connections are what agents and deployments use. Making
  one needs the `connections:manage` permission (admins and owners).
- Personal connections are your own keys. Every member can keep them
  when the organization allows it. Free and personal organizations
  allow them by default; paid organizations start with them off, and an
  admin turns them on with `PATCH /organizations/:id { settings: {
  allowUserScopedConnections: true } }`.

Everyone with `connections:read` (every role) sees the organization's
connections; a personal connection is visible to its owner and to
admins.

## What you see

The list and detail views show the connector, the account label, the
health (valid, failed, expired, revoked, quota or unknown), when it was
last checked, the scopes granted and the owner. The secret itself is
never returned, not even masked.

## Validate

`POST /connections/:id/validate` runs the connector's check again:
`GET /models` for most inference vendors, a whoami for Hugging Face and
DigitalOcean, STS for AWS, a HeadBucket for a registry. Health and the
account label are refreshed.

## Rotate

`POST /connections/:id/rotate` replaces the secret in place, so
everything that points at the connection keeps working. For a pasted
key the call returns the form; send it back with the new value. For a
sign-in connector it returns a new authorize URL; completing it swaps
the key on the same connection.

## Disconnect

`DELETE /connections/:id` removes the connection. When the connector
declares a revoke endpoint the key is revoked at the provider first;
otherwise revoke it in the provider's console as well.

## Custom connectors

Admins can add connectors the catalog does not have: any
OpenAI-compatible endpoint, any MCP server, any memory service, any
bucket. `POST /connectors` takes the same shape as a built-in entry: a
key, a kind, the form fields (secret ones marked `x-secret`) and how to
validate.

## Where secrets live

Secrets are stored in one place, the organization's credential store,
encrypted with the platform key or, for organizations that bring their
own KMS, with their key. They leave the backend only inside the request
to the provider they belong to. Every connect, validate, rotate,
disconnect and use is written to the audit log.

### What points at the store

Every module that needs a key holds a reference to a credential row and
nothing else. The reference is resolved on each use through one seam,
`CredentialRefResolver` (`backend/src/modules/credentials/credential-ref.resolver.ts`):
it checks the row belongs to the organization and is active, asks the
use policy, warms the organization's KMS envelope and returns the
decrypted config. Nothing is cached, so a rotation is visible on the
next call.

| Consumer | Reference | What a pasted secret becomes |
|---|---|---|
| LLM provider | `llm_providers.credentialId` (inference key), `llm_providers.usageCredentialId` (usage/admin key, a different scope at the vendor) | an `api_key` row tagged with the vendor as its connector, owned by the provider: rotated in place on the next paste, deleted with the provider |
| MCP server | `mcp_sources.credentialId` | a `bearer_token` row (token) or a `custom` row (header map, every value encrypted) |
| Chat channel installation | `channel_installations.credentialId` | a `custom` row with the workspace's bot token, released when the installation is revoked |
| API | `credentials.apiId` (the row is bound to the API; tool execution already prefers it) | a row of the matching type; the API keeps the public part of its auth config plus `credentialId` |
| Deployment | `providerConfig.credentialId` | the connection made in the form first. A request that names a `credentialId` and also pastes an `x-secret` value is refused (`PROVIDER_CONFIG_INLINE_SECRET`) |
| Memory backend | `memory_workspace_config.overrides.routing.credentials` | a `memory_backend` row |

Instead of pasting, every form can name an existing connection
(`credentialId`); null clears it, and a vendor that needs a key refuses
to be left without one. The API shows which connection backs a
provider (`credentialRef`: id, name, connector, health), never its
config. A provider's health check writes its result to the connection's
health as well.

Rows created for a consumer are marked `metadata.managedBy` and are the
only rows that consumer rotates or deletes; a shared connection is left
alone.

The old columns (`llm_providers.configuration.apiKey` and
`usageApiKey`, `mcp_sources.authConfig`, `channel_installations.credentials`,
`apis.authentication.config`) are read-through shims: a startup routine
(`ConsumerSecretBackfillService`, switch off with `SECRET_BACKFILL=off`)
moves every value it finds into a credential row, and a row is also
moved the next time it is written. A build check
(`backend/src/__tests__/no-secrets-outside-credentials.spec.ts`) scans
the entities and fails on any new secret column; the shims sit on its
allow-list with the date they go away.

Not yet on a reference, listed on that allow-list: the gateway's own
channel configuration (bot tokens of single-workspace channels) and
outbound webhook secrets, standalone HTTP tool auth, the audit stream
token and the SSO client secret and SCIM token.
