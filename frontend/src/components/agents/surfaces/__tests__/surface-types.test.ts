import { describe, it, expect } from 'vitest'

import { inboundAuthStatus, type SurfaceDescriptor } from '../surface-types'

const surface = (overrides: Partial<SurfaceDescriptor> = {}): SurfaceDescriptor => ({
  type: 'slack',
  label: 'Slack',
  category: 'messaging',
  kind: 'agent',
  available: true,
  unavailableReason: null,
  humanFacing: true,
  inboundAuth: {
    mechanism: 'signature',
    requiredConfigKeys: ['signing_secret'],
    unauthenticatedByDesign: false,
  },
  edition: 'core',
  ...overrides,
})

describe('inboundAuthStatus', () => {
  it('is verified once every required key is present', () => {
    expect(inboundAuthStatus(surface(), { signing_secret: 's' })).toEqual({
      verified: true,
      reason: null,
    })
  })

  it('names the missing key, and says refused rather than merely unverified', () => {
    const status = inboundAuthStatus(surface(), {})
    expect(status.verified).toBe(false)
    // The backend fails closed, so "unverified" would understate it.
    expect(status.reason).toContain('refused')
    expect(status.reason).toContain('signing_secret')
  })

  it('pluralises when more than one key is missing', () => {
    const twilio = surface({
      type: 'sms',
      inboundAuth: {
        mechanism: 'signature',
        requiredConfigKeys: ['twilio_auth_token', 'webhook_url'],
        unauthenticatedByDesign: false,
      },
    })
    expect(inboundAuthStatus(twilio, {}).reason).toContain('are set')
    expect(inboundAuthStatus(twilio, { twilio_auth_token: 't' }).reason).toContain('is set')
  })

  it('treats the by-design-unauthenticated surfaces as verified', () => {
    const widget = surface({
      type: 'chat_widget',
      inboundAuth: { mechanism: 'none', requiredConfigKeys: [], unauthenticatedByDesign: true },
    })
    expect(inboundAuthStatus(widget, {}).verified).toBe(true)
  })

  it('treats protocol surfaces as verified, they use almyty gateway auth', () => {
    const mcp = surface({
      type: 'mcp',
      category: 'protocol',
      inboundAuth: { mechanism: 'none', requiredConfigKeys: [], unauthenticatedByDesign: false },
    })
    expect(inboundAuthStatus(mcp, {}).verified).toBe(true)
  })

  it('rejects an unknown surface rather than assuming it is fine', () => {
    expect(inboundAuthStatus(undefined, {})).toEqual({
      verified: false,
      reason: 'Unknown surface type.',
    })
  })

  it('tolerates a null configuration', () => {
    expect(inboundAuthStatus(surface(), null).verified).toBe(false)
  })
})
