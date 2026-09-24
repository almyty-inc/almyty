/**
 * The organization settings cards edit in place. Each one asks before a
 * navigation throws away a change it has not saved, and leaves quietly
 * when nothing differs from what is stored.
 */
import { describe, it, vi, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'

import { renderAtRoute } from '@/test/render-at-route'
import { expectLeaveAsks, expectLeavesWithoutAsking } from '@/test/leave-guard'
import { SsoSettings } from '../sso-settings'
import { KmsSettings } from '../kms-settings'
import { AuditStreamsSettings } from '../audit-streams-settings'
import { ComplianceSettings } from '../compliance-settings'
import { DataRetentionCard } from '../data-retention-card'
import { api, complianceApi, organizationsApi, ssoApi } from '@/lib/api'

vi.mock('react-router-dom', async () => vi.importActual('react-router-dom'))

vi.mock('@/lib/api', () => ({
  apiGet: vi.fn(),
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
  ssoApi: { getConfig: vi.fn(), saveConfig: vi.fn(), rotateScimToken: vi.fn(), revealScimToken: vi.fn() },
  complianceApi: { getPolicy: vi.fn(), updatePolicy: vi.fn(), getReport: vi.fn() },
  organizationsApi: { getRetention: vi.fn(), updateRetention: vi.fn() },
}))
vi.mock('@/hooks/use-entitlement', () => ({ useEntitlement: () => ({ enabled: true, isLoading: false }) }))
vi.mock('@/store/app', () => ({
  useNotifications: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}))
vi.mock('@/lib/clipboard', () => ({ useCopySensitive: () => vi.fn(), useCopy: () => vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = vi.fn().mockReturnValue(false)
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = vi.fn()
})

const at = (el: JSX.Element) => renderAtRoute(el, { path: '/settings', paths: ['/elsewhere'] })

describe('single sign-on', () => {
  beforeEach(() => {
    vi.mocked(ssoApi.getConfig).mockResolvedValue({
      configured: true, protocol: 'saml', enabled: false, jitProvisioning: false, defaultRole: 'member',
      samlEntryPoint: 'https://idp.example.com/sso', scimEnabled: false,
      scimBaseUrl: 'https://api.almyty.com/scim/v2', scimTokenSet: false,
    } as any)
  })

  it('asks once an identity provider setting is edited', async () => {
    const { router } = at(<SsoSettings />)
    const entry = await screen.findByDisplayValue('https://idp.example.com/sso')
    fireEvent.change(entry, { target: { value: 'https://idp.example.com/sso2' } })
    await expectLeaveAsks(router)
  })

  it('leaves the stored settings without asking', async () => {
    const { router } = at(<SsoSettings />)
    await screen.findByDisplayValue('https://idp.example.com/sso')
    await expectLeavesWithoutAsking(router)
  })
})

describe('customer-managed keys', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue({
      data: { data: { enabled: false, cmkArn: null, awsRegion: null, provisioned: false, updatedAt: null } },
    } as any)
  })

  it('asks while a key ARN is typed and not attached', async () => {
    const { router } = at(<KmsSettings />)
    fireEvent.change(await screen.findByLabelText('CMK ARN'), {
      target: { value: 'arn:aws:kms:eu-central-1:111122223333:key/abc' },
    })
    await expectLeaveAsks(router)
  })

  it('leaves empty fields without asking', async () => {
    const { router } = at(<KmsSettings />)
    await screen.findByLabelText('CMK ARN')
    await expectLeavesWithoutAsking(router)
  })
})

describe('audit streaming', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue({ data: { data: [] } } as any)
  })

  it('asks while an endpoint is typed and not added', async () => {
    const { router } = at(<AuditStreamsSettings />)
    fireEvent.change(await screen.findByLabelText('Endpoint'), { target: { value: 'https://siem.example.com/ingest' } })
    await expectLeaveAsks(router)
  })

  it('leaves empty fields without asking', async () => {
    const { router } = at(<AuditStreamsSettings />)
    await screen.findByLabelText('Endpoint')
    await expectLeavesWithoutAsking(router)
  })
})

describe('compliance policy', () => {
  beforeEach(() => {
    vi.mocked(complianceApi.getPolicy).mockResolvedValue({
      configured: true,
      enforcedPlugins: ['pii-filter', 'security-scanner'],
      securityThreshold: 'medium',
      blockOnViolation: true,
      piiCategories: [],
    } as any)
    vi.mocked(complianceApi.getReport).mockResolvedValue(undefined as any)
  })

  it('asks once a control is switched and not saved', async () => {
    const { router } = at(<ComplianceSettings />)
    const [firstSwitch] = await screen.findAllByRole('switch')
    fireEvent.click(firstSwitch)
    await expectLeaveAsks(router)
  })

  it('leaves the stored policy without asking', async () => {
    const { router } = at(<ComplianceSettings />)
    await screen.findAllByRole('switch')
    await expectLeavesWithoutAsking(router)
  })
})

describe('data retention', () => {
  beforeEach(() => {
    vi.mocked(organizationsApi.getRetention).mockResolvedValue({ enabled: true, agentRunsDays: 30 } as any)
  })

  it('asks once a retention period is changed and not saved', async () => {
    const { router } = at(<DataRetentionCard organizationId="org-1" />)
    fireEvent.change(await screen.findByDisplayValue('30'), { target: { value: '90' } })
    await expectLeaveAsks(router)
  })

  it('leaves the stored policy without asking', async () => {
    const { router } = at(<DataRetentionCard organizationId="org-1" />)
    await screen.findByDisplayValue('30')
    await expectLeavesWithoutAsking(router)
  })
})
