import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/setup'
import { SecurityTab } from '../security-tab'
import { SchemaTab } from '../schema-tab'
import { OperationsTab } from '../operations-tab'
import { CredentialsTab } from '../credentials-tab'
import { apisApi } from '@/lib/api'
import type { Api, ApiOperation } from '@/types'

vi.mock('@/lib/api', () => ({
  apisApi: {
    update: vi.fn(),
    getParsedSchema: vi.fn(),
    getCredentials: vi.fn(),
    createCredential: vi.fn(),
    deleteCredential: vi.fn(),
    testCredential: vi.fn(),
  },
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))

// Radix Select uses pointer-capture + scrollIntoView, absent in jsdom.
beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture)
    Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = vi.fn()
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = vi.fn()
})

const API = {
  id: 'api-1',
  name: 'Northwind',
  type: 'openapi',
  baseUrl: 'https://example.test',
  authentication: { type: 'none', config: {} },
  schemas: [{ id: 'schema-1', rawSchema: 'openapi: 3.0.0' }],
} as unknown as Api

function Security() {
  const [editing, setEditing] = useState(false)
  return <SecurityTab api={API} editing={editing} onEditingChange={setEditing} />
}

describe('SecurityTab (inline authentication)', () => {
  it('shows the method, and Edit turns the section into a form that saves', async () => {
    vi.mocked(apisApi.update).mockResolvedValue({} as any)
    const user = userEvent.setup()
    render(<Security />)
    expect(screen.getByTestId('api-auth-summary')).toHaveTextContent('No authentication')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const form = screen.getByRole('form', { name: 'Configure authentication' })
    expect(form).toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'Authentication type' }))
    await user.click(await screen.findByRole('option', { name: 'Bearer token' }))

    const token = screen.getByLabelText('Bearer token')
    // A secret: masked, and password managers keep out.
    expect(token).toHaveAttribute('type', 'password')
    expect(token).toHaveAttribute('data-1p-ignore', 'true')
    await user.type(token, 'tok-123')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(apisApi.update).toHaveBeenCalledWith('api-1', {
        authentication: { type: 'bearer_token', config: { token: 'tok-123' } },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Configure authentication' })).not.toBeInTheDocument())
  })

  it('Cancel folds the form away without saving', async () => {
    const user = userEvent.setup()
    render(<Security />)
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'Configure authentication' })).not.toBeInTheDocument()
    expect(apisApi.update).not.toHaveBeenCalled()
  })
})

describe('SchemaTab (inline viewer)', () => {
  it('renders nothing closed, the raw schema open, and Close closes it', async () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(<SchemaTab api={API} open={false} onOpenChange={onOpenChange} />)
    expect(screen.queryByTestId('api-schema-viewer')).not.toBeInTheDocument()

    rerender(<SchemaTab api={API} open onOpenChange={onOpenChange} />)
    expect(screen.getByTestId('api-schema-viewer')).toHaveTextContent('openapi: 3.0.0')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close schema content' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe('OperationsTab (inline operation details)', () => {
  const ops = [
    { id: 'op-1', name: 'List orders', method: 'GET', path: '/orders', parameters: [] },
    { id: 'op-2', name: 'Create order', method: 'POST', path: '/orders', parameters: [] },
  ] as unknown as ApiOperation[]

  it('expands an operation in place with its full endpoint', async () => {
    const user = userEvent.setup()
    render(<OperationsTab api={API} operations={ops} apiTools={[]} onOpenSchemaImport={vi.fn()} />)
    const row = screen.getByRole('button', { name: /GET \/orders List orders/ })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    await user.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'true')
    const details = screen.getByTestId('operation-details')
    expect(details).toHaveTextContent('https://example.test/orders')
    expect(details).toHaveTextContent('No tools generated for this operation yet')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(row)
    expect(screen.queryByTestId('operation-details')).not.toBeInTheDocument()
  })
})

describe('CredentialsTab (inline add)', () => {
  beforeEach(() => {
    vi.mocked(apisApi.getCredentials).mockResolvedValue([] as any)
  })

  it('adds a credential from a form in the section', async () => {
    vi.mocked(apisApi.createCredential).mockResolvedValue({ id: 'c1' } as any)
    const user = userEvent.setup()
    render(<CredentialsTab apiId="api-1" apiName="Northwind" />)
    await user.click(screen.getByRole('button', { name: 'Add credential' }))
    expect(screen.getByRole('form', { name: 'Add credential' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: /Type/ }))
    await user.click(await screen.findByRole('option', { name: 'API Key' }))
    const key = screen.getByLabelText('API key')
    expect(key).toHaveAttribute('data-1p-ignore', 'true')
    await user.type(key, 'sk-1')
    await user.click(screen.getByRole('button', { name: 'Save credential' }))

    await waitFor(() =>
      expect(apisApi.createCredential).toHaveBeenCalledWith('api-1', {
        name: 'Northwind API Key',
        type: 'API_KEY',
        config: { apiKey: 'sk-1' },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Add credential' })).not.toBeInTheDocument())
  })

  it('without a type, says so on the field and focuses it', async () => {
    const user = userEvent.setup()
    render(<CredentialsTab apiId="api-1" apiName="Northwind" />)
    await user.click(screen.getByRole('button', { name: 'Add credential' }))
    await user.click(screen.getByRole('button', { name: 'Save credential' }))
    const type = screen.getByRole('combobox', { name: /Type/ })
    expect(type).toHaveAttribute('aria-invalid', 'true')
    expect(document.activeElement).toBe(type)
    expect(screen.getByText('Choose the kind of credential the API expects.')).toBeInTheDocument()
    expect(apisApi.createCredential).not.toHaveBeenCalled()
  })
})
