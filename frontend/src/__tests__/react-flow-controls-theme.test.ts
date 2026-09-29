import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * The canvas zoom controls follow the theme.
 *
 * React Flow's stylesheet is imported by each canvas component, so it lands
 * after index.css and wins any rule of equal weight on its own classes: a
 * background set on .react-flow__controls-button here was overridden, and in
 * dark mode the white icons sat on React Flow's near-white buttons. What
 * holds is setting the variables React Flow reads (it only ever sets their
 * `-default` twins). These read both stylesheets, so a change on either
 * side that would bring the white buttons back fails here.
 */
const APP_CSS = readFileSync(resolve(__dirname, '../index.css'), 'utf8')
const XY_CSS = readFileSync(resolve(__dirname, '../../node_modules/@xyflow/react/dist/style.css'), 'utf8')

const THEMED: Record<string, string> = {
  '--xy-controls-button-background-color': 'hsl(var(--card))',
  '--xy-controls-button-background-color-hover': 'hsl(var(--muted))',
  '--xy-controls-button-color': 'hsl(var(--foreground))',
  '--xy-controls-button-color-hover': 'hsl(var(--foreground))',
  '--xy-controls-button-border-color': 'hsl(var(--border))',
}

describe('React Flow controls are themed', () => {
  it('sets the variables React Flow reads, from the theme tokens, on .react-flow', () => {
    const block = APP_CSS.match(/\n\.react-flow \{([^}]*)\}/)?.[1] ?? ''
    for (const [name, value] of Object.entries(THEMED)) {
      expect(block).toContain(`${name}: ${value};`)
    }
  })

  it('React Flow reads those variables for the buttons and never sets them itself', () => {
    expect(XY_CSS).toMatch(/background:\s*var\(--xy-controls-button-background-color,/)
    // The props variable comes first; the Controls here are rendered without colour props.
    expect(XY_CSS).toMatch(/color:\s*var\(\s*--xy-controls-button-color-props,\s*var\(--xy-controls-button-color,/)
    for (const name of Object.keys(THEMED)) {
      expect(XY_CSS).not.toMatch(new RegExp(`${name}\\s*:`))
    }
  })

  it('does not style the buttons with a rule React Flow overrides', () => {
    const rule = APP_CSS.match(/\.react-flow__controls-button \{([^}]*)\}/)?.[1] ?? ''
    expect(rule).not.toMatch(/background|color:/)
  })
})
