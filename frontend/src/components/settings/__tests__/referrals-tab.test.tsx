import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent, within } from '@testing-library/react'

import { render } from '../../../test/setup'
import { ReferralsTab } from '../referrals-tab'

vi.mock('../../../lib/api', () => ({
  referralsApi: {
    getCode: vi.fn(),
    getStats: vi.fn(),
    list: vi.fn(),
  },
}))

const copyMock = vi.fn()
vi.mock('../../../lib/clipboard', () => ({
  useCopy: () => copyMock,
}))

import { referralsApi } from '../../../lib/api'

const mockedGetCode = referralsApi.getCode as ReturnType<typeof vi.fn>
const mockedGetStats = referralsApi.getStats as ReturnType<typeof vi.fn>
const mockedList = referralsApi.list as ReturnType<typeof vi.fn>

describe('ReferralsTab', () => {
  beforeEach(() => {
    mockedGetCode.mockReset()
    mockedGetStats.mockReset()
    mockedList.mockReset()
    copyMock.mockReset()
  })

  it('renders the share link with a copy button and the stats blocks', async () => {
    mockedGetCode.mockResolvedValue({
      code: 'ABCD2345',
      link: 'https://app.almyty.com/r/ABCD2345',
    })
    mockedGetStats.mockResolvedValue({
      invited: 3,
      qualified: 1,
      rewarded: 0,
      pendingReview: 1,
      totalRewardDays: 14,
      accruedRewardDays: 14,
    })
    mockedList.mockResolvedValue([])

    render(<ReferralsTab />)

    await waitFor(() => {
      expect(screen.getByDisplayValue('https://app.almyty.com/r/ABCD2345')).toBeInTheDocument()
    })
    expect(screen.getByText('Invited')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText(/banked until you upgrade/i)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(copyMock).toHaveBeenCalledWith(
      'https://app.almyty.com/r/ABCD2345',
      'Referral link',
    )
  })

  it('lists referrals with status badges, flagged rows shown as pending review', async () => {
    mockedGetCode.mockResolvedValue({ code: 'ABCD2345', link: 'https://x/r/ABCD2345' })
    mockedGetStats.mockResolvedValue({
      invited: 2, qualified: 1, rewarded: 0, pendingReview: 1, totalRewardDays: 14, accruedRewardDays: 0,
    })
    mockedList.mockResolvedValue([
      { id: 'r1', status: 'qualified', rewardDays: 14, qualifiedAt: '2026-06-01T00:00:00Z', rewardedAt: null, createdAt: '2026-05-20T00:00:00Z' },
      { id: 'r2', status: 'pending_review', rewardDays: 0, qualifiedAt: null, rewardedAt: null, createdAt: '2026-05-25T00:00:00Z' },
    ])

    render(<ReferralsTab />)

    await waitFor(() => {
      expect(screen.getByRole('table')).toBeInTheDocument()
    })
    const table = within(screen.getByRole('table'))
    // 'Qualified' appears as both a column header and the row badge
    expect(table.getAllByText('Qualified').length).toBeGreaterThanOrEqual(2)
    expect(table.getByText('Pending review')).toBeInTheDocument()
    expect(table.getByText('14')).toBeInTheDocument()
  })

  it('shows the not-available note when the code endpoint rejects (enterprise org)', async () => {
    mockedGetCode.mockRejectedValue(new Error('forbidden'))
    mockedGetStats.mockResolvedValue({
      invited: 0, qualified: 0, rewarded: 0, pendingReview: 0, totalRewardDays: 0, accruedRewardDays: 0,
    })
    mockedList.mockResolvedValue([])

    render(<ReferralsTab />)

    await waitFor(() => {
      expect(screen.getByText(/not available for your organization/i)).toBeInTheDocument()
    })
  })
})
