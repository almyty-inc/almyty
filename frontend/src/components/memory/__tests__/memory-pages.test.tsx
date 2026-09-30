import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'

import { renderAtRoute } from '../../../test/render-at-route'
import { MemoryNewPage } from '../../../pages/memory-new'
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

    fireEvent.change(screen.getByLabelText(/^What should your agents remember/), { target: { value: 'Prefers metric units' } })
    fireEvent.change(screen.getByLabelText(/^Tags/), { target: { value: 'user-pref, units ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }))

    await waitFor(() => expect(memoriesApi.put).toHaveBeenCalledTimes(1))
    expect(vi.mocked(memoriesApi.put).mock.calls[0][0]).toMatchObject({
      mode: 'memory',
      scope: { scope_type: 'workspace', scope_id: 'org-1' },
      content: 'Prefers metric units',
      tier: 'long',
      tags: ['user-pref', 'units'],
      source_uri: undefined,
    })
    expect(await screen.findByText('at /memories')).toBeInTheDocument()
    // Storing is what trips a soft cap: the warnings key must refresh too.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['memories', 'softcap-warnings', 'org-1'] })
  })

  it('refuses an empty memory and focuses the content field', async () => {
    renderAtRoute(<MemoryNewPage />, { path: '/memories/new' })
    fireEvent.click(screen.getByRole('button', { name: 'Save memory' }))
    expect(await screen.findByText('Write what the memory should hold.')).toBeInTheDocument()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(/^What should your agents remember/)))
    expect(memoriesApi.put).not.toHaveBeenCalled()
  })
})