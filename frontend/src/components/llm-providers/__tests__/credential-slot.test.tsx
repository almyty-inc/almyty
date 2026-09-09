import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'

import { render } from '../../../test/setup'
import { EditProviderDialog } from '../edit-provider-dialog'
import { ProviderDetailsSheet } from '../provider-details-sheet'
import { CredentialRefSummary, isMaskedKey } from '../credential-slot'

vi.mock('@/lib/api', () => ({
  llmProvidersApi: { testConnection: vi.fn(), chat: vi.fn(), getModels: vi.fn() },
}))

vi.mock('@/lib/connections-api', () => ({
  connectionsApi: {
    list: vi.fn().mockResolvedValue([
      { id: 'conn-openai', name: 'OpenAI prod', connectorKey: 'openai', kind: 'inference', owner: 'org', accountLabel: 'acme', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'conn-anthropic', name: 'Anthropic', connectorKey: 'anthropic', kind: 'inference', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'conn-mcp', name: 'MCP', connectorKey: 'mcp-custom', kind: 'mcp', owner: 'org', health: { status: 'valid' }, createdAt: '2026-01-01T00:00:00.000Z' },
    ]),
  },
}))

const credentialRef = { id: 'conn-openai', name: 'OpenAI prod', connectorKey: 'openai', healthStatus: 'valid' }

function EditHarness({ provider, onUpdate }: { provider: any; onUpdate: (payload: any) => void }) {
  const form = useForm<any>({
    defaultValues: { name: provider.name, model: '', maxTokens: 4096, temperature: 0.7, apiKey: '', usageApiKey: '', credentialId: undefined, usageCredentialId: undefined },
  })
  const mutation = { isPending: false, mutate: (payload: any) => onUpdate(payload) } as any
  return <EditProviderDialog open onOpenChange={() => {}} editForm={form} providerToEdit={provider} updateProviderMutation={mutation} availableModels={[]} modelsLoading={false} />
}

const withRef = { id: 'p-1', type: 'openai', name: 'prod', credentialRef, usageCredentialRef: null, configuration: { apiKey: '***masked***', usageApiKey: undefined } }

describe('isMaskedKey', () => {
  it('recognises the API marker only', () => {
    expect(isMaskedKey('***masked***')).toBe(true)
    expect(isMaskedKey('sk-live')).toBe(false)
    expect(isMaskedKey(undefined)).toBe(false)
  })
})

describe('CredentialRefSummary', () => {
  it('shows the connection name, connector and health, never a key', () => {
    render(<CredentialRefSummary credentialRef={credentialRef} />)
    const ref = screen.getByTestId('credential-ref')
    expect(ref).toHaveTextContent('OpenAI prod')
    expect(ref).toHaveTextContent('openai')
    expect(within(ref).getByTestId('connection-health')).toHaveAttribute('data-status', 'valid')
  })

  it('says a pasted key is on file without showing it', () => {
    render(<CredentialRefSummary credentialRef={null} hasStoredKey />)
    expect(screen.getByTestId('credential-ref-none')).toHaveTextContent(/pasted key, stored encrypted/)
    expect(screen.queryByText('***masked***')).not.toBeInTheDocument()
  })
})

