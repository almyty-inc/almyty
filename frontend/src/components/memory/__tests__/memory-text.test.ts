/**
 * Saved memories embed the run's input as JSON (`Task: {"message":"..."}`)
 * and carry markdown; a person reads the message, and a list row reads one
 * plain line.
 */
import { describe, it, expect } from 'vitest'
import { memoryPreview, memoryText } from '../memory-text'

describe('memoryText', () => {
  it('shows the message of an embedded { message } instead of its JSON', () => {
    expect(memoryText('Task: {"message":"Sites: example.com, example.org"}\nResult: Both are up.'))
      .toBe('Task: Sites: example.com, example.org\nResult: Both are up.')
    expect(memoryText('Person: {"message":"I moved to \\"Lisbon\\"\\nlast week"}\nAgent: Noted.'))
      .toBe('Person: I moved to "Lisbon"\nlast week\nAgent: Noted.')
  })

  it('shows the message of a memory that is only the JSON', () => {
    expect(memoryText('{"message":"Call me Ana"}')).toBe('Call me Ana')
  })

  it('still gives the message of JSON an older save cut short', () => {
    expect(memoryText('Task: {"message":"Sites: example.com, exam\nResult: ok')).toBe('Task: Sites: example.com, exam…\nResult: ok')
  })

  it('leaves everything else alone', () => {
    expect(memoryText('The owner prefers **email**.')).toBe('The owner prefers **email**.')
    expect(memoryText('Config: {"retries":3}')).toBe('Config: {"retries":3}')
    expect(memoryText('Note: {not json')).toBe('Note: {not json')
    expect(memoryText(null)).toBe('')
  })
})

describe('memoryPreview', () => {
  it('is one line without markdown marks or JSON', () => {
    expect(memoryPreview('## Report\n- **Sites** are _up_\n- see [the log](https://x.example/log) and `curl`'))
      .toBe('Report Sites are up see the log and curl')
    expect(memoryPreview('Task: {"message":"Check **both**"}\nResult: done')).toBe('Task: Check both Result: done')
  })

  it('keeps underscores inside words', () => {
    expect(memoryPreview('Use snake_case_names here')).toBe('Use snake_case_names here')
  })
})
