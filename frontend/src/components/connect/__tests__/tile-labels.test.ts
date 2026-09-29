import { describe, it, expect } from 'vitest'

import { splitTileName } from '@/components/connect/service-tiles'
import { channelTileLabel } from '@/pages/agent-channel-new'
import { ADDABLE_CHANNEL_TYPES, CHANNEL_HINTS } from '@/lib/agent-channels'
import { PROVIDER_TILE_ORDER, providerTileLabel } from '@/components/llm-providers/provider-catalog'

/**
 * A tile's label is cut to one line. In the four-column "Add channel"
 * grid that is about fifteen characters, so "WhatsApp (Twilio)" and
 * "WhatsApp (Meta Cloud)" both read "WhatsApp (…" and look like one channel.
 */
describe('tile labels', () => {
  it('move a parenthesised qualifier to the line under the name', () => {
    expect(splitTileName('WhatsApp (Meta)')).toEqual({ label: 'WhatsApp', hint: 'Meta' })
    expect(splitTileName('Your own server (OpenAI-compatible)')).toEqual({ label: 'Your own server', hint: 'OpenAI-compatible' })
    expect(splitTileName('Slack')).toEqual({ label: 'Slack' })
  })

  it('fit the add-channel tiles, and two channels never share label and hint', () => {
    const seen = new Set<string>()
    for (const type of ADDABLE_CHANNEL_TYPES) {
      const label = channelTileLabel(type)
      expect(label.length, `${type}: "${label}"`).toBeLessThanOrEqual(15)
      const key = `${label}|${CHANNEL_HINTS[type]}`
      expect(seen.has(key), `${type} reads the same as another channel`).toBe(false)
      seen.add(key)
    }
    expect([channelTileLabel('whatsapp'), CHANNEL_HINTS.whatsapp]).toEqual(['WhatsApp', 'Via Twilio'])
    expect([channelTileLabel('whatsapp_cloud'), CHANNEL_HINTS.whatsapp_cloud]).toEqual(['WhatsApp', 'Via Meta Cloud'])
    expect([channelTileLabel('a2a'), CHANNEL_HINTS.a2a]).toEqual(['Other agents', 'Over A2A'])
  })

  it('fit the provider tiles on Connect a provider', () => {
    for (const type of PROVIDER_TILE_ORDER) {
      const { label } = splitTileName(providerTileLabel(type))
      expect(label.length, `${type}: "${label}"`).toBeLessThanOrEqual(22)
    }
  })
})
