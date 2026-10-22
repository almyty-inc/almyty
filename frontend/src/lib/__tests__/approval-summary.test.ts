import { describe, it, expect } from 'vitest'

import { actionDetailsOf, withoutInternalFields } from '../approval-summary'
import { formatDateTime } from '../utils'

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
    // The schema's parameters first, in its order; send_updates (not in it) after.
    expect(actionDetailsOf(payload, schema)).toEqual([
      { label: 'Calendar', value: 'primary' },
      { label: 'Request body › Title', value: 'Dentist' },
      { label: 'Request body › Attendees', value: 'a@x.example, b@x.example' },
      { label: 'Send updates', value: 'all' },
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

  it('reads a moved event\'s times as dates, labelled "Start" and "End" rather than "Start › Date time"', () => {
    const payload = {
      tool: 'Updates an event',
      parameters: { start: { dateTime: '2026-10-23T10:30:00Z' }, end: { dateTime: '2026-10-23T11:30:00Z', timeZone: 'Europe/Berlin' }, eventId: 'ev-review' },
    }
    const rows = actionDetailsOf(payload)
    expect(rows[0]).toEqual({ label: 'Start', value: formatDateTime('2026-10-23T10:30:00Z') })
    expect(rows[0].value).not.toContain('T10:30')
    // Two fields under it: each keeps its own label, the time still in words.
    expect(rows[1]).toEqual({ label: 'End › Date time', value: formatDateTime('2026-10-23T11:30:00Z') })
    expect(rows[2]).toEqual({ label: 'End › Time zone', value: 'Europe/Berlin' })
    expect(rows[3]).toEqual({ label: 'Event id', value: 'ev-review' })
  })

  it('leaves a plain date and things that only look like numbers as they are', () => {
    expect(actionDetailsOf({ parameters: { due: '2026-10-23', orderId: '20261023' } })).toEqual([
      { label: 'Due', value: '2026-10-23' },
      { label: 'Order id', value: '20261023' },
    ])
  })

  it("follows the tool's parameter order, and puts a start before an end whatever order the call sent", () => {
    const schema = { properties: { summary: {}, location: {}, endTime: {}, startTime: {} } }
    const labels = (rows: Array<{ label: string }>) => rows.map((r) => r.label)
    // Schema order (summary, location), then the start pulled ahead of the end.
    expect(labels(actionDetailsOf({ parameters: { endTime: 'b', location: 'Room 2', startTime: 'a', summary: 'Review' } }, schema)))
      .toEqual(['Summary', 'Location', 'Start time', 'End time'])
    // No schema: the call's own order, but End never before Start.
    expect(labels(actionDetailsOf({ parameters: { end: { dateTime: '2026-10-23T11:30:00Z' }, eventId: 'ev', start: { dateTime: '2026-10-23T10:30:00Z' } } })))
      .toEqual(['Start', 'End', 'Event id'])
    // A field merely containing "end" is not an end: send_updates keeps its place.
    expect(labels(actionDetailsOf({ parameters: { send_updates: 'all', start: 'a' } }))).toEqual(['Send updates', 'Start'])
  })
})

describe('withoutInternalFields', () => {
  it('drops _-prefixed keys at every depth', () => {
    expect(withoutInternalFields({ a: 1, _gate: { call: {} }, b: { _c: 2, d: [{ _e: 1, f: 2 }] } })).toEqual({ a: 1, b: { d: [{ f: 2 }] } })
  })
})
