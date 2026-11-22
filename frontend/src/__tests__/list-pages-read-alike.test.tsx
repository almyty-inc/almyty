/**
 * Defects from walking the list pages on staging (Nov 2026), each one a
 * place where one list said or drew something differently from the rest:
 *
 * - Gateways: "1 tools".
 * - APIs: the Auth column said "Api Key" where the API's own page says
 *   "API key", and Operations printed "1280" next to a header's "1,355".
 * - Tools: a runner tool's name was squeezed to "r…" by its badges.
 * - Runners and Credentials: a bare search box without the icon every
 *   other list has; on Runners the team filter sat alone on its own row.
 * - Agents: the status filter was the browser's own <select>, and the
 *   steps column was headed "Nodes".
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import type { ColumnDef } from '@tanstack/react-table'

import { render } from '@/test/setup'
import { DataTable } from '@/components/ui/data-table'
import { authTypeLabel } from '@/lib/api-operations'

const src = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8')

describe('list pages read alike', () => {
  it('names how an API key is sent the same way in the list and on the API', () => {
    expect(authTypeLabel('api_key')).toBe('API key')
    expect(authTypeLabel('oauth2')).toBe('OAuth 2.0')
    expect(authTypeLabel(undefined)).toBe('None')
    expect(authTypeLabel('custom_header')).toBe('Custom header')
    const columns = src('components/apis/apis-columns.tsx')
    expect(columns).toContain('authTypeLabel(auth)')
    expect(columns).not.toMatch(/c => c\.toUpperCase\(\)/)
    expect(columns).toContain("operationCount(api).toLocaleString('en-US')")
    expect(src('components/apis/detail/overview-tab.tsx')).toContain('authTypeLabel(api.authentication?.type)')
  })

  it('says "1 tool" on the gateway list', () => {
    const gateways = src('pages/gateways.tsx')
    expect(gateways).toContain("{pluralize(toolCount, 'tool')}")
    expect(gateways).not.toMatch(/<span className="text-muted-foreground">tools<\/span>/)
  })

  it('lets a tool name wrap its badges instead of shrinking to one letter', () => {
    const tools = src('pages/tools.tsx')
    expect(tools).toMatch(/data-testid="tool-name-row"/)
    expect(tools).toMatch(/className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="tool-name-row"/)
    expect(tools).not.toContain("'Model Tool'")
  })

  it('gives every DataTable search box the search icon and the row width', () => {
    interface Row { name: string }
    const columns: ColumnDef<Row, any>[] = [{ accessorKey: 'name', header: 'Name' }]
    render(<DataTable columns={columns} data={[{ name: 'a' }]} searchKey="name" searchPlaceholder="Search runners..." headerExtra={<div>team</div>} hideColumnsButton />)
    const box = screen.getByTestId('data-table-search')
    expect(box.querySelector('svg')).not.toBeNull()
    expect(box).toHaveClass('sm:flex-1')
    expect(screen.getByRole('textbox', { name: 'Search runners' })).toHaveClass('pl-10')
    // The filter shares the search's row.
    expect(screen.getByTestId('data-table-header')).toHaveTextContent('team')
  })

  it('puts the runners team filter in the table header, beside the search', () => {
    const runners = src('pages/runners.tsx')
    expect(runners).toMatch(/headerExtra=\{\s*<TeamFilter/)
    expect(runners).not.toMatch(/justify-end">\s*<TeamFilter/)
    expect(src('pages/credentials.tsx')).toContain('searchPlaceholder="Search credentials..."')
  })

  it('filters agents with the app dropdown and calls their steps steps', () => {
    const agents = src('pages/agents.tsx')
    expect(agents).not.toMatch(/<select\b/)
    expect(agents).toMatch(/<SelectTrigger[^>]*aria-label="Status"/)
    expect(agents).not.toMatch(/>Nodes</)
    expect(agents).toMatch(/>Steps</)
  })
})
