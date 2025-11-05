import { describe, it, expect, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../../test/setup'
import { DataTable, createSelectColumn, createActionsColumn, createSortableColumn } from '../data-table'
import { ColumnDef } from '@tanstack/react-table'

interface TestData {
  id: string
  name: string
  status: string
  count: number
}

const mockData: TestData[] = [
  { id: '1', name: 'Item 1', status: 'active', count: 10 },
  { id: '2', name: 'Item 2', status: 'inactive', count: 25 },
  { id: '3', name: 'Item 3', status: 'active', count: 5 },
]

const basicColumns: ColumnDef<TestData>[] = [
  {
    accessorKey: 'name',
    header: 'Name',
  },
  {
    accessorKey: 'status',
    header: 'Status',
  },
  {
    accessorKey: 'count',
    header: 'Count',
  },
]

describe('DataTable', () => {
  describe('Basic Functionality', () => {
    it('should render table with data', () => {
      render(
        <DataTable
          columns={basicColumns}
          data={mockData}
        />
      )

      // Check headers
      expect(screen.getByText('Name')).toBeInTheDocument()
      expect(screen.getByText('Status')).toBeInTheDocument()
      expect(screen.getByText('Count')).toBeInTheDocument()

      // Check data
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('Item 2')).toBeInTheDocument()
      expect(screen.getByText('active')).toBeInTheDocument()
      expect(screen.getByText('inactive')).toBeInTheDocument()
    })

    it('should show empty state when no data', () => {
      render(
        <DataTable
          columns={basicColumns}
          data={[]}
          emptyMessage="No items found"
        />
      )

      expect(screen.getByText('No items found')).toBeInTheDocument()
    })

    it('should show default empty message', () => {
      render(
        <DataTable
          columns={basicColumns}
          data={[]}
        />
      )

      expect(screen.getByText('No results found')).toBeInTheDocument()
    })
  })

  describe('Search Functionality', () => {
    it('should show search input when searchKey is provided', () => {
      render(
        <DataTable
          columns={basicColumns}
          data={mockData}
          searchKey="name"
          searchPlaceholder="Search items..."
        />
      )

      expect(screen.getByPlaceholderText('Search items...')).toBeInTheDocument()
    })

    it('should filter data based on search input', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={basicColumns}
          data={mockData}
          searchKey="name"
        />
      )

      const searchInput = screen.getByRole('textbox')
      await user.type(searchInput, 'Item 1')

      // Should only show Item 1
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.queryByText('Item 2')).not.toBeInTheDocument()
      expect(screen.queryByText('Item 3')).not.toBeInTheDocument()
    })

    it('should show no results when search has no matches', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={basicColumns}
          data={mockData}
          searchKey="name"
        />
      )

      const searchInput = screen.getByRole('textbox')
      await user.type(searchInput, 'NonExistent')

      expect(screen.getByText('No results found')).toBeInTheDocument()
    })
  })

  describe('Pagination', () => {
    const largeDataset = Array.from({ length: 25 }, (_, i) => ({
      id: `${i + 1}`,
      name: `Item ${i + 1}`,
      status: i % 2 === 0 ? 'active' : 'inactive',
      count: i + 1,
    }))

    it('should show pagination when data exceeds page size', () => {
      render(
        <DataTable
          columns={basicColumns}
          data={largeDataset}
          pageSize={10}
        />
      )

      // Should show pagination controls
      expect(screen.getByText('Previous')).toBeInTheDocument()
      expect(screen.getByText('Next')).toBeInTheDocument()
      expect(screen.getByText('Page 1 of 3')).toBeInTheDocument()
    })

    it('should navigate between pages', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={basicColumns}
          data={largeDataset}
          pageSize={10}
        />
      )

      // Should show first 10 items
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('Item 10')).toBeInTheDocument()
      expect(screen.queryByText('Item 11')).not.toBeInTheDocument()

      // Go to next page
      await user.click(screen.getByText('Next'))

      // Should show next 10 items
      expect(screen.queryByText('Item 1')).not.toBeInTheDocument()
      expect(screen.getByText('Item 11')).toBeInTheDocument()
      expect(screen.getByText('Item 20')).toBeInTheDocument()
    })

    it('should change page size', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={basicColumns}
          data={largeDataset}
          pageSize={10}
        />
      )

      // Change page size
      const pageSizeSelect = screen.getByDisplayValue('10')
      await user.selectOptions(pageSizeSelect, '20')

      // Should show 20 items
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('Item 20')).toBeInTheDocument()
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument()
    })
  })

  describe('Sorting', () => {
    const columnsWithSorting: ColumnDef<TestData>[] = [
      createSortableColumn<TestData>('name', 'Name'),
      createSortableColumn<TestData>('count', 'Count'),
      {
        accessorKey: 'status',
        header: 'Status',
      },
    ]

    it('should show sort indicators on sortable columns', () => {
      render(
        <DataTable
          columns={columnsWithSorting}
          data={mockData}
        />
      )

      // Sortable columns should have sort indicators
      expect(screen.getByRole('button', { name: /Name.*sort/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Count.*sort/i })).toBeInTheDocument()
    })

    it('should sort data when clicking column header', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={columnsWithSorting}
          data={mockData}
        />
      )

      // Get all rows initially (should be in original order)
      const rowsBefore = screen.getAllByRole('row')
      expect(rowsBefore[1]).toHaveTextContent('Item 1')
      expect(rowsBefore[2]).toHaveTextContent('Item 2')
      expect(rowsBefore[3]).toHaveTextContent('Item 3')

      // Click name header to sort
      await user.click(screen.getByRole('button', { name: /Name.*sort/i }))

      // Should still be in same order (A-Z is natural)
      const rowsAfter = screen.getAllByRole('row')
      expect(rowsAfter[1]).toHaveTextContent('Item 1')
      expect(rowsAfter[2]).toHaveTextContent('Item 2')
      expect(rowsAfter[3]).toHaveTextContent('Item 3')

      // Click again to reverse sort
      await user.click(screen.getByRole('button', { name: /Name.*sort/i }))

      const rowsReversed = screen.getAllByRole('row')
      expect(rowsReversed[1]).toHaveTextContent('Item 3')
      expect(rowsReversed[2]).toHaveTextContent('Item 2')
      expect(rowsReversed[3]).toHaveTextContent('Item 1')
    })

    it('should sort numeric columns correctly', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={columnsWithSorting}
          data={mockData}
        />
      )

      // Click count header to sort
      await user.click(screen.getByRole('button', { name: /Count.*sort/i }))

      // Should be sorted by count ascending (5, 10, 25)
      const rows = screen.getAllByRole('row')
      expect(rows[1]).toHaveTextContent('Item 3') // count: 5
      expect(rows[2]).toHaveTextContent('Item 1') // count: 10
      expect(rows[3]).toHaveTextContent('Item 2') // count: 25
    })
  })

  describe('Selection', () => {
    const columnsWithSelection: ColumnDef<TestData>[] = [
      createSelectColumn<TestData>(),
      ...basicColumns,
    ]

    it('should show select checkboxes when select column is included', () => {
      render(
        <DataTable
          columns={columnsWithSelection}
          data={mockData}
        />
      )

      // Should have select all checkbox in header
      const checkboxes = screen.getAllByRole('checkbox')
      expect(checkboxes).toHaveLength(4) // 1 select all + 3 row checkboxes
    })

    it('should select individual rows', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={columnsWithSelection}
          data={mockData}
        />
      )

      const checkboxes = screen.getAllByRole('checkbox')
      const firstRowCheckbox = checkboxes[1] // Skip select all

      await user.click(firstRowCheckbox)

      expect(firstRowCheckbox).toBeChecked()

      // Should show selection count
      expect(screen.getByText('1 of 3 row(s) selected')).toBeInTheDocument()
    })

    it('should select all rows', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={columnsWithSelection}
          data={mockData}
        />
      )

      const selectAllCheckbox = screen.getAllByRole('checkbox')[0]
      await user.click(selectAllCheckbox)

      // All row checkboxes should be checked
      const checkboxes = screen.getAllByRole('checkbox')
      checkboxes.slice(1).forEach(checkbox => {
        expect(checkbox).toBeChecked()
      })

      expect(screen.getByText('3 of 3 row(s) selected')).toBeInTheDocument()
    })
  })

  describe('Actions Column', () => {
    const mockEdit = vi.fn()
    const mockDelete = vi.fn()
    const mockCustomAction = vi.fn()

    const columnsWithActions: ColumnDef<TestData>[] = [
      ...basicColumns,
      createActionsColumn<TestData>(
        mockEdit,
        mockDelete,
        [
          {
            label: 'Custom Action',
            onClick: mockCustomAction,
          },
        ]
      ),
    ]

    beforeEach(() => {
      vi.clearAllMocks()
    })

    it('should show actions dropdown', () => {
      render(
        <DataTable
          columns={columnsWithActions}
          data={mockData}
        />
      )

      // Should have action buttons for each row
      const actionButtons = screen.getAllByRole('button', { name: /actions/i })
      expect(actionButtons).toHaveLength(mockData.length)
    })

    it('should call edit action', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={columnsWithActions}
          data={mockData}
        />
      )

      const firstActionButton = screen.getAllByRole('button', { name: /actions/i })[0]
      await user.click(firstActionButton)

      // Should see action menu
      expect(screen.getByText('Edit')).toBeInTheDocument()
      
      await user.click(screen.getByText('Edit'))
      
      expect(mockEdit).toHaveBeenCalledWith(mockData[0])
    })

    it('should call delete action', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={columnsWithActions}
          data={mockData}
        />
      )

      const firstActionButton = screen.getAllByRole('button', { name: /actions/i })[0]
      await user.click(firstActionButton)

      await user.click(screen.getByText('Delete'))
      
      expect(mockDelete).toHaveBeenCalledWith(mockData[0])
    })

    it('should call custom actions', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={columnsWithActions}
          data={mockData}
        />
      )

      const firstActionButton = screen.getAllByRole('button', { name: /actions/i })[0]
      await user.click(firstActionButton)

      await user.click(screen.getByText('Custom Action'))
      
      expect(mockCustomAction).toHaveBeenCalledWith(mockData[0])
    })
  })

  describe('Loading State', () => {
    it('should show loading state when isLoading is true', () => {
      render(
        <DataTable
          columns={basicColumns}
          data={[]}
          isLoading={true}
        />
      )

      expect(screen.getByText('Loading...')).toBeInTheDocument()
    })
  })

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(
        <DataTable
          columns={basicColumns}
          data={mockData}
          searchKey="name"
        />
      )

      // Table should have proper role
      expect(screen.getByRole('table')).toBeInTheDocument()
      
      // Search should have proper label
      expect(screen.getByLabelText(/search/i)).toBeInTheDocument()
    })

    it('should support keyboard navigation', async () => {
      const user = userEvent.setup()
      
      render(
        <DataTable
          columns={basicColumns}
          data={mockData}
          searchKey="name"
        />
      )

      const searchInput = screen.getByRole('textbox')
      
      // Should be able to tab to search input
      await user.tab()
      expect(searchInput).toHaveFocus()

      // Should be able to type
      await user.type(searchInput, 'Item 1')
      expect(searchInput).toHaveValue('Item 1')
    })
  })

  describe('Error Handling', () => {
    it('should handle malformed data gracefully', () => {
      const malformedData = [
        { id: '1', name: 'Item 1' }, // missing status and count
        { id: '2', status: 'active', count: 10 }, // missing name
      ]

      render(
        <DataTable
          columns={basicColumns}
          data={malformedData as TestData[]}
        />
      )

      // Should not crash
      expect(screen.getByText('Item 1')).toBeInTheDocument()
      expect(screen.getByText('active')).toBeInTheDocument()
    })
  })
});