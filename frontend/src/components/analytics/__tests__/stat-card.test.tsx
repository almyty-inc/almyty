import { describe, it, expect } from 'vitest'
import { Bot } from 'lucide-react'

import { render, screen } from '../../../test/setup'
import { StatCard } from '../stat-card'

/**
 * There used to be two StatCards — this one and an unused
 * components/ui/stat-card.tsx — disagreeing on padding, radius and type
 * scale. The dead one is gone; this one has to sit in the same grid as
 * <Card>s, so it takes the house radius from components/ui/card.tsx.
 */
describe('the analytics stat card', () => {
  it('uses the house card radius, not a smaller one', () => {
    render(<StatCard icon={Bot} label="Executions (24h)" value="42" />)

    const tile = screen.getByText('Executions (24h)').closest('div')?.parentElement as HTMLElement
    expect(tile.className).toContain('rounded-xl')
    expect(tile.className).not.toContain('rounded-lg')
  })
})
