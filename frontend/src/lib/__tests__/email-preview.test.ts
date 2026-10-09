import { describe, it, expect } from 'vitest'

import { emailPreviewOf } from '../email-preview'

/**
 * Approving an outreach email meant reading a base64 string: Gmail's send
 * call carries the whole message in `raw`. The approval now shows who it
 * goes to and what it says.
 */
const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const mail = 'To: jonas.weber@bluefin.example\r\nCc: ops@lumen.example\r\nSubject: Route planning at Bluefin Couriers\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nHi Jonas,\n\nWould a 20-minute call next week be useful?\n\nBest,\nMaya – Lumen'

describe('emailPreviewOf', () => {
  it('reads a Gmail send call held for approval', () => {
    const payload = { tool: 'Gmail gmail users messages send', _gate: { kind: 'tool_call' }, parameters: { userId: 'me', raw: b64url(mail) } }
    expect(emailPreviewOf(payload)).toEqual({
      to: 'jonas.weber@bluefin.example',
      cc: 'ops@lumen.example',
      subject: 'Route planning at Bluefin Couriers',
      body: 'Hi Jonas,\n\nWould a 20-minute call next week be useful?\n\nBest,\nMaya – Lumen',
    })
  })

  it('reads a Gmail draft (message.raw)', () => {
    expect(emailPreviewOf({ parameters: { userId: 'me', message: { raw: b64url(mail) } } })?.subject).toBe('Route planning at Bluefin Couriers')
  })

  it('leaves anything that is not an email alone', () => {
    expect(emailPreviewOf({ parameters: { amount: 820, orderId: 'NW-44120' } })).toBeNull()
    expect(emailPreviewOf({ parameters: { raw: b64url('just some bytes, no headers') } })).toBeNull()
    expect(emailPreviewOf({ parameters: { raw: 'not base64 at all!' } })).toBeNull()
    expect(emailPreviewOf(null)).toBeNull()
  })
})
