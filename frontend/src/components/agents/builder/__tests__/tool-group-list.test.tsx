import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'

import { ToolGroupList } from '../autonomous-config'

const tools = [{ id: 't1', name: 'e2e_forecast_get_forecast', description: 'Get the forecast' }]

function Harness({ onSelected }: { onSelected?: (ids: string[]) => void }) {
  const [selected, setSelected] = useState<string[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  return (
    <ToolGroupList
      tools={tools}
      toolSearch=""
      selectedIds={selected}
      onSelectedIdsChange={(ids) => {
        setSelected(ids)
        onSelected?.(ids)
      }}
      expandedGroups={expanded}
      onExpandedGroupsChange={setExpanded}
    />
  )
}

describe('ToolGroupList (an autonomous agent picking its tools)', () => {
  it('keeps Select all out of the expand control', () => {
    const { container } = render(<Harness />)
    expect(container.querySelectorAll('button button, [role="button"] button')).toHaveLength(0)
  })

  it('selects a group without expanding it, and expands with the header', async () => {
    const user = userEvent.setup()
    let picked: string[] = []
    render(<Harness onSelected={(ids) => (picked = ids)} />)
    const header = screen.getByRole('button', { name: /^Other/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')

    await user.click(screen.getByRole('button', { name: 'Select all in Other' }))
    expect(picked).toEqual(['t1'])
    expect(header).toHaveAttribute('aria-expanded', 'false')

    await user.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('checkbox')).toBeChecked()
  })
})
