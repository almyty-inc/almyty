import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '@/test/setup'
import { SchemaTab } from '../schema-tab'
import { OperationsTab } from '../operations-tab'
import type { Api, ApiOperation } from '@/types'

vi.mock('@/lib/api', () => ({
  apisApi: {
    update: vi.fn(),
    getParsedSchema: vi.fn(),
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
    expect(details).toHaveTextContent('No tools generated for this operation yet')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(row)
    expect(screen.queryByTestId('operation-details')).not.toBeInTheDocument()
  })
})
