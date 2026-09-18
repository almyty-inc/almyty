# Interface Adapter Audit

Audit of the channel/interface adapters that let an almyty agent receive and
reply to messages on external platforms. They live in the **gateways** module
(there is no separate `interfaces` module) at:

```
backend/src/modules/gateways/channels/
├── channel-events.controller.ts      # GET :id/events, POST :id/test-connection
├── channel-widget.controller.ts      # public widget surface: POST/GET :id/widget/messages
├── channel-gateway.service.ts        # inbound routing, outbound dispatch, AI disclosure, testConnection()
└── adapters/
    ├── base.adapter.ts               # abstract BaseAdapter + NormalizedMessage/AdapterResponse
    ├── mime.helper.ts                # dependency-free MIME parser for the email adapter
    ├── twilio-signature.helper.ts    # X-Twilio-Signature check, shared by whatsapp + sms
    ├── svix-signature.helper.ts      # svix signature check, used by the email adapter
    ├── slack.adapter.ts
    ├── discord.adapter.ts
    ├── telegram.adapter.ts
    ├── whatsapp.adapter.ts
    ├── whatsapp-cloud.adapter.ts
    ├── sms.adapter.ts
    ├── email.adapter.ts
    ├── webhook.adapter.ts
    ├── google-chat.adapter.ts
    ├── microsoft-teams.adapter.ts
    ├── signal.adapter.ts
    ├── matrix.adapter.ts
    ├── irc.adapter.ts
    └── chat-widget.adapter.ts
```

**The count is 14.** There are 14 concrete channel adapters, one implementation
file each, and every one is registered in `ChannelGatewayService`'s adapter map.
`base.adapter.ts` is scaffolding rather than a channel and is not counted; the
two `*-signature.helper.ts` files and `mime.helper.ts` are shared helpers, not
adapters either.

The adapter map has 15 entries for those 14 classes: `ChatWidgetAdapter` is
registered under both `CHAT_WIDGET` and `HOSTED_CHAT`, because a hosted chat app
persists replies exactly as the widget does and only the front end and the URL
differ. So `GatewayType` defines 15 channel types served by 14 adapters.

## What each adapter must implement

`BaseAdapter` declares a `type` string plus four methods:

- `normalizeInbound(rawPayload)` → `NormalizedMessage` (`text`, `userId`,
  `threadId?`, `attachments?`, `metadata?`) — parse a platform webhook/event.
- `formatOutbound(response)` → platform-shaped payload object.
- `sendResponse(config, formattedResponse, threadContext?)` → push the reply to
  the platform (the only method that does network I/O). The dispatch in
  `ChannelGatewayService` passes a rich `threadContext` (threadId, channel,
  userId, from, subject, normalized metadata, gatewayId, organizationId,
  runId) so adapters can route replies without re-parsing the inbound payload.
- `verifyWebhook(payload, headers, config, rawBody?)` → signature/token check.
  The base implementation fails closed: an adapter that does not override it
  refuses every inbound request. `rawBody` is the undecoded request body, which
  the signature schemes that HMAC the exact bytes need — svix for email,
  `X-Hub-Signature-256` for WhatsApp Cloud.

Outbound send uses `globalThis.fetch` (Node 24 native). `sendResponse` resolves
only when the platform accepted the message and throws `ChannelSendError`
otherwise, carrying the platform's own error string. Checking the HTTP status is
not sufficient for half these platforms — Slack, Telegram and the Graph API
answer 200 and put the refusal in the body — so each adapter checks its
platform's own success signal: `json.ok` for Slack and Telegram, the status plus
`{code, message}` for Discord and Twilio, the status plus an `error` object for
the Graph API, Google Chat and the Bot Framework, `errcode` for Matrix, the
status for Resend and for the three operator-hosted endpoints (signal-cli
bridge, IRC bridge, generic callback). `channel-gateway.service.ts` dispatches
the send from a run-completion listener and files the outcome on both the
outbound row and the delivery's inbound row, so an unanswered message can be
traced to the platform's reason and to the run it belonged to.

## Per-adapter status

All 14 adapters are **fully implemented at the code level**: real inbound
parsing + real outbound platform call (or persistence, for the widget) +
signature/token verification wherever the platform or bridge contract supports
one. What remains open per adapter is live end-to-end validation, which needs
real credentials/infrastructure — tracked in **#242** ("live e2e cred-gated").

