import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../test/setup'
import { LlmProviderNewPage } from '../llm-provider-new'

// The form itself is tested on its own; here only where the page goes after.
const created = { current: { id: 'p-new', name: 'OpenAI', type: 'openai' } }
vi.mock('@/components/llm-providers/add-inference-provider-form', () => ({
  AddInferenceProviderForm: ({ onCreated, onCancel }: { onCreated: (p: any) => void; onCancel: () => void }) => (
    <div>
      <button onClick={() => onCreated(created.current)}>fake-save</button>
      <button onClick={onCancel}>fake-cancel</button>
    </div>
  ),
}))

const navigate = vi.fn()
const searchParams = { current: new URLSearchParams() }
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate, useSearchParams: () => [searchParams.current, vi.fn()] }
})

describe('LlmProviderNewPage', () => {
  beforeEach(() => {
    navigate.mockReset()
    searchParams.current = new URLSearchParams()
  })

  it('is a page, not a dialog, and opens the new provider when saved', async () => {
    render(<LlmProviderNewPage />)
    expect(screen.getByRole('heading', { name: 'Add inference provider' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'fake-save' }))
    expect(navigate).toHaveBeenCalledWith('/llm-providers/p-new')
  })

  it('goes back to a same-origin returnTo after saving or cancelling', async () => {
    searchParams.current = new URLSearchParams({ returnTo: '/agents/a1/edit?tab=model' })
    render(<LlmProviderNewPage />)
    await userEvent.click(screen.getByRole('button', { name: 'fake-save' }))
    expect(navigate).toHaveBeenLastCalledWith('/agents/a1/edit?tab=model')
    await userEvent.click(screen.getByRole('button', { name: 'fake-cancel' }))
    expect(navigate).toHaveBeenLastCalledWith('/agents/a1/edit?tab=model')
  })

  it('ignores a returnTo that points anywhere else', async () => {
    searchParams.current = new URLSearchParams({ returnTo: 'https://evil.example/x' })
    render(<LlmProviderNewPage />)
    await userEvent.click(screen.getByRole('button', { name: 'fake-save' }))
    expect(navigate).toHaveBeenCalledWith('/llm-providers/p-new')
  })
})
