import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'

import { render } from '../../test/setup'
import { ModelsPage } from '../models'

vi.mock('@/components/models/catalog-tab', () => ({ CatalogTab: () => <div>catalog-tab-content</div> }))
vi.mock('@/components/models/deployments-tab', () => ({ DeploymentsTab: () => <div>deployments-tab-content</div> }))
vi.mock('@/components/models/versions-tab', () => ({ VersionsTab: () => <div>versions-tab-content</div> }))
vi.mock('@/pages/llm-providers', () => ({ LlmProvidersPage: ({ embedded }: { embedded?: boolean }) => <div>providers-tab-content {embedded ? 'embedded' : ''}</div> }))

const searchParams = { current: new URLSearchParams() }
const setSearchParams = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useSearchParams: () => [searchParams.current, setSearchParams],
  }
})

describe('ModelsPage', () => {
  let queryClient: QueryClient
  beforeEach(() => {
    vi.clearAllMocks()
    searchParams.current = new URLSearchParams()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  it('opens on the catalog with all four tabs', () => {
    render(<ModelsPage />, { queryClient })
    expect(screen.getByRole('heading', { name: 'Models' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Catalog' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Deployments' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Tracked artifacts' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Providers' })).toBeInTheDocument()
    expect(screen.getByText('catalog-tab-content')).toBeInTheDocument()
  })

  it('honours ?tab=providers and embeds the providers page', () => {
    searchParams.current = new URLSearchParams('tab=providers')
    render(<ModelsPage />, { queryClient })
    expect(screen.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText(/providers-tab-content embedded/)).toBeInTheDocument()
  })

  it('falls back to the catalog for an unknown tab', () => {
    searchParams.current = new URLSearchParams('tab=nope')
    render(<ModelsPage />, { queryClient })
    expect(screen.getByRole('tab', { name: 'Catalog' })).toHaveAttribute('aria-selected', 'true')
  })
})