| # | Adapter | Type value | Inbound parse | Outbound send | Verify webhook | Status | Live e2e | Required config (creds) |
|---|---------|-----------|---------------|---------------|----------------|--------|----------|--------------------------|
| 1 | Slack | `slack` | Real — event-callback (`event.*`), thread_ts→ts fallback | Real — `POST chat.postMessage`, Bearer bot token, threaded | HMAC-SHA256 over `v0:ts:body` w/ `signing_secret`, timing-safe | **Fully-implemented** | cred-gated (#242) | `bot_token`, `signing_secret` (optional) |
| 2 | Telegram | `telegram` | Real — `update.message.*`, chat/user ids | Real — `POST bot{token}/sendMessage`, `chat_id` from threadContext | None (Telegram uses secret path/token, not signed body) | **Fully-implemented** | cred-gated (#242) | `bot_token` |
| 3 | Discord | `discord` | Real — gateway/message object (`content`, `author.id`, `channel_id`) | Real — `POST /api/v10/channels/:id/messages`, `Bot` auth, 2000-char truncation | None | **Fully-implemented** | cred-gated (#242) | `bot_token` (+ gateway/interaction transport for inbound — see notes) |
| 4 | WhatsApp | `whatsapp` | Real — Twilio form fields (`Body`, `From`, `MessageSid`) | Real — `POST` Twilio Messages.json, Basic auth, form-encoded, `whatsapp:` prefix, threadId reply-routing | `X-Twilio-Signature` HMAC-SHA1 over url+sorted params, timing-safe (needs `webhook_url`) | **Fully-implemented** | cred-gated (#242) | `twilio_account_sid`, `twilio_auth_token`, `phone_number`, `webhook_url` (for signature check) |
| 5 | Email | `email` | Real — raw MIME (in-tree parser: multipart, base64/QP, RFC 2047 headers, HTML→text) **and** pre-parsed webhook JSON | Real — `POST api.resend.com/emails`, Bearer, `Re:` subject, threading via `In-Reply-To`/`References`, warns when unconfigured | svix signature over the raw body w/ `resend_inbound_signing_secret`, **fail-closed**: no secret configured means inbound is rejected | **Fully-implemented** | cred-gated (#242) | `resend_api_key`, `resend_inbound_signing_secret` (required for inbound), `reply_from` (optional) |
| 6 | Webhook | `webhook` | Real — flexible (`text`/`message`/`input`, else JSON-stringify) | Real — `POST callback_url`, optional HMAC `X-Webhook-Signature` | HMAC-SHA256 over body w/ `secret`, timing-safe | **Fully-implemented** | cred-gated (#242) | `callback_url`, `secret` (optional) |
| 7 | Google Chat | `google_chat` | Real — `message.text`/`argumentText`, sender, `thread.name`, space | Real — `POST webhook_url` (incoming webhook), optional thread | Bearer `verification_token` compare | **Fully-implemented** | cred-gated (#242) | `webhook_url`, `verification_token` (optional) |
| 8 | Microsoft Teams | `microsoft_teams` | Real — Bot Framework activity (`text`, `from.id`, `conversation.id`, `serviceUrl`, tenant) | Real — client-credentials token exchange, then `POST {serviceUrl}/v3/conversations/:id/activities` | Bot Framework RS256 JWT: issuer + audience(bot_id) + exp/nbf + signature against cached OpenID-metadata JWKS | **Fully-implemented** | cred-gated (#242) | `bot_id`, `bot_password` (+ `service_url` fallback) |
| 9 | Signal | `signal` | Real — signal-cli envelope incl. `syncMessage.sentMessage`, attachments, source fallbacks | Real — `POST {api_url}/v2/send` (signal-cli REST), `group.`-prefixed group routing, HTTP-error logging | None (bridge is self-hosted; network-level trust) | **Fully-implemented** | cred-gated + self-hosted bridge (#242) | `api_url`, `phone_number` |
| 10 | Matrix | `matrix` | Real — client-server event (`content.body`, `sender`, `room_id`) | Real — `PUT /_matrix/client/r0/rooms/:room/send/m.room.message/:txn`, Bearer | None (Matrix uses access token, no body signature) | **Fully-implemented** | cred-gated (#242) | `homeserver_url`, `access_token`, `room_id` (fallback) |
| 11 | IRC | `irc` | Real — documented bridge contract (`text`/`message`, `nick`, `channel`) | Real — `POST webhook_url` per documented contract, optional `Bearer bridge_token`, HTTP-error logging | Shared `inbound_token` (Bearer or `X-Bridge-Token`), timing-safe | **Fully-implemented** | bridge-gated (#242) | `webhook_url`, `nick` (optional), `channel` (fallback), `bridge_token`/`inbound_token` (optional) |
| 12 | WhatsApp Cloud | `whatsapp_cloud` | Real — `entry[].changes[].value.messages[]`, `text.body`, sender E.164 as thread key, contact profile name | Real — `POST graph.facebook.com/v20.0/{phone_number_id}/messages`, Bearer `access_token`, `{ messaging_product: "whatsapp", to, text }` | `X-Hub-Signature-256` HMAC-SHA256 over the raw body w/ `app_secret`, timing-safe, **fail-closed** when `app_secret` is unset. The `hub.challenge` GET handshake is answered by `handleVerification()` via the unified delegation layer | **Fully-implemented** | cred-gated (#242) | `access_token`, `phone_number_id`, `verify_token`, `app_secret` |
| 13 | SMS | `sms` | Real — Twilio form fields (`Body`, `From`, `To`, `MessageSid`), bare E.164 as thread key | Real — `POST` Twilio Messages.json, Basic auth, form-encoded, replies truncated at 1600 chars (Twilio's concatenated-body limit) with a warning | `X-Twilio-Signature` via the shared `twilio-signature.helper.ts` (same algorithm and skip semantics as WhatsApp) | **Fully-implemented** | cred-gated (#242) | `twilio_account_sid`, `twilio_auth_token`, `phone_number`, `webhook_url` (for signature check) |
| 14 | Chat Widget | `chat_widget`, `hosted_chat` | Real — `message`/`text`, `sessionId`→threadId, public `POST /gateways/:id/widget/messages` | Real — replies persisted as `channel_events` rows (`payload.kind='widget_message'`), fetched via public `GET /gateways/:id/widget/messages?threadId=` (polling) or run SSE | n/a (active-gateway check + unguessable thread UUIDs + per-gateway rate limit) | **Fully-implemented** | none needed | none (in-app; no external creds) |

### Notes

- **WhatsApp (Twilio) / SMS** signature verification requires `webhook_url` (the
  exact public URL configured in the Twilio console) because Twilio signs the
  full URL; without it the check is skipped, mirroring Slack's optional
  `signing_secret`. Both adapters share `twilio-signature.helper.ts`, so the
  algorithm and the skip semantics are identical. The two differ only in
  addressing: WhatsApp prefixes `From`/`To` with `whatsapp:`, SMS uses bare
  E.164, and SMS truncates outbound bodies at Twilio's 1600-char limit.
- **WhatsApp Cloud vs WhatsApp** are two separate channels to the same
  platform, not one with a fallback. `whatsapp` goes through Twilio;
  `whatsapp_cloud` talks to Meta's Graph API directly, with its own credential
  shape and its own signature scheme. Meta's verification is two mechanisms: a
  one-time `hub.challenge` GET handshake (answered by the static
  `handleVerification()`, routed from `unified-gateway-delegation.helper.ts`)
  and an `X-Hub-Signature-256` HMAC on every inbound POST. Unlike the Twilio
  adapters, this one fails closed — a missing `app_secret` is treated as a
  misconfiguration rather than a reason to trust the payload.
- **Microsoft Teams** JWT verification fetches the Bot Framework OpenID
  metadata + JWKS once and caches keys for 24h (refresh floor 60s on unknown
  kids). RS256 only; `alg=none` and foreign-issuer tokens are rejected.
- **Email** inbound accepts either raw MIME (string payload, or a
  `raw`/`mime`/`email` field) or pre-parsed JSON. The MIME parser is in-tree
  (`adapters/mime.helper.ts`) and dependency-free — `mailparser` was
  deliberately not added because the adapter contract is synchronous and only
  headers + a text body are needed. Attachment **metadata** (filename, content
  type, decoded byte size, content-id, disposition) is surfaced on the
  normalized message (`attachments`) and in `metadata.attachments`; the bytes
  are not retained. Outbound remains Resend-specific. Inbound is svix-verified
  and fails closed without a secret; the dedicated
  `channel-email-inbound.controller.ts` path reads
  `RESEND_INBOUND_SIGNING_SECRET` from the environment instead.
- **Signal / IRC** are code-complete against documented bridge contracts
  (signal-cli-rest-api; an HTTP↔IRC bridge whose exact send/receive shapes are
  specified in the IRC adapter docblock). Both still require a self-hosted
  bridge process at runtime.
- **Discord** outbound uses the REST bot API. Inbound has no webhook to receive
  on, so `discord-gateway.transport.ts` holds a real Gateway websocket
  connection (`wss://gateway.discord.gg`, v10/json) and feeds message payloads
  into `normalizeInbound`. A per-gateway distributed lease over redis (acquire NX, renew, compare-and-delete release) keeps exactly one replica connected per gateway, so a multi-replica deployment does not open duplicate connections — see `discord-gateway-lease.spec.ts`.
- **Chat Widget** loop: `POST /gateways/:id/widget/messages` starts/continues a
  run and returns `{ runId, threadId }`; when the run completes, the reply is
  persisted by `ChatWidgetAdapter.sendResponse` and retrieved by the widget via
  `GET /gateways/:id/widget/messages?threadId=...&after=<ISO>` (or streamed
  live over the run SSE using `runId`). Both endpoints are public by design
  (widgets embed on third-party pages); protection = active-gateway check,
  unguessable UUID thread ids, per-gateway rate limits on POST.

## EU AI Act Art. 50 disclosure

`ChannelGatewayService.applyAiDisclosure` implements the transparency
obligation centrally in the outbound dispatch path, so all 14 adapters inherit
it. Opt-in per gateway via `configuration.aiDisclosure`:

- `true` → the first outbound message of each conversation is prefixed with
  "You are chatting with an AI assistant."
- a non-empty string → same, with the custom string.
- unset/false (default) → no disclosure.

First-ness is tracked per conversation on the run
(`run.metadata.aiDisclosureSent`); follow-up replies in the same conversation
are not re-prefixed, and each new conversation discloses again.

## Connectivity probe

`ChannelGatewayService.testConnection(gateway)` performs a **live, no-message**
auth check per type (Slack `auth.test`, Telegram `getMe`, Discord `users/@me`,
a Twilio account fetch shared by `whatsapp` and `sms`, a Graph API
`{phone_number_id}?fields=id` fetch for `whatsapp_cloud`, Teams token issuance,
Matrix `whoami`, Resend `domains`, signal-cli `/v1/about`, and a `HEAD` probe
for webhook/google_chat/irc). Widget always returns ok. This is surfaced via
`POST /gateways/:id/test-connection` (admin/owner only).

## Test coverage

All tests mock `globalThis.fetch` / repositories (see
`adapters/__tests__/test-helpers.ts`) and touch **no network or database**.

- 14 adapter specs (`adapters/__tests__/*.adapter.spec.ts`), one per adapter —
  inbound sample payload → normalized shape, outbound → correct
  endpoint/payload/auth, and signature verification (Slack HMAC, Webhook HMAC,
  Google Chat token, Twilio HMAC-SHA1 for both WhatsApp and SMS, Meta
  `X-Hub-Signature-256` for WhatsApp Cloud, Teams JWT incl. JWKS
  caching/rotation/`alg=none` rejection, IRC shared token), MIME parsing matrix
  for email, widget persistence.
- `adapters/__tests__/svix-signature.helper.spec.ts` — the shared svix check the
  email adapter verifies inbound with.
- `channels/__tests__/channel-gateway.service.spec.ts` — adapter-registry
  completeness, `testConnection` per type, `applyAiDisclosure`
  (first/subsequent/custom/disabled/new-conversation), widget gateway
  resolution + message listing.
- `channels/__tests__/channel-widget.controller.spec.ts` — public widget
  surface validation, rate limiting, delegation.

**Total: 225 mocked tests across those 17 suites, all green.** The whole
`channels/` directory is 535 tests across 35 suites, the rest covering
installations, credential/KMS wiring, the Discord gateway lease, hosted chat and
the surface round-trip.

## Live e2e validation (cred-gated, #242)

Mocked tests cannot prove a remote platform accepts our payloads. Each
network-touching adapter still needs a live round-trip with real credentials:

| Adapter | Live creds / infra needed for e2e |
|---------|-----------------------------------|
| Slack | Bot token (`xoxb-…`) + signing secret, app installed in a workspace/channel |
| Telegram | BotFather bot token + a chat that has messaged the bot |
| Discord | Bot token + a guild the bot has joined (the Gateway websocket transport is in-tree) |
| WhatsApp | Twilio account SID + auth token + a WhatsApp-enabled sender number |
| WhatsApp Cloud | Meta app: system-user `access_token`, `phone_number_id`, `verify_token` for the handshake, `app_secret` for inbound signatures, and a publicly reachable webhook URL |
| SMS | Twilio account SID + auth token + an SMS-capable sender number, and `webhook_url` matching the console exactly |
| Email | Resend API key + a verified sending domain + an inbound-email webhook source + the `whsec_…` inbound signing secret |
| Webhook | A reachable `callback_url` receiver (+ shared `secret`) |
| Google Chat | Space incoming-webhook URL (+ verification token) |
| Microsoft Teams | Azure bot registration: `bot_id` + `bot_password`, app in Teams |
| Signal | A running signal-cli REST instance + a registered phone number |
| Matrix | Homeserver URL + a bot user access token + a joined room |
| IRC | A running IRC↔HTTP bridge (matterbridge/Ergo shim) reachable at `webhook_url` |
| Chat Widget | None — in-app persistence + polling/SSE; no external creds |

None of these live round-trips have been exercised (no real tokens available);
they are the remaining manual/e2e gap tracked in #242. The mocked suite fully
covers payload shape, endpoint, auth-header construction, inbound parsing, and
signature verification.
