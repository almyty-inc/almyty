import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { readFileSync } from 'fs'
import { join } from 'path'

import { render } from '../../test/setup'
import { MemoriesPage } from '../memories'
import { memoriesApi } from '../../lib/api'

// Regression for #108. memoriesApi.list() goes through apiPost which
// already extracts the {success, data} envelope to the raw payload
// (`{items, next_cursor}`). The page used to read
// list.data?.data?.items — the second `.data` was always undefined,
// so even when the API returned rows the page rendered the empty
// state ("No memory items"). The fix dropped the extra hop to
// list.data?.items; this test pins that path.

vi.mock('../../lib/api', () => ({
  memoriesApi: {
    list: vi.fn(),
    search: vi.fn(),
    put: vi.fn(),
    remove: vi.fn(),
    supersede: vi.fn(),
    listBackends: vi.fn(),
    backendsHealth: vi.fn(),
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getById: vi.fn(),
    transfer: vi.fn(),
    listAudit: vi.fn(),
    listCredentials: vi.fn(),
    runConsolidation: vi.fn(),
  },
}))

vi.mock('../../store/app', () => ({
  useNotifications: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock('../../store/organization', () => ({
  useOrganizationStore: () => ({
    currentOrganization: { id: 'org-test' },
  }),
}))

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useLocation: () => ({ pathname: '/memories', search: '', hash: '', state: null }),
  }
})

describe('MemoriesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
      Element.prototype.setPointerCapture = vi.fn()
      Element.prototype.releasePointerCapture = vi.fn()
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = vi.fn()
    }
  })

  it('renders a memory item when memoriesApi.list returns the post-extractData {items} shape', async () => {
    ;(memoriesApi.list as any).mockResolvedValue({
      items: [
        {
          id: 'mem-1',
          content: 'The user prefers Yosemite over Yellowstone for camping trips.',
          tier: 'long',
          mode: 'memory',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: [],
          metadata: {},
          scope: { scope_type: 'org', scope_id: 'org-test' },
        },
      ],
      next_cursor: null,
    })
    ;(memoriesApi.listBackends as any).mockResolvedValue([])
    ;(memoriesApi.backendsHealth as any).mockResolvedValue([])
    ;(memoriesApi.getConfig as any).mockResolvedValue({})

    render(<MemoriesPage />)

    await waitFor(() => {
      expect(
        screen.getByText('The user prefers Yosemite over Yellowstone for camping trips.'),
      ).toBeInTheDocument()
    })
  })

  // The trash button sits right next to the memory body, so a single stray
  // click used to soft-delete a memory with no confirm and no way back.
  it('confirms before deleting a memory rather than deleting on the first click', async () => {
    ;(memoriesApi.list as any).mockResolvedValue({
      items: [
        {
          id: 'mem-1',
          content: 'The user prefers Yosemite over Yellowstone for camping trips.',
          tier: 'long',
          mode: 'memory',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          tags: [],
          metadata: {},
          scope: { scope_type: 'org', scope_id: 'org-test' },
        },
      ],
      next_cursor: null,
    })
    ;(memoriesApi.listBackends as any).mockResolvedValue([])
    ;(memoriesApi.backendsHealth as any).mockResolvedValue([])
    ;(memoriesApi.getConfig as any).mockResolvedValue({})
    ;(memoriesApi.remove as any).mockResolvedValue({})

    render(<MemoriesPage />)

    await screen.findByText(
      'The user prefers Yosemite over Yellowstone for camping trips.',
    )
    fireEvent.click(screen.getByTitle('Delete memory'))

    const dialog = await screen.findByRole('alertdialog')
    expect(dialog).toHaveTextContent('Delete memory?')
    expect(memoriesApi.remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Delete Memory/i }))

    await waitFor(() => {
      expect(memoriesApi.remove).toHaveBeenCalledWith('mem-1', 'soft')
    })
  })
})

// Adding memory is a page, not a dialog: the buttons that used to open it
// are links. Moving memories to another service is an operator's job, so
// it sits under Storage > Advanced rather than next to Add memory.
describe('MemoriesPage entry points', () => {
  beforeEach(() => {
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
      Element.prototype.setPointerCapture = vi.fn()
      Element.prototype.releasePointerCapture = vi.fn()
    }
  })

  it('links Add memory (header and empty state) to its page', async () => {
    ;(memoriesApi.list as any).mockResolvedValue({ items: [], next_cursor: null })
    ;(memoriesApi.listBackends as any).mockResolvedValue([])
    render(<MemoriesPage />)

    await screen.findByText('No memories yet')
    const add = screen.getAllByRole('link', { name: /Add memory/i })
    expect(add).toHaveLength(2)
    for (const link of add) expect(link).toHaveAttribute('href', '/memories/new')
    expect(screen.queryByRole('link', { name: /Transfer|Move memories/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps where memories live on Storage, and the operator detail under Advanced', async () => {
    ;(memoriesApi.list as any).mockResolvedValue({ items: [], next_cursor: null })
    ;(memoriesApi.listBackends as any).mockResolvedValue([
      { id: 'almyty-native', capabilities: ['bi_temporal'], modes: ['memory', 'document'] },
      { id: 'mem0', capabilities: [], modes: ['memory'] },
    ])
    ;(memoriesApi.getConfig as any).mockResolvedValue(null)
    ;(memoriesApi.backendsHealth as any).mockResolvedValue({})
    render(<MemoriesPage />)

    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Memories', 'Search', 'Storage'])
    const storage = screen.getByRole('tab', { name: 'Storage' })
    fireEvent.mouseDown(storage)
    fireEvent.click(storage)

    expect(await screen.findByText('Where memories are kept')).toBeInTheDocument()
    expect(screen.getByLabelText('Memory service')).toBeInTheDocument()
    expect(screen.queryByLabelText('When a memory is over the size limit')).not.toBeInTheDocument()
    expect(screen.queryByText(/embedding|namespace|soft-cap/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Advanced/ }))
    expect(screen.getByLabelText('When a memory is over the size limit')).toBeInTheDocument()
    expect(screen.getByLabelText('Also copy memories to')).toBeInTheDocument()
    expect((await screen.findAllByText(/^Mem0( account)?$/)).length).toBeGreaterThan(0)
    expect(screen.getByRole('link', { name: /Move memories to another service/ })).toHaveAttribute('href', '/memories/transfer')
  })
})

describe('memory page copy', () => {
  it('uses no storage-engine jargon in what it renders', () => {
    // Visible text only: JSX text between tags and the string props a
    // person reads. Comments and identifiers may say what they like.
    const src = readFileSync(join(__dirname, '..', 'memories.tsx'), 'utf8')
    const JARGON = /\b(embedding|namespace|scopes?|backends?|vector|FTS|soft-cap|consolidat\w*|canonical|mode)\b/i
    const offenders: string[] = []
    for (const m of src.matchAll(/>([^<>{}]+)</g)) if (JARGON.test(m[1])) offenders.push(m[1].trim())
    for (const m of src.matchAll(/\b(?:placeholder|title|description|label|summary|aria-label)=["']([^"']+)["']/g)) {
      if (JARGON.test(m[1])) offenders.push(m[1])
    }
    expect(offenders).toEqual([])
  })
})
