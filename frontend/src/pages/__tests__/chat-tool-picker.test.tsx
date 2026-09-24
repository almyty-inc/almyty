import { describe, it, expect, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'

import { render } from '../../test/setup'
import { ChatPage } from '../chat'

vi.mock('@/lib/llm-providers-query', () => ({
  llmProvidersQuery: {
    queryKey: ['llm-providers'],
    queryFn: async () => [{ id: 'p-1', name: 'OpenAI', status: 'active', type: 'openai' }],
  },
}))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: {},
  toolsApi: {
    getAll: vi.fn(async () => [
      { id: 't-1', name: 'weather_lookup', description: 'Look up weather', type: 'http' },
      { id: 't-2', name: 'send_email', description: 'Send an email', type: 'api' },
    ]),
  },
}))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: () => ({ currentOrganization: { id: 'org-1', name: 'Org' } }),
}))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))

describe('Chat tool picker', () => {
  it('attaches tools in an inline panel, not a dialog', async () => {
    render(<ChatPage />)
    const toggle = await screen.findByRole('button', { name: /Tools/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    const panel = screen.getByRole('region', { name: 'Attach tools' })

    fireEvent.click(await within(panel).findByRole('checkbox', { name: /weather_lookup/ }))
    expect(within(panel).getByText('1 tool selected')).toBeInTheDocument()
    // The count rides on the toggle once the panel is closed.
    fireEvent.click(within(panel).getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('region', { name: 'Attach tools' })).not.toBeInTheDocument()
    expect(within(screen.getByRole('button', { name: /Tools/ })).getByText('1')).toBeInTheDocument()
  })
})
