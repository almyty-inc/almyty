# Interface Adapter Audit

Audit of the channel/interface adapters that let an almyty agent receive and
reply to messages on external platforms. CLAUDE.md refers to these as the "13
interface adapters"; in the code they live in the **gateways** module (there is
no separate `interfaces` module) at:

```
backend/src/modules/gateways/channels/
├── channel-events.controller.ts      # GET :id/events, POST :id/test-connection
├── channel-gateway.service.ts        # inbound routing, outbound dispatch, testConnection()
└── adapters/
    ├── base.adapter.ts               # abstract BaseAdapter + NormalizedMessage/AdapterResponse
    ├── slack.adapter.ts
    ├── discord.adapter.ts
    ├── telegram.adapter.ts
    ├── whatsapp.adapter.ts
    ├── email.adapter.ts
    ├── webhook.adapter.ts
    ├── google-chat.adapter.ts
    ├── microsoft-teams.adapter.ts
    ├── signal.adapter.ts
    ├── matrix.adapter.ts
    ├── irc.adapter.ts
    └── chat-widget.adapter.ts
```

**Count correction:** there are **12** concrete channel adapters, not 13.
`GatewayType` (`backend/src/entities/gateway.entity.ts`) defines exactly these 12
channel types, all 12 are registered in `ChannelGatewayService`'s adapter map,
and each has one implementation file. The "13" figure in CLAUDE.md is off by one
(it likely counts the abstract `base.adapter.ts`, which is scaffolding, not a
channel).

## What each adapter must implement

`BaseAdapter` defines four members:

- `normalizeInbound(rawPayload)` → `NormalizedMessage` (`text`, `userId`,
  `threadId?`, `attachments?`, `metadata?`) — parse a platform webhook/event.
- `formatOutbound(response)` → platform-shaped payload object.
- `sendResponse(config, formattedResponse, threadContext?)` → push the reply to
  the platform (the only method that does network I/O).
- `verifyWebhook(payload, headers, config)` → signature/token check (defaults to
  `true`).

Outbound send uses `globalThis.fetch` (Node 24 native). Every `sendResponse`
wraps its call in try/catch and only logs on failure — sends are fire-and-forget
by design (`channel-gateway.service.ts` dispatches them from a run-completion
listener).

## Per-adapter findings

Legend: **Fully-implemented** = real inbound parsing + real outbound platform
API call + (where the platform supports it) signature verification.
**Partial** = real logic but a notable gap (e.g. no inbound signature check, or
inbound relies on an external bridge). **Stub** = intentionally no outbound push.

| # | Adapter | Type value | Inbound parse | Outbound send | Verify webhook | Category | Required config (creds) |
|---|---------|-----------|---------------|---------------|----------------|----------|--------------------------|
| 1 | Slack | `slack` | Real — event-callback (`event.*`), thread_ts→ts fallback | Real — `POST chat.postMessage`, Bearer bot token, threaded | Real — HMAC-SHA256 over `v0:ts:body` w/ `signing_secret`, timing-safe | **Fully-implemented** | `bot_token`, `signing_secret` (optional) |
| 2 | Telegram | `telegram` | Real — `update.message.*`, chat/user ids | Real — `POST bot{token}/sendMessage`, `chat_id` from threadContext | None (Telegram uses secret path/token, not signed body) | **Fully-implemented** | `bot_token` |
| 3 | Discord | `discord` | Real — gateway/message object (`content`, `author.id`, `channel_id`) | Real — `POST /api/v10/channels/:id/messages`, `Bot` auth, 2000-char truncation | None | **Fully-implemented** | `bot_token` (+ gateway/interaction transport for inbound — see notes) |
| 4 | WhatsApp | `whatsapp` | Real — Twilio form fields (`Body`, `From`, `MessageSid`) | Real — `POST` Twilio Messages.json, Basic auth, form-encoded, `whatsapp:` prefix | None (Twilio signature `X-Twilio-Signature` not checked) | **Partial** | `twilio_account_sid`, `twilio_auth_token`, `phone_number` |
| 5 | Email | `email` | Real — inbound-parse fields (`text`/`html`/`body`, `from`, `subject`, `messageId`) | Real — `POST api.resend.com/emails`, Bearer, `Re:` subject | None | **Partial** (send is Resend-only; no-ops silently if `resend_api_key` absent) | `resend_api_key`, `reply_from` (optional) |
| 6 | Webhook | `webhook` | Real — flexible (`text`/`message`/`input`, else JSON-stringify) | Real — `POST callback_url`, optional HMAC `X-Webhook-Signature` | Real — HMAC-SHA256 over body w/ `secret`, timing-safe | **Fully-implemented** | `callback_url`, `secret` (optional) |
| 7 | Google Chat | `google_chat` | Real — `message.text`/`argumentText`, sender, `thread.name`, space | Real — `POST webhook_url` (incoming webhook), optional thread | Real — bearer `verification_token` compare | **Fully-implemented** | `webhook_url`, `verification_token` (optional) |
| 8 | Microsoft Teams | `microsoft_teams` | Real — Bot Framework activity (`text`, `from.id`, `conversation.id`, `serviceUrl`, tenant) | Real — client-credentials token exchange, then `POST {serviceUrl}/v3/conversations/:id/activities` | None (JWT bearer from Bot Framework not verified) | **Partial** | `bot_id`, `bot_password` (+ `service_url` fallback) |
| 9 | Signal | `signal` | Real — signal-cli envelope (`source`, `dataMessage.message`, groupInfo) | Real — `POST {api_url}/v2/send` (signal-cli REST) | None | **Partial** (needs self-hosted signal-cli REST bridge) | `api_url`, `phone_number` |
| 10 | Matrix | `matrix` | Real — client-server event (`content.body`, `sender`, `room_id`) | Real — `PUT /_matrix/client/r0/rooms/:room/send/m.room.message/:txn`, Bearer | None (Matrix uses access token, no body signature) | **Fully-implemented** | `homeserver_url`, `access_token`, `room_id` (fallback) |
| 11 | IRC | `irc` | Real — webhook-bridge shape (`text`/`message`, `nick`, `channel`) | Real — `POST webhook_url` to bridge (matterbridge/Ergo-style) | None | **Partial** (no native IRC socket; relies on an external HTTP↔IRC bridge) | `webhook_url`, `nick` (optional), `channel` (fallback) |
| 12 | Chat Widget | `chat_widget` | Real — `message`/`text`, `sessionId`→threadId | **Stub by design** — `sendResponse` is a no-op; the widget consumes replies over SSE/polling (`handleWidgetMessage` returns `runId` for the client to stream) | n/a | **Stub (intentional)** | none (in-app; no external creds) |

