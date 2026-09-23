import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Bot } from 'lucide-react'

import { EmptyState, EMPTY_STATE_PANEL_CLASSES } from '../empty-state'
import { PageHeader } from '@/components/layout/page-header'

describe('EmptyState', () => {
  it('draws its own card surface as a panel', () => {
    render(<EmptyState variant="panel" icon={Bot} title="No agents yet" />)
    const box = screen.getByRole('status')
    expect(box).toHaveAttribute('data-variant', 'panel')
    for (const cls of EMPTY_STATE_PANEL_CLASSES.split(' ')) expect(box).toHaveClass(cls)
  })

  it('stays bare inline, for use inside a surface that already exists', () => {
    render(<EmptyState icon={Bot} title="No runs yet" />)
    const box = screen.getByRole('status')
    expect(box).toHaveAttribute('data-variant', 'inline')
    expect(box).not.toHaveClass('border', 'bg-card')
  })

  it('always circles the icon in a badge that is visible on any surface', () => {
    // The badge was `bg-muted/40` with a faint border: on the page
    // background (itself muted) it disappeared, so Apps showed a bare icon
    // where Agents showed a badge.
    render(<EmptyState icon={Bot} title="No agents yet" />)
    const badge = screen.getByTestId('empty-state-icon')
    expect(badge).toHaveClass('rounded-full', 'bg-muted', 'border-border')
    expect(badge.className).not.toMatch(/bg-muted\/|border-border\//)
  })
})

describe('PageHeader', () => {
  it('stacks the actions under the title on phones and wraps them', () => {
    render(
      <PageHeader title="Agents" description="3 agents" actions={<button type="button">Create agent</button>} />,
    )
    const title = screen.getByRole('heading', { level: 1, name: 'Agents' })
    const header = title.parentElement!.parentElement!
    expect(header).toHaveClass('flex-col', 'sm:flex-row')
    const actions = screen.getByRole('button', { name: 'Create agent' }).parentElement!
    expect(actions).toHaveClass('flex-wrap')
    expect(screen.getByText('3 agents')).toBeInTheDocument()
  })
})
