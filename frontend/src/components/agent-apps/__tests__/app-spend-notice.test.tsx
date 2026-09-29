import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'

import { render } from '../../../test/setup'
import { AppSpendNotice, spendLine } from '../app-spend-notice'
import { agentAppsApi, appSpendCapsFrom, type AppSpendStatus } from '@/lib/agent-apps'

vi.mock('@/lib/agent-apps', async () => {
  const actual = await vi.importActual<typeof import('@/lib/agent-apps')>('@/lib/agent-apps')
  return { ...actual, agentAppsApi: { spend: vi.fn() } }
})

const status = (over: Partial<AppSpendStatus> = {}): AppSpendStatus => ({
  caps: { dailyCents: 500, monthlyCents: 5000 },
  todayCents: 120,
  monthCents: 340,
  reached: null,
  resetsAt: null,
  ...over,
})

describe('AppSpendNotice', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shows what the app spent against its limits while it answers', async () => {
    ;(agentAppsApi.spend as any).mockResolvedValue(status())
    render(<AppSpendNotice slug="acme" onChangeLimit={vi.fn()} />)
    expect(await screen.findByTestId('app-spend')).toHaveTextContent('Spent today $1.20 of $5 · this month $3.40 of $50')
  })

  it('tells the owner, in the visitors own words, when the day limit is reached', async () => {
    const onChangeLimit = vi.fn()
    ;(agentAppsApi.spend as any).mockResolvedValue(
      status({ todayCents: 512, reached: 'day', resetsAt: '2026-09-30T00:00:00.000Z' }),
    )
    render(<AppSpendNotice slug="acme" onChangeLimit={onChangeLimit} />)

    const card = await screen.findByTestId('app-spend-reached')
    expect(card).toHaveTextContent('This app has reached its spend limit for today')
    expect(card).toHaveTextContent('Visitors are told “This app has reached its limit for today” until it resets at midnight UTC.')
    fireEvent.click(screen.getByRole('button', { name: 'Change the limit' }))
    expect(onChangeLimit).toHaveBeenCalled()
  })

  it('names the month when the month limit is the one reached', async () => {
    ;(agentAppsApi.spend as any).mockResolvedValue(status({ monthCents: 5000, reached: 'month' }))
    render(<AppSpendNotice slug="acme" onChangeLimit={vi.fn()} />)
    expect(await screen.findByTestId('app-spend-reached')).toHaveTextContent('reached its spend limit for this month')
  })
})

describe('spendLine and appSpendCapsFrom', () => {
  it('reads without a limit when there is none', () => {
    expect(spendLine(status({ caps: { dailyCents: null, monthlyCents: null } }))).toBe('Spent today $1.20 · this month $3.40')
  })

  it('mirrors the backend defaults: capped unless only the directory can reach it', () => {
    expect(appSpendCapsFrom({ authMode: 'public_link', limits: null })).toEqual({ dailyCents: 500, monthlyCents: 5000 })
    expect(appSpendCapsFrom({ authMode: 'email_otp', limits: {} })).toEqual({ dailyCents: 500, monthlyCents: 5000 })
    expect(appSpendCapsFrom({ authMode: 'sso', limits: {} })).toEqual({ dailyCents: null, monthlyCents: null })
    expect(appSpendCapsFrom({ authMode: 'public_link', limits: { dailySpendCapCents: null } })).toEqual({ dailyCents: null, monthlyCents: 5000 })
  })
})
