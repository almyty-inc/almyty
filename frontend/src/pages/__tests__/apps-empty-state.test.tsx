import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'

import { render } from '../../test/setup'

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return { ...actual, agentAppsApi: { ...actual.agentAppsApi, list: vi.fn().mockResolvedValue([]) } }
})

import { AppsPage } from '../apps'

/**
 * The page the product owner put next to Agents: no card, a bare icon,
 * "Create App" in the header over "Create app" in the empty state.
 */
describe('Apps empty state matches every other list page', () => {
  it('is a panel with a circled icon, under the shared header', async () => {
    render(<AppsPage />)

    const title = await screen.findByText('No apps yet')
    const empty = title.closest('[role="status"]')!
    expect(empty).toHaveAttribute('data-variant', 'panel')
    expect(empty.querySelector('[data-testid="empty-state-icon"]')).not.toBeNull()

    expect(screen.getByRole('heading', { level: 1, name: 'Apps' })).toBeInTheDocument()
    expect(screen.getByText('0 apps')).toBeInTheDocument()
  })

  it('labels the header action and the empty-state action identically', async () => {
    render(<AppsPage />)
    await screen.findByText('No apps yet')
    expect(screen.getAllByRole('button', { name: 'Create app' })).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Create App' })).not.toBeInTheDocument()
  })
})
