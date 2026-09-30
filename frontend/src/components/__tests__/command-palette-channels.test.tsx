import { describe, it, expect } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { CommandPalette } from '../command-palette'

// Gateways are MCP, UTCP and Skills. A2A is a channel on an agent, so
// searching for it leads to Agents (where the Channels tab is), not to
// Gateways.
describe('command palette: A2A is a channel, not a gateway', () => {
  const search = async (text: string) => {
    render(<CommandPalette />)
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true })
    await userEvent.setup().type(await screen.findByRole('combobox'), text)
    return screen.queryAllByRole('option').map((o) => o.textContent?.trim())
  }

  it('does not offer Gateways for "a2a", and offers Agents', async () => {
    const options = await search('a2a')
    expect(options).toContain('Agents')
    expect(options).not.toContain('Gateways')
  })

  it('still finds Gateways by its protocols', async () => {
    expect(await search('utcp')).toContain('Gateways')
  })
})
