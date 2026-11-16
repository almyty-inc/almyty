/**
 * A hand-made (Custom HTTP) API has no description, so it has no
 * operations: its tools were made by hand, each calling a path under its
 * address. The APIs list showed such an API as "1 tool, 0 operations" (on
 * staging: Northwind AI's npm registry and OpenAlex), and its header said
 * "0 tools generated" next to rows with tools. The list, its header and the
 * API page now say the same true thing.
 */
import { describe, it, expect, vi } from 'vitest'
import { render as rtlRender, screen } from '@testing-library/react'

import { render } from '@/test/setup'
import { createApisColumns } from '../apis-columns'
import { OverviewTab } from '../detail/overview-tab'
import { OperationsTab } from '../detail/operations-tab'
import { apisSummary, isManualHttp, MANUAL_OPERATIONS_LABEL } from '@/lib/api-operations'

vi.mock('@/lib/api', () => ({
  apisApi: { testConnection: vi.fn(), generateTools: vi.fn(), getOperationOutline: vi.fn() },
}))

// As GET /apis returns them: counts on the row, no schemas or operations.
const NPM = { id: 'api-npm', name: 'npm registry', type: 'http', baseUrl: 'https://registry.npmjs.org', operationCount: 0, toolCount: 1, hasDescription: false } as any
const OPENALEX = { id: 'api-oa', name: 'OpenAlex', type: 'http', baseUrl: 'https://api.openalex.org', operationCount: 0, toolCount: 1, hasDescription: false } as any
const METEO = { id: 'api-om', name: 'Open-Meteo', type: 'openapi', baseUrl: 'https://api.open-meteo.com', operationCount: 3, toolCount: 2, hasDescription: true } as any
// An imported API whose import has not made operations yet: a real 0.
const PENDING = { id: 'api-p', name: 'Pending', type: 'openapi', baseUrl: 'https://p.example.com', operationCount: 0, toolCount: 0, hasDescription: false } as any

const TOOLS = [
  { id: 't1', name: 'npm_package', apiId: 'api-npm', operationId: null },
  { id: 't2', name: 'openalex_works', apiId: 'api-oa', operationId: null },
  { id: 't3', name: 'get_forecast', apiId: 'api-om', operationId: 'op-1' },
  { id: 't4', name: 'get_archive', metadata: { sourceApi: { id: 'api-om' } }, operationId: 'op-2' },
  { id: 't5', name: 'standalone_js', operationId: null },
]

function operationsCell(api: any) {
  const noop = vi.fn()
  const columns = createApisColumns({
    allTools: TOOLS, onEdit: noop, onDelete: noop, onViewDetails: noop, onTestConnection: noop,
    onImportSchema: noop, onGenerateTools: noop, onCopyBaseUrl: noop,
  })
  const column = columns.find((c: any) => c.accessorKey === 'operations')!
  const Cell = column.cell as (ctx: any) => JSX.Element
  return rtlRender(<Cell row={{ original: api }} />).container
}

describe('a hand-made API on the APIs list', () => {
  it('says its tools were made by hand instead of "0 operations"', () => {
    const cell = operationsCell(NPM)
    expect(cell).toHaveTextContent(MANUAL_OPERATIONS_LABEL)
    expect(cell.textContent).not.toMatch(/^\s*0\s*$/)
    expect(cell.querySelector('[title]')?.getAttribute('title')).toMatch(/no description/i)
  })

  it('keeps the count for an API with a description, and a real 0 for one still to import', () => {
    expect(operationsCell(METEO)).toHaveTextContent(/^3$/)
    expect(operationsCell(PENDING)).toHaveTextContent(/^0$/)
  })

  it('knows a hand-made API from the list row alone', () => {
    expect(isManualHttp(NPM)).toBe(true)
    expect(isManualHttp(METEO)).toBe(false)
    expect(isManualHttp(PENDING)).toBe(false)
    // An HTTP API that has had a description imported is not hand-made.
    expect(isManualHttp({ ...NPM, hasDescription: true })).toBe(false)
  })
})

describe('the APIs page header', () => {
  it('counts every tool the rows count, and names the ones made by hand', () => {
    // Before: "4 APIs · 3 operations · 2 tools generated", while the
    // rows' Tools column added up to 4.
    expect(apisSummary([NPM, OPENALEX, METEO, PENDING], TOOLS)).toBe('4 APIs · 3 operations · 4 tools (2 made by hand)')
  })

  it('leaves out "made by hand" when every tool came from an operation', () => {
    expect(apisSummary([METEO], TOOLS)).toBe('1 API · 3 operations · 2 tools')
  })
})

describe('a hand-made API on its own page', () => {
  // The detail endpoint returns the operations relation; the page merges in its schemas.
  const API = { ...NPM, operationCount: undefined, hasDescription: undefined, operations: [], schemas: [] }
  const TOOL = { id: 't1', name: 'npm_package', apiId: 'api-npm' } as any

  it('says "Made by hand" on the Operations tile, as the list does', () => {
    render(
      <OverviewTab api={API} operations={[]} apiTools={[TOOL]} onOpenSchemaViewer={vi.fn()} onOpenAuthConfig={vi.fn()} onOpenSchemaImport={vi.fn()} />,
    )
    const stats = screen.getByTestId('api-stats')
    expect(stats).toHaveTextContent(`Operations${MANUAL_OPERATIONS_LABEL}`)
    expect(stats).not.toHaveTextContent(/Operations0/)
  })

  it('says so above the operations card instead of "0 operations parsed from schema"', () => {
    render(<OperationsTab api={API} operations={[]} apiTools={[TOOL]} onOpenSchemaImport={vi.fn()} />)
    expect(screen.queryByText(/0 operations parsed/)).not.toBeInTheDocument()
    expect(screen.getByText(new RegExp(`${MANUAL_OPERATIONS_LABEL}: no description`))).toBeInTheDocument()
  })

  it('keeps the count on an API with operations', () => {
    const meteo = { ...METEO, operations: [{ id: 'op-1' }], schemas: [{ id: 's1' }] }
    render(
      <OverviewTab api={meteo} operations={[{ id: 'op-1' } as any]} apiTools={[]} onOpenSchemaViewer={vi.fn()} onOpenAuthConfig={vi.fn()} onOpenSchemaImport={vi.fn()} />,
    )
    expect(screen.getByTestId('api-stats')).toHaveTextContent('Operations1')
  })
})
