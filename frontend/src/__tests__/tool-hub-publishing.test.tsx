import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../test/setup'

const notify = { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }
vi.mock('@/store/app', () => ({ useNotifications: () => notify }))
vi.mock('@/store/organization', () => ({
  useOrganizationStore: (sel?: any) => {
    const state = {
      currentOrganization: { id: 'org-1', name: 'Acme' },
      organizations: [],
      setCurrentOrganization: vi.fn(),
    }
    return typeof sel === 'function' ? sel(state) : state
  },
}))

vi.mock('@/lib/api', () => ({
  toolHubApi: {
    getProviders: vi.fn(),
    getTemplates: vi.fn(),
    getCategories: vi.fn(),
    installTemplate: vi.fn(),
    installProvider: vi.fn(),
    deleteTemplate: vi.fn(),
  },
}))

import { toolHubApi } from '@/lib/api'
import { ToolHubPage } from '../pages/tool-hub'

const ownTemplate = {
  id: 'tpl-own',
  name: 'List widgets',
  description: 'List every widget',
  provider: 'Acme API',
  category: 'commerce',
  tags: ['widgets'],
  executionMethod: 'http',
  parameters: {},
  configuration: {},
  examples: [],
  isBuiltIn: false,
  organizationId: 'org-1',
  version: '1.0.0',
  installCount: 3,
  createdAt: '2026-06-01T00:00:00Z',
}

const publicTemplate = {
  ...ownTemplate,
  id: 'tpl-public',
  name: 'Weather forecast',
  provider: 'Open-Meteo',
  organizationId: null,
  installCount: 0,
}

/**
 * The hub reads the shape the backend actually sends, and shows an
 * organization what it published.
 *
 * `GET /tool-hub/providers` answers `{ provider, providerIcon, count }`
 * and `GET /tool-hub/categories` answers `{ category, count }`. The page
 * read `name` / `templateCount` and a bare string, which no response has
 * ever carried -- invisible while the hub was empty, and wrong the moment
 * anything was published into it.
 */
describe('Tool Hub', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(toolHubApi.getProviders as any).mockResolvedValue([
      { provider: 'Acme API', providerIcon: null, count: 1 },
    ])
    ;(toolHubApi.getCategories as any).mockResolvedValue([{ category: 'commerce', count: 1 }])
    ;(toolHubApi.getTemplates as any).mockResolvedValue({
      templates: [ownTemplate, publicTemplate],
      total: 2,
    })
  })
  it('renders provider and category rollups in the shape the backend sends', async () => {
    render(<ToolHubPage />)

    // Read as `provider` / `count`; reading `name` / `templateCount`
    // renders an undefined heading and "undefined tools".
    await waitFor(() => expect(screen.getAllByText('Acme API').length).toBeGreaterThan(0))
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument()
    expect(
      screen.getByText((_, el) => el?.textContent === '1 tool' && el?.tagName === 'P'),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /commerce/i })).toBeInTheDocument()
  })

  it('separates what this organization published from the public catalogue', async () => {
    render(<ToolHubPage />)

    expect(await screen.findByText(/published by your organization/i)).toBeInTheDocument()
    // Only the org-owned one is retractable: a public template belongs to
    // every tenant and no tenant may pull it.
    expect(screen.getByLabelText('Retract List widgets')).toBeInTheDocument()
    expect(screen.queryByLabelText('Retract Weather forecast')).not.toBeInTheDocument()
  })

  it('retracts a template the organization published', async () => {
    ;(toolHubApi.deleteTemplate as any).mockResolvedValue({ id: 'tpl-own' })

    render(<ToolHubPage />)

    fireEvent.click(await screen.findByLabelText('Retract List widgets'))
    fireEvent.click(await screen.findByRole('button', { name: /^retract template$/i }))

    await waitFor(() => expect(toolHubApi.deleteTemplate).toHaveBeenCalledWith('tpl-own'))
  })

  it('points an empty hub at publishing rather than at the backend', async () => {
    ;(toolHubApi.getProviders as any).mockResolvedValue([])
    ;(toolHubApi.getCategories as any).mockResolvedValue([])
    ;(toolHubApi.getTemplates as any).mockResolvedValue({ templates: [], total: 0 })

    render(<ToolHubPage />)

    // The old copy said templates appear "once they are configured on the
    // backend", which was true and useless: nothing configured them.
    expect(await screen.findByText(/nothing published yet/i)).toBeInTheDocument()
    expect(screen.getByText(/publish to hub/i)).toBeInTheDocument()
  })
})

/**
 * A feature nothing reaches is the dominant defect here, and the hub was
 * the example: correct code, wired end to end, with no caller. This reads
 * the page source rather than mounting it -- mounting the tools page pulls
 * in CodeMirror and the data table -- and checks the publish action is
 * actually on the row and the publish page is actually routed.
 */
describe('publishing is reachable from the tools page', () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8')
  const source = read('pages/tools.tsx')

  it('offers Publish to hub in the row menu, gated on the tool being publishable', () => {
    expect(source).toContain('isPublishable(tool)')
    expect(source).toContain('navigate(`/tools/${tool.id}/publish`)')
    expect(source).toMatch(/Publish to hub/)
  })

  it('the publish page is routed and renders the form', () => {
    expect(read('App.tsx')).toMatch(/path="\/tools\/:id\/publish" element=\{<ToolPublishPage \/>\}/)
    const page = read('pages/tool-publish.tsx')
    expect(page).toMatch(/<PublishToolForm\b/)
    expect(page).toContain("from '@/components/tools/publish-tool-form'")
  })

  it('the tool page links to it too', () => {
    const detail = read('pages/tool-detail.tsx')
    expect(detail).toContain('isPublishable(tool)')
    expect(detail).toContain('/publish`')
  })
})
