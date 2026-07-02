/**
 * Channel deployment setup data + pure URL helpers.
 *
 * A deployed channel is an agent-kind gateway. Inbound platform traffic
 * arrives on the unified endpoint `https://<api-host>/<orgSlug>/<gatewaySlug>`;
 * this module knows how to build that URL and what the user has to do on
 * each platform's side to point traffic at it.
 *
 * Kept free of React so the guides and URL builders are unit-testable
 * without rendering.
 */

/** How the platform's webhook gets pointed at almyty. */
export type WebhookMode =
  | 'manual' // user pastes our URL into the platform's console
  | 'auto' // almyty registers the webhook on deploy where the platform supports it
  | 'none' // no inbound webhook (we connect out, or the widget polls)

export interface ChannelSetupGuide {
  /** Heading shown above the checklist. */
  title: string
  webhookMode: WebhookMode
  /** Ordered platform-side steps. Concise, one action per step. */
  steps: string[]
}

/**
 * Per-platform deployment checklists. Keep these in sync with
 * docs-site/content/interfaces.mdx (the per-platform quick guides there
 * mirror this list).
 */
export const CHANNEL_SETUP_GUIDES: Record<string, ChannelSetupGuide> = {
  slack: {
    title: 'Slack setup',
    webhookMode: 'manual',
    steps: [
      'Create an app at api.slack.com/apps (from scratch).',
      'Under OAuth & Permissions, add the bot scopes chat:write, app_mentions:read, and im:history, then install the app to your workspace.',
      'Paste the Bot Token (xoxb-...) and Signing Secret into this channel’s configuration.',
      'Under Event Subscriptions, enable events and paste the webhook URL above as the Request URL.',
      'Subscribe to the bot events message.im and app_mention, then save.',
    ],
  },
  telegram: {
    title: 'Telegram setup',
    webhookMode: 'auto',
    steps: [
      'Message @BotFather, run /newbot, and copy the bot token into this channel’s configuration.',
      'The webhook is registered automatically on deploy — no manual step on Telegram’s side.',
    ],
  },
  whatsapp: {
    title: 'WhatsApp (Twilio) setup',
    webhookMode: 'auto',
    steps: [
      'Copy the Account SID and Auth Token from the Twilio Console.',
      'Enter your WhatsApp sender number in this channel’s configuration.',
      'The number’s inbound webhook is registered automatically where the platform supports it.',
    ],
  },
  sms: {
    title: 'SMS (Twilio) setup',
    webhookMode: 'auto',
    steps: [
      'Copy the Account SID and Auth Token from the Twilio Console.',
      'Enter the Twilio phone number that should receive messages.',
      'The number’s inbound webhook is registered automatically where the platform supports it.',
    ],
  },
  whatsapp_cloud: {
    title: 'WhatsApp Cloud (Meta) setup',
    webhookMode: 'manual',
    steps: [
      'Create a Meta app with the WhatsApp product at developers.facebook.com.',
      'Paste the access token, phone number ID, verify token, and app secret into this channel’s configuration.',
      'In the app’s WhatsApp → Configuration page, paste the webhook URL above as the callback URL, using the same verify token.',
      'Subscribe the app to the messages webhook field.',
    ],
  },
  discord: {
    title: 'Discord setup',
    webhookMode: 'none',
    steps: [
      'Create an application and bot at discord.com/developers/applications.',
      'Enable the MESSAGE CONTENT intent under Bot settings.',
      'Invite the bot to your server via an OAuth2 URL with the bot scope.',
      'No webhook needed — almyty connects out to the Discord gateway.',
    ],
  },
  google_chat: {
    title: 'Google Chat setup',
    webhookMode: 'manual',
    steps: [
      'Create a Chat app in the Google Cloud console and set the webhook URL above as its HTTP endpoint.',
      'Paste the space’s incoming webhook URL and the verification token into this channel’s configuration.',
    ],
  },
  microsoft_teams: {
    title: 'Microsoft Teams setup',
    webhookMode: 'manual',
    steps: [
      'Register a bot in Azure (Bot Framework) and copy the bot ID, password, and tenant ID here.',
      'Set the bot’s messaging endpoint to the webhook URL above.',
    ],
  },
  signal: {
    title: 'Signal setup',
    webhookMode: 'manual',
    steps: [
      'Run a signal-cli-rest-api bridge and enter its URL and your phone number here.',
      'Point the bridge’s receive webhook at the webhook URL above.',
    ],
  },
  matrix: {
    title: 'Matrix setup',
    webhookMode: 'none',
    steps: [
      'Enter the homeserver URL, an access token for the bot account, and the room ID.',
      'No webhook needed — almyty syncs from the homeserver.',
    ],
  },
  irc: {
    title: 'IRC setup',
    webhookMode: 'manual',
    steps: [
      'Run an IRC↔HTTP bridge and enter the server, port, channel, and nick here.',
      'Point the bridge’s outbound webhook at the webhook URL above.',
    ],
  },
  email: {
    title: 'Email setup',
    webhookMode: 'manual',
    steps: [
      'Paste a Resend API key and set the reply-from and receive addresses.',
      'Configure your inbound email route to forward to the webhook URL above.',
    ],
  },
  webhook: {
    title: 'Webhook setup',
    webhookMode: 'manual',
    steps: [
      'POST messages to the webhook URL above; optionally sign requests with the shared secret (HMAC).',
      'Replies are POSTed to the callback URL you configure here.',
    ],
  },
  chat_widget: {
    title: 'Chat widget setup',
    webhookMode: 'none',
    steps: [
      'Copy the embed snippet below into your site’s HTML, just before the closing body tag.',
      'No webhook needed — the widget talks to almyty directly.',
    ],
  },
  a2a: {
    title: 'A2A setup',
    webhookMode: 'none',
    steps: [
      'Share the endpoint URL above with the calling agent; it speaks the A2A protocol directly.',
    ],
  },
  openai_chat: {
    title: 'OpenAI-compatible setup',
    webhookMode: 'none',
    steps: [
      'Point any OpenAI-compatible client at the API host with path /v1 and use this agent as the model.',
    ],
  },
}

/**
 * Channel types whose adapter honours `configuration.aiDisclosure`
 * (EU AI Act Art. 50 disclosure line on the first outbound message).
 * Protocol endpoints (a2a, openai_chat) are machine-to-machine and
 * excluded.
 */
export const AI_DISCLOSURE_CHANNEL_TYPES = new Set([
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'whatsapp_cloud',
  'sms',
  'email',
  'webhook',
  'google_chat',
  'microsoft_teams',
  'signal',
  'matrix',
  'irc',
  'chat_widget',
])

/**
 * Gateway slug as used by the unified endpoint. Gateways store it as the
 * `endpoint` field with a leading slash (`/support-bot`); fall back to a
 * slugified name for older rows without one.
 */
export function getGatewaySlug(gateway: { endpoint?: string; name?: string }): string {
  const fromEndpoint = (gateway.endpoint || '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (fromEndpoint) return fromEndpoint
  return (gateway.name || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
}

/** Inbound webhook URL for a deployed channel. */
export function buildChannelWebhookUrl(apiHost: string, orgSlug: string, gatewaySlug: string): string {
  return `${apiHost.replace(/\/+$/, '')}/${orgSlug}/${gatewaySlug}`
}

/** Embed snippet for the chat widget. Served by GET /gateways/:id/widget.js. */
export function buildWidgetEmbedSnippet(apiHost: string, gatewayId: string): string {
  return `<script src="${apiHost.replace(/\/+$/, '')}/gateways/${gatewayId}/widget.js" async></script>`
}
