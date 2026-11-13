import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { Tabs, TabsList, TabsTrigger } from '../tabs'

// An agent has eight sections. On a 390px phone a scrolling strip hid the
// last three behind a sideways swipe; both list looks wrap instead, so every
// tab stays on screen.
const SECTIONS = ['Overview', 'Runs', 'Execution', 'Memory', 'Files', 'Channels', 'Skills', 'Constraints']

describe.each(['underline', 'segmented'] as const)('TabsList (%s)', (variant) => {
  it('wraps its tabs instead of scrolling sideways', () => {
    render(
      <Tabs defaultValue="overview">
        <TabsList variant={variant} aria-label="Agent sections">
          {SECTIONS.map((s) => (
            <TabsTrigger key={s} value={s.toLowerCase()}>{s}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>,
    )
    const list = screen.getByRole('tablist', { name: 'Agent sections' })
    const classes = list.className.split(/\s+/)
    expect(classes).toContain('flex-wrap')
    expect(classes.some((c) => /^overflow-x-(auto|scroll)$/.test(c))).toBe(false)
    // A fixed height would clip the second row.
    expect(classes).not.toContain('h-10')
    expect(screen.getAllByRole('tab')).toHaveLength(SECTIONS.length)
  })
})
