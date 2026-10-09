import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PauseReasonBanner } from '../pause-reason-banner'
import { agentsApi } from '@/lib/api'
import type { Agent } from '@/types'

vi.mock('@/lib/api', () => ({
  agentsApi: { schedule: vi.fn(), setAlwaysOn: vi.fn() },
}))

const detectedAt = '2026-09-24T08:00:00.000Z'
const ownerCannotRun = {
  code: 'OWNER_CANNOT_RUN' as const,
  message: "Scheduled run refused: the agent's owner can no longer run this agent (not a member of the team). The schedule has been paused.",
  detectedAt,
}
const ownerNotMember = {
  code: 'OWNER_NOT_MEMBER' as const,
  message: 'The member who owns this agent is no longer active in the organization, so its schedule was paused.',
  detectedAt,
}
const ALWAYS_ON = {
  enabled: true,
  brief: 'check in',
  wakeOn: { timer: { everyMinutes: 15 } },
  actMode: 'act' as const,
  askFirstToolIds: [],
  report: 'when_acted' as const,
}

const agent = (overrides: Partial<Agent> = {}): Agent =>
  ({ id: 'a1', name: 'Digest', mode: 'autonomous', settings: {}, ...overrides }) as unknown as Agent

const renderIt = (a: Agent) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PauseReasonBanner agent={a} />
    </QueryClientProvider>,
  )

