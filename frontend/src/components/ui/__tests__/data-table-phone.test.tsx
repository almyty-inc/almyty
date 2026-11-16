import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import type { ColumnDef } from '@tanstack/react-table'
import { render } from '../../../test/setup'
import { DataTable, createActionsColumn, PINNED_ACTIONS } from '../data-table'

interface Row { id: string; name: string }
const rows: Row[] = [{ id: '1', name: 'Item 1' }, { id: '2', name: 'Item 2' }]
const columns: ColumnDef<Row, any>[] = [
  { accessorKey: 'name', header: 'Name' },
  createActionsColumn<Row>(() => {}, () => {}),
]

/**
 * At 390px the list pages (/tools, /apis, /gateways, /runners) pushed
 * their filters and row menus past the screen edge. The header row now
 * wraps, and the row menu column is pinned to the table's right edge.
 */
describe('DataTable on a phone', () => {
  it('wraps the header row instead of widening the page', () => {
    render(<DataTable columns={columns} data={rows} headerExtra={<div>filters</div>} />)
    expect(screen.getByTestId('data-table-header')).toHaveClass('flex-wrap')
  })

  it('pins the row menu column to the right edge', () => {
    render(<DataTable columns={columns} data={rows} hideColumnsButton />)
    const menus = screen.getAllByRole('button', { name: 'Actions' })
    expect(menus).toHaveLength(2)
    for (const menu of menus) {
      const cell = menu.closest('td')!
      for (const cls of PINNED_ACTIONS.split(' ')) expect(cell).toHaveClass(cls)
    }
    const headCells = screen.getAllByRole('columnheader')
    expect(headCells[headCells.length - 1]).toHaveClass('sticky', 'right-0')
  })

  it('leaves the other columns unpinned', () => {
    render(<DataTable columns={columns} data={rows} hideColumnsButton />)
    expect(screen.getByText('Item 1').closest('td')).not.toHaveClass('sticky')
  })
})