describe('EditProviderDialog credential slots', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens on the backing connection and submits without touching the credential', async () => {
    const onUpdate = vi.fn()
    render(<EditHarness provider={withRef} onUpdate={onUpdate} />)

    const slot = within(screen.getByTestId('credential-slot-credentialId'))
    expect(slot.getByRole('button', { name: 'Keep current' })).toHaveAttribute('aria-pressed', 'true')
    expect(slot.getByTestId('credential-ref')).toHaveTextContent('OpenAI prod')
    // No key input and no masked marker anywhere in the dialog.
    expect(screen.queryByLabelText('New API key')).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('***masked***')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Update Provider/ }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    const data = onUpdate.mock.calls[0][0].data
    expect(data.credentialId).toBeUndefined()
    expect(data.apiKey).toBe('')
  })

  it('lists inference connections of the vendor first and submits the picked one as credentialId', async () => {
    const onUpdate = vi.fn()
    render(<EditHarness provider={withRef} onUpdate={onUpdate} />)
    const slot = within(screen.getByTestId('credential-slot-credentialId'))
    fireEvent.click(slot.getByRole('button', { name: 'Use existing connection' }))

    const select = (await slot.findByLabelText('Use an existing connection')) as HTMLSelectElement
    // Only the OpenAI connection: the vendor has one, so the Anthropic and MCP rows stay out.
    await waitFor(() => expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'conn-openai']))
    expect(slot.getByRole('button', { name: 'Connect an account' })).toBeInTheDocument()

    fireEvent.change(select, { target: { value: 'conn-openai' } })
    expect(await slot.findByTestId('connected-chip')).toHaveTextContent('OpenAI prod')

    fireEvent.click(screen.getByRole('button', { name: /Update Provider/ }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    const data = onUpdate.mock.calls[0][0].data
    expect(data.credentialId).toBe('conn-openai')
    expect(data.apiKey).toBe('')
  })

  it('carries a pasted key and clears the connection field when the user pastes instead', async () => {
    const onUpdate = vi.fn()
    render(<EditHarness provider={withRef} onUpdate={onUpdate} />)
    const slot = within(screen.getByTestId('credential-slot-credentialId'))
    fireEvent.click(slot.getByRole('button', { name: 'Paste a key' }))
    const input = slot.getByLabelText('New API key') as HTMLInputElement
    expect(input.value).toBe('')
    expect(input.placeholder).toMatch(/keep the existing key/i)
    await userEvent.type(input, 'sk-new-key')

    fireEvent.click(screen.getByRole('button', { name: /Update Provider/ }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    const data = onUpdate.mock.calls[0][0].data
    expect(data.apiKey).toBe('sk-new-key')
    expect(data.credentialId).toBeUndefined()
  })

  it('sends null to clear the usage connection', async () => {
    const onUpdate = vi.fn()
    const provider = { ...withRef, usageCredentialRef: { id: 'conn-adm', name: 'OpenAI admin', connectorKey: 'openai', healthStatus: 'failed' } }
    render(<EditHarness provider={provider} onUpdate={onUpdate} />)
    const slot = within(screen.getByTestId('credential-slot-usageCredentialId'))
    expect(within(slot.getByTestId('credential-ref')).getByTestId('connection-health')).toHaveAttribute('data-status', 'failed')
    fireEvent.click(slot.getByRole('button', { name: 'Remove' }))
    expect(slot.getByTestId('credential-slot-clear')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Update Provider/ }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1))
    expect(onUpdate.mock.calls[0][0].data.usageCredentialId).toBeNull()
  })

  it('does not offer Remove for the inference key of a vendor that needs one', () => {
    render(<EditHarness provider={withRef} onUpdate={vi.fn()} />)
    const slot = within(screen.getByTestId('credential-slot-credentialId'))
    expect(slot.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
  })
})

describe('ProviderDetailsSheet configuration tab', () => {
  it('shows the credential references instead of a key field', async () => {
    const provider: any = {
      ...withRef,
      status: 'active', organizationId: 'org', totalRequests: 0, successfulRequests: 0, totalTokensUsed: 0, totalCost: 0, isHealthy: true, createdAt: '', updatedAt: '',
      usageCredentialRef: { id: 'conn-adm', name: 'OpenAI admin', connectorKey: 'openai', healthStatus: 'unknown' },
    }
    render(<ProviderDetailsSheet selectedProvider={provider} onClose={() => {}} providerMetrics={null} toggleProviderStatusMutation={{ isPending: false, mutate: vi.fn() } as any} onOpenTestDialog={() => {}} />)
    await userEvent.click(screen.getByRole('tab', { name: 'Config' }))
    const refs = await screen.findAllByTestId('credential-ref')
    expect(refs[0]).toHaveTextContent('OpenAI prod')
    expect(refs[1]).toHaveTextContent('OpenAI admin')
    expect(screen.queryByDisplayValue('***masked***')).not.toBeInTheDocument()
  })
})
