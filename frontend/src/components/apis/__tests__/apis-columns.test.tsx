/**
 * The APIs list's name cell. On a phone the visibility badge ran past the
 * cell and was cut off; the name line now wraps and the badge never shrinks.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

import { createApisColumns } from '../apis-columns'

describe('APIs list name cell', () => {
  it('wraps the name and keeps the visibility badge whole', () => {
    const noop = vi.fn()
    const [nameColumn] = createApisColumns({
      allTools: [], onEdit: noop, onDelete: noop, onViewDetails: noop, onTestConnection: noop,
      onImportSchema: noop, onGenerateTools: noop, onCopyBaseUrl: noop,
    })
    const api = { id: 'a1', name: 'Open-Meteo Weather Forecast', type: 'openapi', baseUrl: 'https://api.open-meteo.com', visibility: 'org' }
    const Cell = nameColumn.cell as (ctx: any) => JSX.Element
    render(<Cell row={{ original: api }} />)

    const line = screen.getByTestId('api-name-line')
    expect(line.className).toMatch(/\bflex-wrap\b/)
    const badge = line.lastElementChild as HTMLElement
    expect(badge.className).toMatch(/\bshrink-0\b/)
    expect(badge).toHaveTextContent(/org/i)
    // The text column may shrink below its content, so the address truncates instead of pushing the row wider.
    expect(line.parentElement!.className).toMatch(/\bmin-w-0\b/)
    expect(screen.getByText('https://api.open-meteo.com').className).toMatch(/\btruncate\b/)
  })
})
