import { describe, it, expect } from 'vitest'

import { buildWidgetEmbedSnippet } from '../widget-embed'

describe('buildWidgetEmbedSnippet', () => {
  it('builds the widget embed snippet from the gateway id', () => {
    expect(buildWidgetEmbedSnippet('https://api.almyty.dev', 'gw-1')).toBe(
      '<script src="https://api.almyty.dev/gateways/gw-1/widget.js" async></script>',
    )
  })

  it('tolerates a trailing slash on the api host', () => {
    expect(buildWidgetEmbedSnippet('https://api.almyty.dev/', 'gw-1')).toBe(
      '<script src="https://api.almyty.dev/gateways/gw-1/widget.js" async></script>',
    )
  })
})
