import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/setup'
import { apisApi } from '@/lib/api'
import { SchemaTab } from '../schema-tab'
import { OperationsTab } from '../operations-tab'
import type { Api, ApiOperation } from '@/types'

vi.mock('@/lib/api', () => ({
  apisApi: {
    update: vi.fn(),
    getParsedSchema: vi.fn(),
    makeOperationTool: vi.fn(),
    getOperationOutline: vi.fn(),
    selectOperations: vi.fn(),
    pollImportStatus: vi.fn(),
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
    expect(details).toHaveTextContent('No tool made from this operation yet')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(row)
    expect(screen.queryByTestId('operation-details')).not.toBeInTheDocument()
  })

  // GitHub REST (1,280 operations): an operation not picked at import said
  // "No tools generated for this operation yet" with nothing to do about it.
  it('makes the tool of an operation without one, in place', async () => {
    const user = userEvent.setup()
    vi.mocked(apisApi.makeOperationTool).mockResolvedValue({ toolId: 'tool-9', toolName: 'northwind_create_order' })
    render(<OperationsTab api={API} operations={ops} apiTools={[]} onOpenSchemaImport={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /POST \/orders Create order/ }))
    await user.click(screen.getByRole('button', { name: 'Make a tool' }))

    expect(apisApi.makeOperationTool).toHaveBeenCalledWith('api-1', 'op-2')
    const made = await screen.findByRole('status')
    expect(made).toHaveTextContent('Made the tool northwind_create_order')
    expect(screen.getByRole('link', { name: 'northwind_create_order' })).toHaveAttribute('href', '/tools/tool-9')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('says why the tool was not made', async () => {
    const user = userEvent.setup()
    vi.mocked(apisApi.makeOperationTool).mockRejectedValue({ response: { data: { message: 'The limit per schema is 1000.' } } })
    render(<OperationsTab api={API} operations={ops} apiTools={[]} onOpenSchemaImport={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /POST \/orders Create order/ }))
    await user.click(screen.getByRole('button', { name: 'Make a tool' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The limit per schema is 1000.')
  })

  it('reopens the operation picker in place on the current pick, and makes tools from the new pick', async () => {
    const user = userEvent.setup()
    vi.mocked(apisApi.getOperationOutline).mockResolvedValue({
      operations: [
        { id: 'op-1', name: 'List orders', displayName: 'List orders', method: 'GET', endpoint: '/orders', tags: ['orders'], isActive: true, operationId: 'listOrders' },
        { id: 'op-2', name: 'Create order', displayName: 'Create order', method: 'POST', endpoint: '/orders', tags: ['orders'], isActive: false, operationId: 'createOrder' },
      ],
      limit: 1000,
    } as any)
    vi.mocked(apisApi.selectOperations).mockResolvedValue({ jobId: 'job-7', selected: 2 })
    vi.mocked(apisApi.pollImportStatus).mockResolvedValue({ status: 'completed' })
    render(<OperationsTab api={API} operations={ops} apiTools={[]} onOpenSchemaImport={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Choose operations' }))
    const picker = await screen.findByTestId('operation-picker')
    // What is picked now starts picked.
    expect(await screen.findByTestId('picked-count')).toHaveTextContent('1 of 1,000 picked')
    expect(screen.getByTestId('choose-operations')).toHaveTextContent('Taking an operation out does not delete its tool')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /Pick every operation in orders/i }))
    await user.click(screen.getByRole('button', { name: 'Make 2 tools' }))

    expect(apisApi.selectOperations).toHaveBeenCalledWith('api-1', ['op-1', 'op-2'])
    expect(apisApi.pollImportStatus).toHaveBeenCalledWith('api-1', 'job-7')
    await waitFor(() => expect(picker).not.toBeInTheDocument())
  })
})

describe('OperationsTab for a manual HTTP API (no description)', () => {
  const HTTP_API = { ...API, id: 'api-http', type: 'http', schemas: [] } as unknown as Api

  it('offers "Add a tool", opening the create-tool page linked to this API', () => {
    render(<OperationsTab api={HTTP_API} operations={[]} apiTools={[]} onOpenSchemaImport={vi.fn()} />)

    expect(screen.getByText(/Add its tools by hand/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Add a tool' })).toHaveAttribute(
      'href',
      '/tools/new?type=http&api=api-http',
    )
    // Importing a description stays possible.
    expect(screen.getByRole('button', { name: 'Import a description' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
