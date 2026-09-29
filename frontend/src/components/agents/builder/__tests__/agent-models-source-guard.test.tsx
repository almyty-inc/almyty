/**
 * The builder's strategies and rules are the engine's, read from the
 * engine's own file.
 *
 * The autonomous page offers strategies as radio cards and blocks Save on
 * missing slots. If it offered a strategy the loop does not implement, the
 * agent would save and quietly run something else; if it missed one, the
 * engine's shape would be unreachable. So this reads
 * backend/src/modules/agents/autonomous-models.ts and compares, rather
 * than trusting a copy to stay a copy.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

import { fireEvent, screen } from '@testing-library/react'

import { render } from '@/test/setup'
import { StrategyChoice } from '../strategy-choice'
import {
  AGENT_ALLOWED_PURPOSES,
  AUTONOMOUS_STRATEGY_KEYS,
  BEST_OF_N_DEFAULT,
  BEST_OF_N_MAX,
  BEST_OF_N_MIN,
  ROLE_PURPOSES,
  STRATEGY_OPTIONAL,
  STRATEGY_SLOTS,
  newAgentModels,
} from '../agent-models'

const BACKEND = readFileSync(
  join(__dirname, '../../../../../../backend/src/modules/agents/autonomous-models.ts'),
  'utf8',
)

/** The quoted strings of `const NAME ... = [ ... ]`. */
function backendList(name: string): string[] {
  const m = BACKEND.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`))
  if (!m) throw new Error(`${name} not found in the backend file`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** `const NAME ... = { key: { a: 1 }, ... }` or `{ key: ['a'] }`, parsed per line. */
function backendTable(name: string): Record<string, unknown> {
  const m = BACKEND.match(new RegExp(`${name}:[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`))
  if (!m) throw new Error(`${name} not found in the backend file`)
  const out: Record<string, unknown> = {}
  for (const line of m[1].split('\n')) {
    const row = line.match(/^\s*(\w+):\s*(\{[^}]*\}|\[[^\]]*\]),?\s*$/)
    if (!row) continue
    const json = row[2].replace(/'/g, '"').replace(/(\w+):/g, '"$1":')
    out[row[1]] = JSON.parse(json)
  }
  return out
}

function backendNumber(name: string): number {
  const m = BACKEND.match(new RegExp(`export const ${name}\\s*=\\s*(\\d+)`))
  if (!m) throw new Error(`${name} not found in the backend file`)
  return Number(m[1])
}

describe('the autonomous builder mirrors the engine', () => {
  it('offers exactly the strategies the engine implements, in its order', () => {
    const { container } = render(<StrategyChoice models={newAgentModels()} onChange={() => {}} />)
    // The less common ones wait under "More ways"; open it so all are counted.
    fireEvent.click(screen.getByRole('button', { name: 'More ways' }))
    const offered = [...container.querySelectorAll('[data-strategy-key]')].map((el) => el.getAttribute('data-strategy-key'))
    const engine = backendList('AUTONOMOUS_STRATEGY_KEYS')
    expect(engine.length).toBeGreaterThan(0)
    expect(offered).toEqual(engine)
    expect([...AUTONOMOUS_STRATEGY_KEYS]).toEqual(engine)
  })

  it('needs the same slots per strategy as the engine', () => {
    expect(STRATEGY_SLOTS).toEqual(backendTable('STRATEGY_SLOTS'))
  })

  it('reads the same optional purposes per strategy', () => {
    expect(STRATEGY_OPTIONAL).toEqual(backendTable('STRATEGY_OPTIONAL'))
  })

  it('has the same purposes, and the same ones that can be another agent', () => {
    expect([...ROLE_PURPOSES]).toEqual(backendList('ROLE_PURPOSES'))
    expect([...AGENT_ALLOWED_PURPOSES]).toEqual(backendList('AGENT_ALLOWED_PURPOSES'))
  })

  it('bounds Best of N the same way', () => {
    expect([BEST_OF_N_MIN, BEST_OF_N_DEFAULT, BEST_OF_N_MAX]).toEqual([
      backendNumber('BEST_OF_N_MIN'),
      backendNumber('BEST_OF_N_DEFAULT'),
      backendNumber('BEST_OF_N_MAX'),
    ])
  })
})
