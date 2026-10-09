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
    ├── shared-secret.helper.ts       # constant-time header-secret check, shared by the two iMessage relays
    ├── slack.adapter.ts
    ├── discord.adapter.ts
    ├── telegram.adapter.ts
    ├── whatsapp.adapter.ts
    ├── whatsapp-cloud.adapter.ts
    ├── sms.adapter.ts
    ├── imessage-sendblue.adapter.ts
    ├── imessage-loopmessage.adapter.ts
    ├── email.adapter.ts
    ├── webhook.adapter.ts
    ├── google-chat.adapter.ts
    ├── microsoft-teams.adapter.ts
    ├── signal.adapter.ts
    ├── matrix.adapter.ts
    ├── irc.adapter.ts
    └── chat-widget.adapter.ts
```

**The count is 16.** There are 16 concrete channel adapters, one implementation
file each, and every one is registered in `ChannelGatewayService`'s adapter map.
`base.adapter.ts` is scaffolding rather than a channel and is not counted; the
`*.helper.ts` files are shared helpers, not adapters either.

The adapter map has 17 entries for those 16 classes: `ChatWidgetAdapter` is
registered under both `CHAT_WIDGET` and `HOSTED_CHAT`, because a hosted chat app
persists replies exactly as the widget does and only the front end and the URL
differ. So `GatewayType` defines 17 channel types served by 16 adapters.

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
bridge, IRC bridge, generic callback), `status`/`error_key` for Sendblue and
`success: false` for LoopMessage. `channel-gateway.service.ts` dispatches
the send from a run-completion listener and files the outcome on both the
outbound row and the delivery's inbound row, so an unanswered message can be
traced to the platform's reason and to the run it belonged to.

## Per-adapter status

All 16 adapters are **fully implemented at the code level**: real inbound
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
| 15 | iMessage (Sendblue) | `imessage_sendblue` | Real — receive-webhook JSON (`content`, `from_number`, `to_number`, `message_handle`, `media_url`, `group_id`); the group (`group_id`) or else the sender E.164 as thread key, the sender as `userId`; `media_url` as an attachment, read by the pipeline through `safeFetch`; outbound echoes (`is_outbound`) and status callbacks are acknowledged without a run (`carriesMessage`) | Real — `POST api.sendblue.co/api/send-message` `{ number, from_number, content, media_url? }`, or in a group `/api/send-group-message` `{ group_id, ... }`; `sb-api-key-id` + `sb-api-secret-key` headers; truncated at 18,996 chars; further files as messages of their own; a 2xx with `status: ERROR` or an `error_key` is a refusal. Receive webhook registered on publish and removed on unpublish/delete (`/api/account/webhooks`) | Sendblue does not sign: it echoes the webhook's configured secret in `sb-signing-secret`, compared timing-safe against `signing_secret`, **fail-closed** when unset | **Fully-implemented** | cred-gated (#242) | `api_key_id`, `api_secret_key`, `phone_number`, `signing_secret` |
| 16 | iMessage (LoopMessage) | `imessage_loopmessage` | Real — webhook JSON (`event`, `contact`, `text`, `message_id`, `group`, `attachments`); only `event: message_inbound` with text or files runs, every other event is acknowledged without a run; `group.id` or else `contact` (E.164 or Apple ID) as thread key, `contact` as `userId`; attachment URLs read by the pipeline through `safeFetch` | Real — `POST a.loopmessage.com/api/v1/message/send/`, bare API key as `Authorization`, `{ contact | group, text, sender, attachments? }`, truncated at 9,999 chars; `success: false` is a refusal at any status. Webhook set by hand in the dashboard (no API) | LoopMessage does not sign: it sends the `Authorization` value set for webhooks in its dashboard, compared timing-safe against `inbound_token` (bare or `Bearer`), **fail-closed** when unset | **Fully-implemented** | cred-gated (#242) | `api_key`, `inbound_token`; `sender_name` on the channel (required) |

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
- **iMessage** has no public API, so it goes through a relay that owns the
  Apple-side number, and there are two, picked when the channel is added:
  `imessage_sendblue` and `imessage_loopmessage`, each its own channel type,
  gateway type, adapter and connector (the same split as WhatsApp via Twilio
  vs WhatsApp Cloud). Neither relay signs its webhooks; each sends back a
  shared value in a header, so that value is required to publish and the
  adapters fail closed without it (`shared-secret.helper.ts`). Both relays
  post every event to the one webhook URL, so both adapters override
  `carriesMessage` and the pipeline acknowledges an outbound echo, a status
  callback or a reaction without starting a run or writing an event row.
  - **Group chats** are answered in the group. The group id (Sendblue
    `group_id`, LoopMessage `group.id`) is the thread key, so the whole group
    is one conversation and one run, the way Slack, Teams, Discord, Telegram
    and Signal key a channel or chat; the member who wrote is `userId`, which
    is what the per-sender visitor limit counts (never the group), and is
    recorded as the run's `channelUserId` and on each inbound event row. The
    reply goes to the group: Sendblue `POST /api/send-group-message` with
    `group_id`, LoopMessage `group` in place of `contact`.
  - **Attachments** in: Sendblue's `media_url` (one CDN link) and
    LoopMessage's `attachments` (download URLs) become
    `NormalizedMessage.attachments`, https only, read by the base adapter's
    `fetchAttachment` (a public link, no credentials) like every channel's
    files: see `docs/channels.md`, files people send.
  - **Group members** are named to the agent by a short id derived from
    their number (`channel-speaker.ts`), since the relays give no name.
  - **Attachments** out: the reply's image and file links, and any
    `attachments` a run returns (`{url, type, name}`), reach
    `formatOutbound`; Sendblue sends the first as `media_url` with the text
    and each further one as a message of its own (at most five), LoopMessage
    sends up to ten https URLs of at most 256 characters as `attachments`;
    the links go out of the text.
  - **Webhook registration.** Sendblue documents an account webhooks API, so
    publishing registers the channel URL through `ChannelWebhookRegistrar`:
    list, delete a stale entry for the same URL (Sendblue appends), then add
    `{url, secret: signing_secret, sendblue_numbers: [phone_number]}` as a
    `receive` webhook; unpublish and delete remove it. The outcome is on
    `gateway.metadata.webhookRegistration` and the channel page shows it,
    the refusal included. LoopMessage documents no webhook API, so its page
    keeps the paste-the-URL instructions and says so.
  - **Sender name.** LoopMessage sends every reply from a sender name, which
    is a required field on the channel (not the connection: one key can
    carry several senders). Publishing refuses a channel without one
    (`SENDER_NAME_REQUIRED`), and the adapter refuses to send without one.
  - **Sendblue host.** The API reference gives `https://api.sendblue.co` for
    every call, including webhooks; the webhooks guide shows
    `api.sendblue.com`. The adapter and the registrar use `.co`. The
    `sb-signing-secret` header name comes from Sendblue's Chat SDK adapter
    guide; the webhooks guide says only that the secret is sent in a header.
  Sources: Sendblue
  <https://docs.sendblue.com/api/resources/messages/methods/send/>,
  <https://docs.sendblue.com/api/resources/groups/methods/send_message/>,
  <https://docs.sendblue.com/getting-started/receiving-messages/>,
  <https://docs.sendblue.com/getting-started/groups/>,
  <https://docs.sendblue.com/getting-started/webhooks/>,
  <https://docs.sendblue.com/api/resources/webhooks/methods/create/>,
  <https://docs.sendblue.com/api/resources/webhooks/methods/list/>,
  <https://docs.sendblue.com/api/resources/webhooks/methods/delete/>,
  <https://docs.sendblue.com/guides/chat-sdk-adapter/> (`sb-signing-secret`);
  LoopMessage <https://loopmessage.com/apidocs/send-message>,
  <https://loopmessage.com/apidocs/conversation-api-webhooks>,
  <https://loopmessage.com/apidocs/credentials>.
