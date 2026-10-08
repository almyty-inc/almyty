import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const update = vi.fn()
vi.mock('@/lib/api', () => ({ gatewaysApi: { update: (...args: unknown[]) => update(...args) } }))

import { GatewayExposureCard, scriptsBlockedReason } from '../gateway-exposure-card'

const ALLOWED = { serverAllows: true, hasAuth: true, exposure: 'tools' as const }

function renderCard(gateway: Parameters<typeof GatewayExposureCard>[0]['gateway']) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <GatewayExposureCard gateway={gateway} />
    </QueryClientProvider>,
  )
}

describe('how apps see a gateway’s tools', () => {
  beforeEach(() => {
    update.mockReset()
    update.mockResolvedValue({})
    if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
    if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
  })

  it('says why scripts cannot be chosen, in plain words', () => {
    expect(scriptsBlockedReason({ serverAllows: false, hasAuth: true, exposure: 'tools' })).toMatch(/turned off on this server/)
    expect(scriptsBlockedReason({ serverAllows: true, hasAuth: false, exposure: 'tools' })).toMatch(/sign in/)
    expect(scriptsBlockedReason(ALLOWED)).toBeNull()
  })

  it('shows every tool by default, and keeps scripts out while the server has them off', async () => {
    const user = userEvent.setup()
    renderCard({ id: 'gw-1', type: 'mcp', configuration: {}, codeMode: { ...ALLOWED, serverAllows: false } })
    expect(screen.getByLabelText('How apps see the tools')).toHaveTextContent('Every tool')
    expect(screen.getByTestId('exposure-blocked')).toHaveTextContent('turned off on this server')
    await user.click(screen.getByLabelText('How apps see the tools'))
    expect(screen.getByRole('option', { name: 'Search, and write scripts' })).toHaveAttribute('data-disabled')
  })

  it('saves the choice into the gateway configuration, keeping the rest', async () => {
    const user = userEvent.setup()
    renderCard({ id: 'gw-1', type: 'mcp', configuration: { transport: 'http' }, codeMode: ALLOWED })
    await user.click(screen.getByLabelText('How apps see the tools'))
    await user.click(screen.getByRole('option', { name: 'Search, and write scripts' }))
    await waitFor(() => expect(update).toHaveBeenCalledWith('gw-1', { configuration: { transport: 'http', exposure: 'code' } }))
  })

  it('offers what happens to changes once scripts are on, and only tools or code on a Skills gateway', async () => {
    const user = userEvent.setup()
    renderCard({ id: 'gw-2', type: 'skills', configuration: { exposure: 'code' }, codeMode: { ...ALLOWED, exposure: 'code' } })
    expect(screen.getByTestId('script-changes')).toBeInTheDocument()
    await user.click(screen.getByLabelText('How apps see the tools'))
    expect(screen.queryByRole('option', { name: 'Every tool, plus search and scripts' })).not.toBeInTheDocument()
  })
})
