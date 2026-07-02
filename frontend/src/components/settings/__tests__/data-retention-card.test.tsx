import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'
import { DataRetentionCard } from '../data-retention-card'

vi.mock('../../../lib/api', () => ({
  organizationsApi: {
    getRetention: vi.fn(),
    updateRetention: vi.fn(),
  },
}))

const successMock = vi.fn()
const errorMock = vi.fn()
vi.mock('../../../store/app', () => ({
  useNotifications: () => ({ success: successMock, error: errorMock, info: vi.fn() }),
}))

import { organizationsApi } from '../../../lib/api'

const mockedGetRetention = organizationsApi.getRetention as ReturnType<typeof vi.fn>
const mockedUpdateRetention = organizationsApi.updateRetention as ReturnType<typeof vi.fn>

const basePolicy = {
  organizationId: 'org-1',
  enabled: true,
  agentRunsDays: 30,
  conversationsDays: null,
  requestLogsDays: null,
  usageMetricsDays: null,
  auditLogDays: 365,
}

describe('DataRetentionCard', () => {
  beforeEach(() => {
    mockedGetRetention.mockReset()
    mockedUpdateRetention.mockReset()
    successMock.mockReset()
    errorMock.mockReset()
  })

  it('renders per-class inputs with configured values and keep-forever placeholders', async () => {
    mockedGetRetention.mockResolvedValue(basePolicy)

    render(<DataRetentionCard organizationId="org-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText(/agent runs/i)).toHaveValue(30)
    })
    expect(screen.getByLabelText(/audit log \(days\)/i)).toHaveValue(365)
    // Unset classes stay empty with the keep-forever placeholder.
    const conversations = screen.getByLabelText(/conversations/i)
    expect(conversations).toHaveValue(null)
    expect(conversations).toHaveAttribute('placeholder', 'Keep forever')
    expect(mockedGetRetention).toHaveBeenCalledWith('org-1')
  })

  it('saves the policy, sending null for empty fields', async () => {
    mockedGetRetention.mockResolvedValue(basePolicy)
    mockedUpdateRetention.mockResolvedValue({ ...basePolicy, conversationsDays: 90 })

    render(<DataRetentionCard organizationId="org-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText(/agent runs/i)).toHaveValue(30)
    })

    fireEvent.change(screen.getByLabelText(/conversations/i), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: /save retention policy/i }))

    await waitFor(() => {
      expect(mockedUpdateRetention).toHaveBeenCalledWith('org-1', {
        enabled: true,
        agentRunsDays: 30,
        conversationsDays: 90,
        requestLogsDays: null,
        usageMetricsDays: null,
        auditLogDays: 365,
      })
    })
    expect(successMock).toHaveBeenCalled()
  })

  it('rejects out-of-range values client-side without calling the API', async () => {
    mockedGetRetention.mockResolvedValue(basePolicy)

    render(<DataRetentionCard organizationId="org-1" />)

    await waitFor(() => {
      expect(screen.getByLabelText(/agent runs/i)).toHaveValue(30)
    })

    fireEvent.change(screen.getByLabelText(/request logs/i), { target: { value: '5000' } })
    fireEvent.click(screen.getByRole('button', { name: /save retention policy/i }))

    expect(errorMock).toHaveBeenCalledWith(
      'Invalid retention period',
      expect.stringContaining('Request logs'),
    )
    expect(mockedUpdateRetention).not.toHaveBeenCalled()
  })

  it('renders nothing without an organization id', () => {
    const { container } = render(<DataRetentionCard />)
    expect(container).toBeEmptyDOMElement()
    expect(mockedGetRetention).not.toHaveBeenCalled()
  })
})
