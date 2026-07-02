import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm } from 'react-hook-form'

import { render } from '../../../test/setup'
import { CreateProviderDialog } from '../create-provider-dialog'
import { EditProviderDialog } from '../edit-provider-dialog'

// The dialogs pull in the credential vault picker, the team-visibility
// selector, and the axios API client — none of which matter for the
// usage-key field. Stub them so the test stays a pure render check.
vi.mock('@/components/credential-picker', () => ({
  CredentialPicker: () => <div data-testid="credential-picker" />,
}))
vi.mock('@/components/ui/visibility-field', () => ({
  VisibilityField: () => <div data-testid="visibility-field" />,
}))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: { testConnection: vi.fn() },
}))

const USAGE_KEY_LABEL = /Usage API key \(admin-scoped, for cost reconciliation\)/

function CreateHarness({ type }: { type: string }) {
  const form = useForm<any>({
    defaultValues: { name: '', type, apiKey: '', usageApiKey: '' },
  })
  const mutation = { isPending: false, mutate: vi.fn() } as any
  return (
    <CreateProviderDialog
      open
      onOpenChange={() => {}}
      createForm={form}
      createProviderMutation={mutation}
    />
  )
}

function EditHarness({
  type,
  onUpdate,
}: {
  type: string
  onUpdate?: (payload: any) => void
}) {
  const form = useForm<any>({
    defaultValues: { name: 'prod', model: '', maxTokens: 4096, temperature: 0.7, usageApiKey: '' },
  })
  const mutation = {
    isPending: false,
    mutate: (payload: any) => onUpdate?.(payload),
  } as any
  return (
    <EditProviderDialog
      open
      onOpenChange={() => {}}
      editForm={form}
      providerToEdit={{ id: 'provider-1', type, name: 'prod' }}
      updateProviderMutation={mutation}
      availableModels={[]}
      modelsLoading={false}
    />
  )
}

describe('usage API key field (issue #241)', () => {
  describe('create dialog', () => {
    it('renders the field for openai (usage API supported)', () => {
      render(<CreateHarness type="openai" />)
      expect(screen.getByLabelText(USAGE_KEY_LABEL)).toBeInTheDocument()
      // Admin-key caveat helper text + docs link
      expect(screen.getByText(/regular inference key cannot read usage\/cost reports/)).toBeInTheDocument()
      expect(screen.getByRole('link', { name: /Admin key docs/ })).toHaveAttribute(
        'href',
        expect.stringContaining('platform.openai.com'),
      )
    })

    it('renders the field for anthropic (usage API supported)', () => {
      render(<CreateHarness type="anthropic" />)
      expect(screen.getByLabelText(USAGE_KEY_LABEL)).toBeInTheDocument()
    })

    it('does not render the field for groq (no usage API)', () => {
      render(<CreateHarness type="groq" />)
      expect(screen.queryByLabelText(USAGE_KEY_LABEL)).not.toBeInTheDocument()
      expect(screen.queryByText(/cost reconciliation/)).not.toBeInTheDocument()
    })
  })

  describe('edit dialog', () => {
    it('renders the field for an openai provider, never prefilled', () => {
      render(<EditHarness type="openai" />)
      const input = screen.getByLabelText(USAGE_KEY_LABEL) as HTMLInputElement
      expect(input).toBeInTheDocument()
      expect(input.value).toBe('')
      expect(input.placeholder).toMatch(/keep the existing key/i)
    })

    it('does not render the field for a groq provider', () => {
      render(<EditHarness type="groq" />)
      expect(screen.queryByLabelText(USAGE_KEY_LABEL)).not.toBeInTheDocument()
    })

    it('carries a newly typed usageApiKey through the update submit', async () => {
      const onUpdate = vi.fn()
      render(<EditHarness type="anthropic" onUpdate={onUpdate} />)

      fireEvent.change(screen.getByLabelText(USAGE_KEY_LABEL), {
        target: { value: 'sk-ant-admin-new-key' },
      })
      fireEvent.click(screen.getByRole('button', { name: /Update Provider/ }))

      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
      expect(onUpdate).toHaveBeenCalledWith({
        id: 'provider-1',
        data: expect.objectContaining({ usageApiKey: 'sk-ant-admin-new-key' }),
      })
    })
  })
})