### Notes on the "Partial" classifications

- **WhatsApp / Microsoft Teams / Google Chat / Slack** all *accept* inbound
  webhooks, but only Slack, Webhook and Google Chat actually verify the request.
  WhatsApp (Twilio `X-Twilio-Signature`) and Teams (Bot Framework JWT) inbound
  requests are trusted without signature verification — a hardening gap, not a
  functional one.
- **Signal / IRC** are "real" in code but depend on an external self-hosted
  bridge process (signal-cli REST API; an IRC↔HTTP bridge). almyty does not run
  IRC/Signal protocol clients itself.
- **Email** inbound assumes a pre-parsed JSON payload (an inbound-email webhook
  provider); there is no MIME parser in-tree. Outbound is Resend-specific.
- **Discord** outbound uses the REST bot API. Inbound `normalizeInbound` parses a
  message object, but there is no Discord Gateway websocket client in-tree — a
  real deployment would need a gateway/interactions transport feeding these
  payloads. Classified Fully-implemented on the adapter contract (parse+send are
  real) with that transport caveat.

## Connectivity probe

`ChannelGatewayService.testConnection(gateway)` performs a **live, no-message**
auth check per type (Slack `auth.test`, Telegram `getMe`, Discord `users/@me`,
Twilio account fetch, Teams token issuance, Matrix `whoami`, Resend `domains`,
signal-cli `/v1/about`, and a `HEAD` probe for webhook/google_chat/irc). Widget
always returns ok. This is surfaced via `POST /gateways/:id/test-connection`
(admin/owner only). It was previously untested; this audit adds coverage.

## Test coverage delivered

All tests mock `globalThis.fetch` (see `adapters/__tests__/test-helpers.ts`) and
touch **no network**.

- 12 adapter specs (`adapters/__tests__/*.adapter.spec.ts`) — 79 tests. Each
  verifies (a) inbound sample payload → normalized `{text,userId,threadId,...}`
  and (b) outbound normalized message → correct platform endpoint + payload +
  auth header, plus signature verification where implemented. The chat-widget
  spec asserts the intentional no-op send.
- 1 service spec (`channels/__tests__/channel-gateway.service.spec.ts`) — 19
  tests. Covers adapter-registry completeness (all 12 types resolve; unknown
  throws) and `testConnection` per type: correct endpoint + auth header, response
  mapping, missing-cred short-circuits, and thrown-fetch handling.

**Total: 98 mocked tests, all green. `tsc --noEmit` clean.**

## Adapters that genuinely need live creds for end-to-end validation

Every network-touching adapter needs real credentials + a reachable platform to
validate an actual round-trip (mocked tests cannot prove the remote accepts our
payload). What each would require:

| Adapter | Live creds / infra needed for e2e |
|---------|-----------------------------------|
| Slack | Bot token (`xoxb-…`) + signing secret, app installed in a workspace/channel |
| Telegram | BotFather bot token + a chat that has messaged the bot |
| Discord | Bot token + a guild the bot has joined + a Gateway/interactions transport |
| WhatsApp | Twilio account SID + auth token + a WhatsApp-enabled sender number |
| Email | Resend API key + a verified sending domain + an inbound-email webhook source |
| Webhook | A reachable `callback_url` receiver (+ shared `secret`) |
| Google Chat | Space incoming-webhook URL (+ verification token) |
| Microsoft Teams | Azure bot registration: `bot_id` + `bot_password`, app in Teams |
| Signal | A running signal-cli REST instance + a registered phone number |
| Matrix | Homeserver URL + a bot user access token + a joined room |
| IRC | A running IRC↔HTTP bridge (matterbridge/Ergo) reachable at `webhook_url` |
| Chat Widget | None — in-app SSE/polling; no external creds |

None of these live round-trips were exercised (no real tokens available); they
are the remaining manual/e2e gap. The mocked suite fully covers payload shape,
endpoint, auth-header construction, inbound parsing, and signature verification.
