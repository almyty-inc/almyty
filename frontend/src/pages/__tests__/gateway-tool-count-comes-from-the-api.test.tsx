import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The gateways LIST used to hydrate every nested Tool -- for a page of 20
 * gateways averaging 100 tools, 2,000 Tool entities with their code,
 * parameter schemas and examples -- purely so this table could render
 * `tools.length`. The backend replaced that with a correlated COUNT
 * exposed as `toolCount` and stopped sending `tools` on the list.
 *
 * That is a contract split across two repos' worth of code with nothing
 * connecting them: the page kept compiling, kept rendering, and silently
 * printed 0 for every gateway. So this asserts the page reads the field
 * the list actually sends.
 */
describe('the gateways list reads the count the API sends', () => {
  const source = readFileSync(join(__dirname, '..', 'gateways.tsx'), 'utf8')

  it('reads toolCount, not the length of an array the list no longer carries', () => {
    expect(source).toContain('gateway.toolCount')
    // Both the per-row cell and the header aggregate. A fix to one and not
    // the other is exactly how this stays half-broken.
    expect(source).toContain('g.toolCount')
  })

  it('never reads tools.length without toolCount in front of it', () => {
    const bare = source
      .split('\n')
      .filter((line) => /tools\?\.length/.test(line))
      .filter((line) => !/toolCount\s*\?\?\s*\w+\.tools\?\.length/.test(line))
    expect(bare).toEqual([])
  })
})

describe('the count renders', () => {
  it('shows the API count rather than falling back to zero', () => {
    // A minimal stand-in for the table cell's logic, kept here so the
    // assertion is about behaviour and not only about source text.
    const cell = (gateway: { toolCount?: number; tools?: unknown[] }) => (
      <span>{gateway.toolCount ?? gateway.tools?.length ?? 0}</span>
    )
    const { rerender } = render(cell({ toolCount: 37 }))
    expect(screen.getByText('37')).toBeInTheDocument()

    // The detail response still sends real tools and no count.
    rerender(cell({ tools: [{}, {}] }))
    expect(screen.getByText('2')).toBeInTheDocument()

    // Neither: a gateway with nothing assigned.
    rerender(cell({}))
    expect(screen.getByText('0')).toBeInTheDocument()
  })
})
