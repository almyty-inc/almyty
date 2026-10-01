import { describe, it, expect } from 'vitest'

import { splitTileName } from '@/components/connect/service-tiles'
import { channelTileLabel } from '@/pages/agent-channel-new'
import { ADDABLE_CHANNEL_TYPES, CHANNEL_HINTS } from '@/lib/agent-channels'
import { PROVIDER_TILE_ORDER, providerTileLabel } from '@/components/llm-providers/provider-catalog'
import { PROVIDER_APIS } from '@/components/apis/provider-apis'

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
    expect([channelTileLabel('imessage_sendblue'), CHANNEL_HINTS.imessage_sendblue]).toEqual(['iMessage', 'Via Sendblue'])
    expect([channelTileLabel('imessage_loopmessage'), CHANNEL_HINTS.imessage_loopmessage]).toEqual(['iMessage', 'Via LoopMessage'])
    expect([channelTileLabel('a2a'), CHANNEL_HINTS.a2a]).toEqual(['Other agents', 'Over A2A'])
  })

  it('fit the provider tiles on Connect a provider', () => {
    for (const type of PROVIDER_TILE_ORDER) {
      const { label } = splitTileName(providerTileLabel(type))
      expect(label.length, `${type}: "${label}"`).toBeLessThanOrEqual(22)
    }
  })

  it('keep the add-channel hints to one line, with no ellipsis', () => {
    // "To your own endpoint" is the longest that fits a tile at 1440px.
    for (const type of ADDABLE_CHANNEL_TYPES) {
      expect(CHANNEL_HINTS[type].length, `${type}: "${CHANNEL_HINTS[type]}"`).toBeLessThanOrEqual(20)
    }
  })

  it('keep the ready-made provider API hints to one line', () => {
    for (const api of PROVIDER_APIS) {
      expect(api.hint.length, `${api.key}: "${api.hint}"`).toBeLessThanOrEqual(28)
    }
  })
})
