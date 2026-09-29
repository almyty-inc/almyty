import { describe, it, expect } from 'vitest'

import { splitTileName } from '@/components/connect/service-tiles'
import { DISTRIBUTION_GROUPS, placeTile } from '@/components/agent-apps/add-distribution-picker'
import { PROVIDER_TILE_ORDER, providerTileLabel } from '@/components/llm-providers/provider-catalog'

/**
 * A tile's label is cut to one line. In the four-column "Add a place"
 * grid that is about fifteen characters, so "WhatsApp (Twilio)" and
 * "WhatsApp (Meta)" both read "WhatsApp (…" and look like one place.
 */
describe('tile labels', () => {
  it('move a parenthesised qualifier to the line under the name', () => {
    expect(splitTileName('WhatsApp (Meta)')).toEqual({ label: 'WhatsApp', hint: 'Meta' })
    expect(splitTileName('Your own server (OpenAI-compatible)')).toEqual({ label: 'Your own server', hint: 'OpenAI-compatible' })
    expect(splitTileName('Slack')).toEqual({ label: 'Slack' })
  })

  it('fit the add-a-place tiles, and two places never share label and hint', () => {
    const seen = new Set<string>()
    for (const target of DISTRIBUTION_GROUPS.flatMap((g) => g.targets)) {
      const tile = placeTile(target)
      expect(tile.label.length, `${target}: "${tile.label}"`).toBeLessThanOrEqual(15)
      const key = `${tile.label}|${tile.hint ?? ''}`
      expect(seen.has(key), `${target} reads the same as another place`).toBe(false)
      seen.add(key)
    }
    expect(placeTile('whatsapp')).toEqual({ label: 'WhatsApp', hint: 'Via Twilio' })
    expect(placeTile('whatsapp_cloud')).toEqual({ label: 'WhatsApp', hint: 'Via Meta' })
    expect(placeTile('a2a')).toEqual({ label: 'Other agents', hint: 'A2A' })
  })

  it('fit the provider tiles on Connect a provider', () => {
    for (const type of PROVIDER_TILE_ORDER) {
      const { label } = splitTileName(providerTileLabel(type))
      expect(label.length, `${type}: "${label}"`).toBeLessThanOrEqual(22)
    }
  })
})