describe('PauseReasonBanner', () => {
  beforeEach(() => vi.clearAllMocks())

  it('says nothing when nothing was paused by the system', () => {
    renderIt(agent({ settings: { schedule: { enabled: false, intervalMinutes: 30, input: {} } } }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('leaves a retired model to the model banner', () => {
    const issue = { code: 'MODEL_NOT_FOUND' as const, model: 'm', message: 'gone', detectedAt }
    renderIt(agent({ settings: { modelIssue: issue, schedule: { enabled: false, intervalMinutes: 30, input: {}, pausedReason: issue } } }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says nothing once the schedule is running again', () => {
    renderIt(agent({ settings: { schedule: { enabled: true, intervalMinutes: 30, input: {}, pausedReason: ownerCannotRun } } }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('explains a schedule paused because its owner can no longer run the agent, and what to do', () => {
    renderIt(agent({ settings: { schedule: { enabled: false, intervalMinutes: 30, input: {}, pausedReason: ownerCannotRun } } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("The schedule was paused because this agent's owner can no longer run it.")
    expect(alert).toHaveTextContent(ownerCannotRun.message)
    expect(alert).toHaveTextContent("Scheduled runs act as the agent's owner")
    expect(alert).toHaveTextContent("Add the owner back to the agent's team and resume the schedule")
    expect(alert).toHaveTextContent('duplicate the agent to own a copy')
    expect(within(alert).getByRole('button', { name: 'Resume schedule' })).toBeEnabled()
  })

  it('explains a schedule paused because its owner left the organization', () => {
    renderIt(agent({ settings: { schedule: { enabled: false, intervalMinutes: 30, input: {}, pausedReason: ownerNotMember } } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('no longer active in the organization')
    expect(alert).toHaveTextContent('Once they are an active member again, resume the schedule')
  })

  it('explains a schedule paused because the plan no longer lets the agent act as itself', () => {
    const lapsed = {
      code: 'IDENTITY_LAPSED' as const,
      message: 'This agent acts as itself, which needs the Business plan. It was paused instead of running as you.',
      detectedAt,
    }
    renderIt(agent({ settings: { schedule: { enabled: false, intervalMinutes: 30, input: {}, pausedReason: lapsed } } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('acts as itself, which needs the Business plan')
    expect(alert).toHaveTextContent('It was not run as its owner instead.')
    expect(alert).toHaveTextContent('switch Acts as back to its owner under Capabilities')
  })

  it('resumes the schedule with the interval and input it had', async () => {
    vi.mocked(agentsApi.schedule).mockResolvedValue({} as any)
    renderIt(
      agent({ settings: { schedule: { enabled: false, intervalMinutes: 45, input: { topic: 'news' }, pausedReason: ownerCannotRun } } }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Resume schedule' }))
    await waitFor(() =>
      expect(agentsApi.schedule).toHaveBeenCalledWith('a1', { kind: 'interval', intervalMinutes: 45, input: { topic: 'news' } }),
    )
  })

  it('explains Always on switched off for the same reason, and turns it back on as it was', async () => {
    vi.mocked(agentsApi.setAlwaysOn).mockResolvedValue({} as any)
    renderIt(agent({ alwaysOn: { ...ALWAYS_ON, enabled: false, pausedReason: ownerCannotRun } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("The Always on setting was switched off because this agent's owner can no longer run it.")
    expect(alert).toHaveTextContent("Always-on runs act as the agent's owner")
    await userEvent.click(within(alert).getByRole('button', { name: 'Turn it back on' }))
    await waitFor(() => expect(agentsApi.setAlwaysOn).toHaveBeenCalledWith('a1', { enabled: true }))
  })

  it('says why an always-on agent paused itself after waking too often', () => {
    renderIt(
      agent({
        alwaysOn: {
          ...ALWAYS_ON,
          enabled: false,
          pausedReason: { code: 'WAKE_LOOP', message: 'It woke 6 times in the last hour.', detectedAt: '2026-10-06T10:00:00Z' },
        },
      }),
    )
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Always on was paused because the agent woke more often in an hour than it may.')
    expect(alert).toHaveTextContent('It woke 6 times in the last hour.')
  })


  it('says an always-on agent on a hosted machine was paused for plan room, what limit it hit, that it comes back by itself, and how to make room', async () => {
    vi.mocked(agentsApi.setAlwaysOn).mockResolvedValue({} as any)
    const message =
      'Your plan includes 3 always-on agents on hosted machines, and 4 were on. This one was turned on last, so it was paused. ' +
      'It turns back on by itself when there is room: turn Always on off for another agent on a hosted machine, move this one to your own machine, or move to a plan that includes more.'
    renderIt(agent({ alwaysOn: { ...ALWAYS_ON, enabled: false, pausedReason: { code: 'CAPACITY_EXHAUSTED', message, detectedAt } } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Always on was paused because your plan includes fewer always-on agents on hosted machines than were on.')
    expect(alert).toHaveTextContent('Your plan includes 3 always-on agents on hosted machines, and 4 were on.')
    expect(alert).toHaveTextContent('It turns back on by itself as soon as there is room.')
    expect(alert).toHaveTextContent('turn Always on off for another agent on a hosted machine, run this one on your own machine, or move to a plan that includes more')
    // Inline, never a dialog; one click turns it back on.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    await userEvent.click(within(alert).getByRole('button', { name: 'Turn it back on' }))
    await waitFor(() => expect(agentsApi.setAlwaysOn).toHaveBeenCalledWith('a1', { enabled: true }))
  })
  it('shows both when the schedule and Always on were both stopped', () => {
    renderIt(
      agent({
        alwaysOn: { ...ALWAYS_ON, enabled: false, pausedReason: ownerCannotRun },
        settings: { schedule: { enabled: false, intervalMinutes: 30, input: {}, pausedReason: ownerCannotRun } },
      }),
    )
    expect(screen.getAllByRole('alert')).toHaveLength(2)
  })

  it('is rendered on the agent detail page, next to the model banner', () => {
    const page = readFileSync(join(process.cwd(), 'src/pages/agent-detail.tsx'), 'utf8')
    expect(page).toMatch(/<ModelIssueBanner agent=\{agent\} \/>\s*<ModelAvailabilityBanner agentId=\{agent\.id\} \/>\s*<PauseReasonBanner agent=\{agent\} \/>/)
  })
})
