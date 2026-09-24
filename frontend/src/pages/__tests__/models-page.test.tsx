import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { screen } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { ModelsPage } from '../models'

vi.mock('@/components/models/models-catalog', () => ({
  ModelsCatalog: () => <div>catalog-content</div>,
}))

const searchParams = { current: new URLSearchParams() }
const setSearchParams = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useSearchParams: () => [searchParams.current, setSearchParams],
    Navigate: ({ to }: { to: string }) => <div>navigate:{to}</div>,
  }
})

describe('ModelsPage', () => {
  let queryClient: QueryClient
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams.current = new URLSearchParams()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it('is the list of models, with no tabs', () => {
    render(<ModelsPage />, { queryClient })
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument()
    expect(screen.getByText(/catalog-content/)).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    expect(screen.queryByText(/Deployments|Tracked artifacts/)).not.toBeInTheDocument()
  })

  it('has one Add model entry, a page of its own, and links to Inference providers rather than embedding them', () => {
    render(<ModelsPage />, { queryClient })
    expect(screen.getByRole('link', { name: /Inference providers/ })).toHaveAttribute('href', '/llm-providers')
    const add = screen.getAllByRole('link', { name: /Add model/ })
    expect(add).toHaveLength(1)
    expect(add[0]).toHaveAttribute('href', '/models/new')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('sends ?new=1 from the command palette to the Add model page', () => {
    searchParams.current = new URLSearchParams('new=1')
    render(<ModelsPage />, { queryClient })
    expect(screen.getByText('navigate:/models/new')).toBeInTheDocument()
  })

  it('sends an old ?tab=providers link to the Inference providers page, keeping ?new=1', () => {
    searchParams.current = new URLSearchParams('tab=providers&new=1')
    render(<ModelsPage />, { queryClient })
    expect(screen.getByText('navigate:/llm-providers?new=1')).toBeInTheDocument()
  })

  it('folds any other old tab link back into the list', () => {
    searchParams.current = new URLSearchParams('tab=deployments')
    render(<ModelsPage />, { queryClient })
    expect(screen.getByText('navigate:/models')).toBeInTheDocument()
  })
})

describe('the Models page source', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8')

  it('never embeds a second copy of the Inference providers page', () => {
    const source = read('models.tsx')
    expect(source).not.toMatch(/from '@\/pages\/llm-providers'/)
    expect(source).not.toMatch(/LlmProvidersPage/)
    expect(read('llm-providers.tsx')).not.toMatch(/embedded/)
  })

  it('has no nested lazy tab chunks: the list renders in the page chunk itself', () => {
    // A lazy child inside the lazily loaded page meant a second suspension
    // on the first client-side visit.
    const source = read('models.tsx')
    expect(source).not.toMatch(/lazy\(/)
    expect(source).not.toMatch(/<Tabs/)
  })
})
