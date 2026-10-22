import { describe, it, expect } from 'vitest'

import { actionDetailsOf, withoutInternalFields } from '../approval-summary'

/**
 * A held calendar call showed its arguments as JSON with the server's own
 * `_gate` bookkeeping in it. The approval now reads as label/value rows.
 */
describe('actionDetailsOf', () => {
  it('labels a held call\'s arguments with the schema\'s titles, in words otherwise, and drops _-prefixed fields', () => {
    const payload = {
      tool: 'Creates an event',
      parameters: { calendarId: 'primary', send_updates: 'all', _internal: 'x', requestBody: { summary: 'Dentist', attendees: [{ email: 'a@x.example' }, { email: 'b@x.example' }] } },
      _gate: { paramsHash: 'h' },
    }
    const schema = { properties: { calendarId: { title: 'Calendar' }, requestBody: { properties: { summary: { title: 'Title' } } } } }
    expect(actionDetailsOf(payload, schema)).toEqual([
      { label: 'Calendar', value: 'primary' },
      { label: 'Send updates', value: 'all' },
      { label: 'Request body › Title', value: 'Dentist' },
      { label: 'Request body › Attendees', value: 'a@x.example, b@x.example' },
    ])
  })

  it('reads a request_approval payload with no parameters as the payload itself, minus the tool name and internals', () => {
    expect(actionDetailsOf({ tool: 't', amount: 820, currency: 'EUR', _gate: {} })).toEqual([
      { label: 'Amount', value: '820' },
      { label: 'Currency', value: 'EUR' },
    ])
  })

  it('gives nothing for an empty or missing payload', () => {
    expect(actionDetailsOf(null)).toEqual([])
    expect(actionDetailsOf({ _gate: { kind: 'tool_call' } })).toEqual([])
  })
})

describe('withoutInternalFields', () => {
  it('drops _-prefixed keys at every depth', () => {
    expect(withoutInternalFields({ a: 1, _gate: { call: {} }, b: { _c: 2, d: [{ _e: 1, f: 2 }] } })).toEqual({ a: 1, b: { d: [{ f: 2 }] } })
  })
})
