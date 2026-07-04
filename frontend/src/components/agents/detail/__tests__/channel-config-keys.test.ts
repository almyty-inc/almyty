import { describe, it, expect } from 'vitest'

import { getDefaultInterfaceConfig } from '../constants'

/**
 * Completeness pin for the deploy dialog's channel configuration keys.
 *
 * Every key the dialog writes MUST be a key the backend actually reads
 * (backend/src/modules/gateways/channels/adapters/* plus the webhook
 * registrar / test-connection paths). The dialog historically wrote
 * camelCase keys (botToken) that no adapter looked at, producing
 * channels that saved fine and then silently failed to send.
 *
 * The lists below are hand-copied from the adapter sources. If you add
 * a key to getDefaultInterfaceConfig that the adapters don't read (or
 * rename one), this test fails — update the adapter first, then the
 * list.
 */
const ADAPTER_READ_KEYS: Record<string, string[]> = {
  // widget-script.ts reads camelCase presentation keys — the one
  // deliberate exception to snake_case.
  chat_widget: ['welcomeMessage', 'primaryColor', 'position', 'theme'],
  // slack.adapter.ts: bot_token, signing_secret (+ optional
  // client_id/client_secret for multi-workspace installs, added by
  // the dialog's optional OAuth fields, not the defaults)
  slack: ['bot_token', 'signing_secret'],
  // discord.adapter.ts / discord-gateway.transport.ts: bot_token
  discord: ['bot_token'],
  // telegram.adapter.ts + webhook registrar: bot_token
  telegram: ['bot_token'],
  // whatsapp.adapter.ts / sms.adapter.ts + registrar:
  // twilio_account_sid, twilio_auth_token, phone_number
  whatsapp: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  sms: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
  // whatsapp-cloud.adapter.ts: access_token, phone_number_id,
  // verify_token, app_secret
  whatsapp_cloud: ['access_token', 'phone_number_id', 'verify_token', 'app_secret'],
  // email.adapter.ts: resend_api_key, reply_from (+ inbound_address,
  // provisioned server-side, never typed in the dialog)
  email: ['resend_api_key', 'reply_from'],
  // webhook.adapter.ts: callback_url, secret
  webhook: ['callback_url', 'secret'],
  // google-chat.adapter.ts: webhook_url, verification_token
  google_chat: ['webhook_url', 'verification_token'],
  // microsoft-teams.adapter.ts: bot_id, bot_password (+ service_url
  // from the inbound payload)
  microsoft_teams: ['bot_id', 'bot_password'],
  // signal.adapter.ts: api_url, phone_number
  signal: ['phone_number', 'api_url'],
  // matrix.adapter.ts: homeserver_url, access_token, room_id
  matrix: ['homeserver_url', 'access_token', 'room_id'],
  // irc.adapter.ts: webhook_url, channel, nick (+ optional
  // bridge_token / inbound_token)
  irc: ['webhook_url', 'channel', 'nick'],
}

describe('deploy dialog channel config keys match adapter-read keys', () => {
  for (const [type, expectedKeys] of Object.entries(ADAPTER_READ_KEYS)) {
    it(`${type}: default config keys are exactly the adapter-read keys`, () => {
      const defaults = getDefaultInterfaceConfig(type)
      expect(Object.keys(defaults).sort()).toEqual([...expectedKeys].sort())
    })
  }

  it('every non-widget key is snake_case', () => {
    for (const type of Object.keys(ADAPTER_READ_KEYS)) {
      if (type === 'chat_widget') continue
      for (const key of Object.keys(getDefaultInterfaceConfig(type))) {
        expect(key, `${type}.${key} must be snake_case`).toMatch(/^[a-z0-9_]+$/)
      }
    }
  })

  it('unknown channel types default to an empty config', () => {
    expect(getDefaultInterfaceConfig('a2a')).toEqual({})
    expect(getDefaultInterfaceConfig('openai_chat')).toEqual({})
  })
})