- **Microsoft Teams** JWT verification fetches the Bot Framework OpenID
  metadata + JWKS once and caches keys for 24h (refresh floor 60s on unknown
  kids). RS256 only; `alg=none` and foreign-issuer tokens are rejected.
- **Email** inbound accepts either raw MIME (string payload, or a
  `raw`/`mime`/`email` field) or pre-parsed JSON. The MIME parser is in-tree
  (`adapters/mime.helper.ts`) and dependency-free — `mailparser` was
  deliberately not added because the adapter contract is synchronous and only
  headers, a text body and the attachments are needed. Attachment metadata
  (filename, content type, decoded byte size, content-id, disposition) is in
  `metadata.attachments`; the normalized `attachments` carry the decoded bytes
  of the first five parts of up to 10 MB each, which the channel hands the
  agent like any channel's files. Outbound remains Resend-specific. Inbound is svix-verified
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
obligation centrally in the outbound dispatch path, so all 16 adapters inherit
it. Opt-in per gateway via `configuration.aiDisclosure`:

- `true` → the first outbound message of each conversation is prefixed with
  "You are chatting with an AI assistant."
- a non-empty string → same, with the custom string.
- unset/false (default) → no disclosure.

First-ness is tracked per conversation on the run
(`run.metadata.aiDisclosureSent`); follow-up replies in the same conversation
are not re-prefixed, and each new conversation discloses again.

