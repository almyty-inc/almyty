import { describe, it, expect, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { useForm } from 'react-hook-form'

import { render } from '../../../test/setup'
import { CreateProviderDialog } from '../create-provider-dialog'
import { EditProviderDialog } from '../edit-provider-dialog'

vi.mock('@/components/credential-picker', () => ({
  CredentialPicker: () => <div data-testid="credential-picker" />,
}))
vi.mock('@/components/ui/visibility-field', () => ({
  VisibilityField: () => <div data-testid="visibility-field" />,
}))
vi.mock('@/lib/api', () => ({
  llmProvidersApi: { testConnection: vi.fn() },
}))
vi.mock('@/lib/connections-api', () => ({
  connectionsApi: { list: vi.fn().mockResolvedValue([]) },
}))

function CreateHarness({ type }: { type: string }) {
  const form = useForm<any>({ defaultValues: { name: '', type, apiKey: '', apiUrl: '' } })
  return <CreateProviderDialog open onOpenChange={() => {}} createForm={form} createProviderMutation={{ isPending: false, mutate: vi.fn() } as any} />
}

function EditHarness({ type, apiUrl }: { type: string; apiUrl?: string }) {
  const form = useForm<any>({ defaultValues: { name: 'prod', model: '', maxTokens: 4096, temperature: 0.7, apiKey: '', usageApiKey: '', apiUrl: apiUrl ?? '' } })
  return (
    <EditProviderDialog
      open
      onOpenChange={() => {}}
      editForm={form}
      providerToEdit={{ id: 'p-1', type, name: 'prod', configuration: { apiUrl } }}
      updateProviderMutation={{ isPending: false, mutate: vi.fn() } as any}
      availableModels={[]}
      modelsLoading={false}
    />
  )
}

/**
 * The Base URL field (configuration.apiUrl) belongs to the types that
 * have a server of their own: ollama (optional) and custom (required).
 */
describe('provider Base URL field', () => {
  it('create: custom shows a required Base URL with the private-host hint and a hostname placeholder', () => {
    render(<CreateHarness type="custom" />)
    const input = screen.getByLabelText('Base URL')
    expect(input).toHaveAttribute('placeholder', 'https://llm.example.internal/v1')
    expect(screen.getByText(/LLM_ALLOW_PRIVATE_URLS=true/)).toBeInTheDocument()
  })

  it('create: ollama keeps its optional Base URL, openai has none', () => {
    render(<CreateHarness type="ollama" />)
    expect(screen.getByLabelText(/Base URL \(optional\)/)).toBeInTheDocument()
  })

  it('create: openai has no Base URL field', () => {
    render(<CreateHarness type="openai" />)
    expect(screen.queryByLabelText(/Base URL/)).toBeNull()
  })

  it('edit: custom prefills the stored URL and shows the hint', () => {
    render(<EditHarness type="custom" apiUrl="https://llm.example.internal/v1" />)
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://llm.example.internal/v1')
    expect(screen.getByText(/LLM_ALLOW_PRIVATE_URLS=true/)).toBeInTheDocument()
  })

  it('edit: openai has no Base URL field', () => {
    render(<EditHarness type="openai" />)
    expect(screen.queryByLabelText(/Base URL/)).toBeNull()
  })
})
