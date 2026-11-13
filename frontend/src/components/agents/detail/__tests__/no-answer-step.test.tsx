import { describe, expect, it } from 'vitest'
import { stepSummary } from '../run-roles'

/**
 * A model reply with no answer in it (empty, or cut off at the output
 * limit) is a step of its own on the run, with the reason in plain words,
 * and whether the model was asked again. The run that ends that way fails
 * with the same reason, which the run view shows as the run's error.
 */
describe('a no-answer step in the run view', () => {
  it('says the model stopped at its output limit, and that it was asked again', () => {
    const step = {
      type: 'llm_call',
      output: { status: 'no_answer', reason: 'the model stopped at its output limit before answering', retried: true },
    } as any
    expect(stepSummary(step)).toBe('No answer: The model stopped at its output limit before answering. Asked again.')
  })

  it('says so without "asked again" on the step that ended the run', () => {
    const step = { type: 'llm_call', output: { status: 'no_answer', reason: 'the model returned an empty answer', retried: false } } as any
    expect(stepSummary(step)).toBe('No answer: The model returned an empty answer.')
  })
})