Messages the agent starts (scheduled results, always-on reports and notices,
`ScheduledPostService.post`) follow the same rule per destination: a Slack
channel, chat, room or number is one ongoing conversation, disclosed on the
first delivered post there. The delivered post's outbound event row carries
`payload.post = { destination, disclosed }`, and
`ChannelGatewayService.disclosedTo` looks for one among the channel's last 500
posts; none found (never told, the post failed, or retention swept the row)
means the next post discloses again. An email starts a new thread each time
and a webhook delivery is no conversation (`eachPostIsNewConversation`), so
both carry the line on every post.

## Connectivity probe

`ChannelGatewayService.testConnection(gateway)` performs a **live, no-message**
auth check per type (Slack `auth.test`, Telegram `getMe`, Discord `users/@me`,
a Twilio account fetch shared by `whatsapp` and `sms`, a Graph API
`{phone_number_id}?fields=id` fetch for `whatsapp_cloud`, Sendblue
`GET /api/lines` for `imessage_sendblue`, Teams token issuance,
Matrix `whoami`, Resend `domains`, signal-cli `/v1/about`, and a `HEAD` probe
for webhook/google_chat/irc). LoopMessage documents no read-only call, so
`imessage_loopmessage` only checks its keys are present and says so. Widget
always returns ok. This is surfaced via
`POST /gateways/:id/test-connection` (admin/owner only).

## Test coverage

All tests mock `globalThis.fetch` / repositories (see
`adapters/__tests__/test-helpers.ts`) and touch **no network or database**.

- 16 adapter specs (`adapters/__tests__/*.adapter.spec.ts`), one per adapter —
  inbound sample payload → normalized shape, outbound → correct
  endpoint/payload/auth, and signature verification (Slack HMAC, Webhook HMAC,
  Google Chat token, Twilio HMAC-SHA1 for both WhatsApp and SMS, Meta
  `X-Hub-Signature-256` for WhatsApp Cloud, Teams JWT incl. JWKS
  caching/rotation/`alg=none` rejection, IRC shared token, the Sendblue and
  LoopMessage header secrets pass/fail/unset), MIME parsing matrix for email,
  widget persistence. The iMessage specs replay payloads recorded from the
  relays' documentation, since no live account exists.
- `gateways/__tests__/unified-gateway-delegation-imessage.spec.ts` — both
  relays through the unified endpoint: accepted with the secret, 401 without.
- `channels/__tests__/imessage-groups-attachments.spec.ts` — both relays
  through the whole inbound pipeline: a group message runs keyed on the group
  and is answered in the group, a second member continues the same run, the
  visitor limit is asked per sender and a limited member does not silence the
  group, inbound files are fetched through the guarded client (internal
  addresses never dialled, the size cap refused), and a run's files go out
  as the relay's media field.
- `channels/__tests__/channel-attachments.service.spec.ts` — the attachment
  reader against a fake CDN: https only, private/metadata/loopback refused
  before any request, declared and streamed size caps, the bytes deciding the
  type, storage under the conversation, at most five files, names kept to
  one line; web chat and widget uploads accepted and refused by type.
- `adapters/__tests__/channel-files-and-names.spec.ts` — every adapter's
  inbound files (which credential, to which host only), group detection and
  sender names, and how each sends a reply's images and files.
- `channels/__tests__/channel-files-pipeline.spec.ts` — a Slack channel
  message with a file through the whole pipeline: the writer named, the file
  read with the bot token, stored and filed under the run's conversation,
  removed when the run is refused, and the reply's image sent as a block.
- `channels/__tests__/channel-webhook-registrar.service.spec.ts` — Telegram,
  Twilio and Sendblue registration: Sendblue add with the secret and the
  line, replace on republish, delete on unpublish and on delete, the refusal
  recorded for the channel page and no secret in any log or row.
- `adapters/__tests__/svix-signature.helper.spec.ts` — the shared svix check the
  email adapter verifies inbound with.
- `channels/__tests__/channel-gateway.service.spec.ts` — adapter-registry
  completeness, `testConnection` per type, `applyAiDisclosure`
  (first/subsequent/custom/disabled/new-conversation), widget gateway
  resolution + message listing.
- `channels/__tests__/channel-widget.controller.spec.ts` — public widget
  surface validation, rate limiting, delegation.

**Total: 297 mocked tests across the 16 adapter, svix, service and widget suites, all green.** The whole
`channels/` directory is 890 tests across 54 suites, the rest covering
installations, credential/KMS wiring, the Discord gateway lease, hosted chat,
the surface round-trip and the inbound pipeline (including the iMessage relays'
echo/status filtering, dedupe and disclosure).

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
| iMessage (Sendblue) | Sendblue account: API key ID + secret key, a Sendblue line, and a webhook secret; publishing registers the receive webhook with it (a public `PUBLIC_API_URL` is needed for that) |
| iMessage (LoopMessage) | LoopMessage organization API key, an active sender name (entered on the channel), and the webhook URL + authorization header value set in its dashboard |
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
