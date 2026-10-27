import { describe, expect, it } from 'vitest'

import { MESSAGING_CHANNEL_TYPES, OWNER_ADDRESS_HINTS } from '../agent-channels'

/**
 * "Your address there" named only Slack, email and phone, so someone
 * talking to the agent on Telegram had no way to know it wants the
 * numeric user ID. Every messaging channel says what it matches on.
 */
describe('OWNER_ADDRESS_HINTS', () => {
  it('has a hint and a placeholder for every messaging channel', () => {
    for (const type of MESSAGING_CHANNEL_TYPES) {
      expect(OWNER_ADDRESS_HINTS[type]?.hint, type).toBeTruthy()
      expect(OWNER_ADDRESS_HINTS[type]?.placeholder, type).toBeTruthy()
    }
  })

  it('names the id each adapter matches the sender on', () => {
    expect(OWNER_ADDRESS_HINTS.telegram.hint).toMatch(/numeric Telegram user ID/)
    expect(OWNER_ADDRESS_HINTS.discord.hint).toMatch(/Copy User ID/)
    expect(OWNER_ADDRESS_HINTS.whatsapp.placeholder).toBe('whatsapp:+4915123456789')
    expect(OWNER_ADDRESS_HINTS.whatsapp_cloud.placeholder).toBe('4915123456789')
    expect(OWNER_ADDRESS_HINTS.matrix.placeholder).toMatch(/^@.+:.+/)
    expect(OWNER_ADDRESS_HINTS.google_chat.placeholder).toMatch(/^users\//)
  })
})
