import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { render, screen } from '@testing-library/react'

import { STEP_NAMES } from '../../step-values'
import { VerifyStepCard } from '../verify-step'

// A run's steps are named in words ("Verify", "Explore"), never by the type
// code the run stores. The staging gate caught "verify" and "explore" still
// printed raw after the other steps were named.

const runner = readFileSync(
  join(__dirname, '../../../../../../backend/src/modules/agents/autonomous-strategy.runner.ts'),
  'utf8',
)

describe('run step names', () => {
  it('names every step type an autonomous work mode records', () => {
    // this.record(run, role, '<type>', ...)
    const recorded = new Set([...runner.matchAll(/this\.record\(\s*run,[^']{0,160}?'([a-z_]+)'/g)].map((m) => m[1]))
    expect([...recorded].sort()).toEqual(expect.arrayContaining(['explore', 'judge', 'teammate_call']))
    const unnamed = [...recorded].filter((type) => !STEP_NAMES[type])
    expect(unnamed).toEqual([])
  })

  it('the check step card says Verify, not the type code', () => {
    render(<VerifyStepCard step={{ type: 'verify', input: {}, output: { passed: true } } as any} index={0} />)
    expect(screen.getByText('Verify')).toBeInTheDocument()
    expect(screen.queryByText('verify')).toBeNull()
  })
})
