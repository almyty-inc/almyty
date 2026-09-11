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

## Chat channels

Every chat channel is a connector like any other, so a Slack, Discord or
Telegram token is connected in the connect sheet instead of pasted into
a gateway form. The connector key is `channel-<gateway type>` with
underscores dasherized (`channel-whatsapp-cloud`), the same key
`ChannelCredentialService` tags the row it manages for a gateway, so a
gateway can adopt a connection you already made.

Slack is the one channel with a sign-in flow. It is ranked first, and it
needs an almyty-side Slack app: set `CONNECTIONS_OAUTH_CHANNEL_SLACK_CLIENT_ID`
and `CONNECTIONS_OAUTH_CHANNEL_SLACK_CLIENT_SECRET` on the API. Without
them the connect returns `CONNECT_CLIENT_NOT_CONFIGURED` and you use the
second method, a bot token pasted from your own Slack app.

The form fields are spelled exactly the way the channel adapter reads
them (snake_case: `bot_token`, `twilio_account_sid`, `homeserver_url`),
so a connection resolves straight into the adapter's configuration with
no translation.

| Connector | What it needs | Where to get it | How it is validated |
|---|---|---|---|
| `channel-slack` | Install the app through Slack OAuth, or paste `bot_token` (+ `signing_secret` for inbound events) | [api.slack.com/apps](https://api.slack.com/apps) | `POST https://slack.com/api/auth.test`, bearer. Label: `team` |
| `channel-discord` | `bot_token` | [Discord developer portal](https://discord.com/developers/applications), your app, Bot | `GET https://discord.com/api/v10/users/@me`, `Authorization: Bot <token>`. Label: `username` |
| `channel-telegram` | `bot_token`, optional `webhook_secret_token` | [@BotFather](https://t.me/botfather), `/newbot` or `/token` | `GET https://api.telegram.org/bot<token>/getMe`. Label: `result.username` |
| `channel-whatsapp` | `twilio_account_sid`, `twilio_auth_token`, `phone_number` (`whatsapp:+E.164`) | [Twilio console](https://console.twilio.com/) home | `GET https://api.twilio.com/2010-04-01/Accounts/<sid>.json`, basic auth. Label: `friendly_name` |
| `channel-sms` | Same Twilio account, `phone_number` in plain E.164 | [Twilio console](https://console.twilio.com/) home | Same Twilio account fetch |
| `channel-whatsapp-cloud` | `phone_number_id`, `access_token`, optional `app_secret` and `verify_token` | [Meta app dashboard](https://developers.facebook.com/apps), WhatsApp, API Setup | `GET https://graph.facebook.com/v23.0/<phone_number_id>`, bearer. Label: `display_phone_number` |
| `channel-microsoft-teams` | `bot_id`, `bot_password`, `tenant_id` (`botframework.com` for a multi-tenant bot), optional `service_url` | Azure Bot resource, Configuration ([portal.azure.com](https://portal.azure.com/)) | Client-credentials exchange at `https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, scope `https://api.botframework.com/.default`. Label: `bot_id@tenant` |
| `channel-google-chat` | `webhook_url`, optional `verification_token` | The Chat space: Apps & integrations, Webhooks | Shape only: the URL must be a `chat.googleapis.com` space webhook and pass the SSRF guard |
| `channel-signal` | `api_url` of your signal-cli bridge, `phone_number`, optional `inbound_token` | Your own [signal-cli-rest-api](https://github.com/bbernhard/signal-cli-rest-api) | Shape only. Label: `phone_number` |
| `channel-matrix` | `homeserver_url`, `access_token`, optional `room_id` and `inbound_token` | Log the bot user in on your homeserver | `GET <homeserver>/_matrix/client/v3/account/whoami`, bearer. Label: `user_id` |
| `channel-irc` | `webhook_url` of your bridge, optional `bridge_token`, `inbound_token`, `channel`, `nick` | Your own IRC bridge | Shape only. Label: `nick` |
| `channel-email` | `resend_api_key`, `reply_from`, optional `inbound_address` and `resend_inbound_signing_secret` | [resend.com/api-keys](https://resend.com/api-keys) | `GET https://api.resend.com/api-keys`, bearer. Nothing in the answer names the account, so the label is `reply_from` |
| `channel-webhook` | `callback_url`, `secret` | Your own endpoint | Shape only. Label: `callback_url` |

### What was verified, and what was not

Endpoints and auth shapes were checked against vendor documentation and,
where the endpoint answers without a credential, against the endpoint
itself, on 2026-09-09.

| Checked | Result |
|---|---|
| Slack `auth.test` | `POST https://slack.com/api/auth.test`, token as a bearer header. It answers **HTTP 200 even for a rejected token**, with `{"ok": false, "error": "invalid_auth"}`, so the probe reads `ok` and never trusts the status alone |
| Slack OAuth v2 | authorize `https://slack.com/oauth/v2/authorize`, token `https://slack.com/api/oauth.v2.access`, form encoded, bot token in `access_token`. Scopes travel **comma separated** |
| Discord | `GET https://discord.com/api/v10/users/@me` answered 401 with no header, confirming the version and the path; the bot scheme is `Authorization: Bot <token>` |
| Telegram | `https://api.telegram.org/bot<token>/getMe`; the token is a path segment, never a header, and the `User` sits under `result` |
| Twilio | `GET https://api.twilio.com/2010-04-01/Accounts/{Sid}.json`, basic auth with the SID as the user and the auth token as the password; `friendly_name` names the account |
| WhatsApp Cloud | `GET https://graph.facebook.com/<version>/<phone number id>`, bearer, returns `display_phone_number`, `verified_name`, `quality_rating`, `id`. **v23.0** is pinned: it is available until 2027-10-08, while v21.0 expires 2027-01-21 |
| Microsoft Teams | `POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token`, `grant_type=client_credentials`, scope `https://api.botframework.com/.default`, form encoded. Multi-tenant bots use the literal tenant `botframework.com` |
| Resend | `GET https://api.resend.com/api-keys` answered 401 with no header; a valid key returns `{ object, has_more, data }`, none of which names the account |
| Matrix | `GET /_matrix/client/v3/account/whoami` in the client-server spec: bearer, returns `user_id` (plus optional `device_id`, `is_guest`); an unknown token is 401 `M_UNKNOWN_TOKEN` |
| Google Chat | The incoming webhook URL is `https://chat.googleapis.com/v1/spaces/<space>/messages?key=...&token=...` and the `token` in it is the credential |

Four channels are **not** probed against a vendor, on purpose:

- **Google Chat**: the only call the webhook URL accepts posts a message
  into the space, so probing it would spam the room. The URL is checked
  for host and shape instead, and is never used as the account label
  because it carries the secret `token` in its query string.
- **Signal** and **IRC**: the endpoint is a bridge you run, usually on a
  private network the SSRF guard refuses, and there is no vendor
  credential to ask about beyond the shared token.
- **Outbound webhook**: same reason as Google Chat, calling it would
  deliver a message.

For these the connector declares the existing `format` validation, which
checks field shapes and puts every URL through the SSRF guard without
opening a connection.

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
| Chat channel (single workspace) | `gateways.configuration.credentialId` (plus `credentialKeys`, the secret names the row holds) | a `custom` row tagged `channel-<adapter>` with the bot token, signing secret, app secret, Twilio auth token, ... the adapter reads; rotated in place on the next paste, deleted with the gateway. The read seam is `ChannelCredentialService` in the gateways module |

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
`apis.authentication.config`, the secret keys inside `gateways.configuration`)
are read-through shims: a startup routine
(`ConsumerSecretBackfillService`, switch off with `SECRET_BACKFILL=off`)
moves every value it finds into a credential row, and a row is also
moved the next time it is written. A build check
(`backend/src/__tests__/no-secrets-outside-credentials.spec.ts`) scans
the entities and fails on any new secret column; the shims sit on its
allow-list with the date they go away.

Not yet on a reference, listed on that allow-list: outbound webhook
secrets, standalone HTTP tool auth, the audit stream token and the SSO
client secret and SCIM token.

## Reaching a private host

A provider URL that points at a private, loopback or link-local address is
refused when you save it. That covers the addresses a string can be known
by: `http://10.0.0.5/v1`, `http://localhost:8000`, `http://127.0.0.1`,
`http://169.254.169.254`.

If the endpoint really is on your network, add its host to the
organization's allowlist and save again:

```http
PATCH /organizations/{id}
{ "settings": { "egressAllowlist": ["10.0.0.5", "localhost", "*.internal.acme.test"] } }
```

Hosts, not URLs. A leading `*.` matches one label or more. The allowlist is
per organization on purpose: the install-wide `OLLAMA_ALLOW_PRIVATE_URLS`
and `LLM_ALLOW_PRIVATE_URLS` flags it stands beside open every private
range to every organization on the install, which is a far larger hole
than the one anybody is trying to make. Those flags still work where they
always did.

**What this check cannot do.** A hostname is not known to be private until
it resolves, so `http://gpu-1.internal/v1` passes the save-time check. It
is refused later instead: every outbound call resolves through an agent
that re-validates the address it actually got, before a socket opens. That
also defeats the `/etc/hosts` trick — pointing a public-looking name at an
internal address and sending a matching `Host` header — because the name
is never what we judge.

Allowlisting a hostname works end to end. When you save a provider whose
host is on the allowlist, that one host is recorded on the provider, and
the connect-time check makes the same exception for that name and no
other. Every other name the process resolves is checked as strictly as
before.

The record is never taken from a request body — it is the thing that lets
a name past the resolution check, so accepting it as input would hand the
decision to whoever is asking. Remove a host from the allowlist and the
record is dropped the next time that provider is saved.
