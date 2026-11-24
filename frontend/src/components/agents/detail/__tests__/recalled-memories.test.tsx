import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { RecalledMemories, recalledMemoriesOf } from '../recalled-memories'

/**
 * Recall provenance: a run that starts from saved memories shows which ones
 * it read and which run saved each, on its memory_recall step. Before, the
 * step said only "found: 2" (founder's associate demo, run 3f328283).
 */
describe('the memories a run read', () => {
  const step = {
    type: 'memory_recall',
    output: {
      found: 2,
      memories: [
        { id: 'm-elena', kind: 'long', text: 'Elena Fischer is a Partner at Northstar Capital; led the seed round in March 2025.', savedAt: '2026-11-24T09:56:10.000Z', savedByRun: 'daf10ea8-a8f5-4e4f-84be-838a5888174c' },
        { id: 'm-priya', kind: 'long', text: 'Priya Raman (Halcyon Ventures) was introduced by Tom Becker on 10 Nov.' },
      ],
    },
  }

  it('lists each memory with the run that saved it', () => {
    render(<RecalledMemories step={step} index={0} />)
    const list = screen.getByTestId('run-step-0-memories')
    expect(list.textContent).toContain('Elena Fischer is a Partner at Northstar Capital')
    expect(list.textContent).toContain('saved by run daf10ea8, 2026-11-24')
    expect(list.textContent).toContain('Priya Raman')
  })

  it('shows nothing for another step, or a recall that found nothing', () => {
    expect(recalledMemoriesOf({ type: 'tool_call', output: step.output })).toEqual([])
    const { container } = render(<RecalledMemories step={{ type: 'memory_recall', output: { found: 0 } }} index={1} />)
    expect(container.textContent).toBe('')
  })
})
