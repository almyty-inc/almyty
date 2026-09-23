import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import { MemoryNewPage, MemoryTransferPage } from '../../../pages/memory-new'
import { memoriesApi } from '../../../lib/api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('../../../lib/api', () => ({
  memoriesApi: { put: vi.fn(), transfer: vi.fn(), listBackends: vi.fn() },
}))

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('../../../store/app', () => ({ useNotifications: () => notify }))
vi.mock('../../../store/organization', () => ({
  useOrganizationStore: (selector?: (s: any) => any) => {
    const state = { currentOrganization: { id: 'org-1', name: 'Org' } }
    return selector ? selector(state) : state
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(memoriesApi.listBackends).mockResolvedValue([{ id: 'almyty-native' }, { id: 'mem0' }] as any)
})

describe('/memories/new', () => {
  it('stores the memory in the org workspace and returns to the list', async () => {
    vi.mocked(memoriesApi.put).mockResolvedValue({ id: 'm1' } as any)
    const { queryClient } = renderAtRoute(<MemoryNewPage />, { path: '/memories/new', paths: ['/memories'] })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    fireEvent.change(screen.getByLabelText(/^Content/), { target: { value: 'Prefers metric units' } })
    fireEvent.change(screen.getByLabelText(/^Tags/), { target: { value: 'user-pref, units ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Store' }))

    await waitFor(() => expect(memoriesApi.put).toHaveBeenCalledTimes(1))
    expect(vi.mocked(memoriesApi.put).mock.calls[0][0]).toMatchObject({
      mode: 'memory',
      scope: { scope_type: 'workspace', scope_id: 'org-1' },
      content: 'Prefers metric units',
      tier: 'short',
      tags: ['user-pref', 'units'],
      source_uri: undefined,
    })
    expect(await screen.findByText('at /memories')).toBeInTheDocument()
    // Storing is what trips a soft cap: the warnings key must refresh too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memories', 'softcap-warnings', 'org-1'] })
  })

  it('refuses an empty memory and focuses the content field', async () => {
    renderAtRoute(<MemoryNewPage />, { path: '/memories/new' })
    fireEvent.click(screen.getByRole('button', { name: 'Store' }))
    expect(await screen.findByText('Write what the memory should hold.')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^Content/)))
    expect(memoriesApi.put).not.toHaveBeenCalled()
  })
})

describe('/memories/transfer', () => {
  it('runs a dry run, stays on the page and shows the warnings', async () => {
    vi.mocked(memoriesApi.transfer).mockResolvedValue({ succeeded: 3, total_source: 4, warnings: ['ttl is not supported by mem0'] } as any)
    renderAtRoute(<MemoryTransferPage />, { path: '/memories/transfer', paths: ['/memories'] })

    fireEvent.click(screen.getByRole('button', { name: 'Run dry run' }))
    await waitFor(() => expect(memoriesApi.transfer).toHaveBeenCalledTimes(1))
    expect(vi.mocked(memoriesApi.transfer).mock.calls[0][0]).toEqual({
      scope_type: 'workspace', scope_id: 'org-1', source: 'almyty-native', target: 'mem0', mode: 'memory', dry_run: true,
    })
    expect(await screen.findByTestId('transfer-dry-run-result')).toHaveTextContent('3 of 4 items would transfer.')
    expect(screen.getByText('ttl is not supported by mem0')).toBeInTheDocument()
    expect(screen.queryByText('at /memories')).not.toBeInTheDocument()
  })

  it('a real transfer writes and returns to the list', async () => {
    vi.mocked(memoriesApi.transfer).mockResolvedValue({ succeeded: 4, total_source: 4, warnings: [] } as any)
    renderAtRoute(<MemoryTransferPage />, { path: '/memories/transfer', paths: ['/memories'] })

    fireEvent.click(screen.getByLabelText(/Dry run/))
    fireEvent.click(screen.getByRole('button', { name: 'Transfer' }))
    await waitFor(() => expect(memoriesApi.transfer).toHaveBeenCalledWith(expect.objectContaining({ dry_run: false })))
    expect(await screen.findByText('at /memories')).toBeInTheDocument()
  })
})
