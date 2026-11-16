/**
 * The agent page and its run views draw status in the design tokens
 * (success, warning, danger and their -subtle / -border pairs), not in
 * Tailwind's raw amber, emerald, green and red: the run steps and the
 * answer-check summary were still amber/emerald after the white redesign.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(__dirname, '..', 'components', 'agents', 'detail')

const FILES = [
  'runs-tab.tsx',
  'verify-step.tsx',
  'route-trace-timeline.tsx',
  'model-availability-banner.tsx',
  'model-issue-banner.tsx',
  'pause-reason-banner.tsx',
  'readiness-banner.tsx',
  'run-failure-banner.tsx',
  'agent-stats.tsx',
  'agent-config-panel.tsx',
]

describe('agent run views use the status tokens', () => {
  it.each(FILES)('%s has no raw amber, emerald, green, red or teal classes', (file) => {
    const source = readFileSync(join(DIR, file), 'utf8')
    expect(source).not.toMatch(/\b(?:text|bg|border|from|to|ring)-(?:amber|emerald|green|red|teal)-\d{2,3}\b/)
  })
})
