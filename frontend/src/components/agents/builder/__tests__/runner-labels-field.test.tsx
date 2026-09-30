import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { render } from '../../../../test/setup'
import { RunnerLabelsField, formatRunnerLabels, malformedRunnerLabels } from '../runner-labels-field'

describe('machine labels on an agent', () => {
  it('shows stored requirements as the text a person would type', () => {
    expect(formatRunnerLabels({ gpu: 'yes', os: 'mac' })).toBe('gpu=yes, os=mac')
    expect(formatRunnerLabels('gpu=yes')).toBe('gpu=yes')
    expect(formatRunnerLabels(undefined)).toBe('')
  })

  it('finds the parts that are not key=value', () => {
    expect(malformedRunnerLabels('gpu=yes, os=mac')).toEqual([])
    expect(malformedRunnerLabels('gpu, =mac, os=')).toEqual(['gpu', '=mac', 'os='])
    expect(malformedRunnerLabels(' , ')).toEqual([])
  })

  it('is a plain input with an example, and says in place what is wrong', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<RunnerLabelsField value={{ os: 'mac' }} onChange={onChange} hint="Runs on a matching machine." />)
    const input = screen.getByLabelText('Machine labels')
    expect(input).toHaveValue('os=mac')
    expect(input).toHaveAttribute('placeholder', 'gpu=yes, os=mac')
    expect(screen.getByText('Runs on a matching machine.')).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, 'gpu')
    expect(onChange).toHaveBeenLastCalledWith('gpu')
    expect(screen.getByText(/Write each label as key=value/)).toHaveTextContent('Not a label: gpu')
    expect(input).toHaveAttribute('aria-invalid', 'true')

    await user.type(input, '=yes')
    expect(onChange).toHaveBeenLastCalledWith('gpu=yes')
    expect(screen.queryByText(/Write each label as key=value/)).not.toBeInTheDocument()
  })

  it('is on the autonomous agent form, under Capabilities, reading and writing agentConfig.runnerLabels', () => {
    const form = readFileSync(join(__dirname, '..', 'autonomous-config.tsx'), 'utf8')
    expect(form).toMatch(/<CapabilitiesSection[\s\S]*agentConfig=\{agentConfig\}/)
    const source = readFileSync(join(__dirname, '..', 'capabilities-section.tsx'), 'utf8')
    expect(source).toMatch(/<Machine value=\{agentConfig\.runnerLabels\} onChange=\{\(runnerLabels\) => set\(\{ runnerLabels \}\)\}/)
    expect(source).toMatch(/<RunnerLabelsField[\s\S]*value=\{value\}[\s\S]*onChange=\{onChange\}/)
  })
})
