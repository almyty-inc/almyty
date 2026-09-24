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
  agentsApi: { schedule: vi.fn(), setHeartbeat: vi.fn() },
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

  it('resumes the schedule with the interval and input it had', async () => {
    vi.mocked(agentsApi.schedule).mockResolvedValue({} as any)
    renderIt(
      agent({ settings: { schedule: { enabled: false, intervalMinutes: 45, input: { topic: 'news' }, pausedReason: ownerCannotRun } } }),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Resume schedule' }))
    await waitFor(() => expect(agentsApi.schedule).toHaveBeenCalledWith('a1', 45, { topic: 'news' }))
  })

  it('explains a heartbeat switched off for the same reason, and turns it back on as it was', async () => {
    vi.mocked(agentsApi.setHeartbeat).mockResolvedValue({} as any)
    renderIt(agent({ heartbeat: { enabled: false, intervalMinutes: 15, prompt: 'check in', pausedReason: ownerCannotRun } }))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent("The heartbeat was switched off because this agent's owner can no longer run it.")
    expect(alert).toHaveTextContent("Heartbeat runs act as the agent's owner")
    await userEvent.click(within(alert).getByRole('button', { name: 'Turn heartbeat back on' }))
    await waitFor(() =>
      expect(agentsApi.setHeartbeat).toHaveBeenCalledWith('a1', { enabled: true, intervalMinutes: 15, prompt: 'check in' }),
    )
  })

  it('shows both when the schedule and the heartbeat were both stopped', () => {
    renderIt(
      agent({
        heartbeat: { enabled: false, intervalMinutes: 15, prompt: 'p', pausedReason: ownerCannotRun },
        settings: { schedule: { enabled: false, intervalMinutes: 30, input: {}, pausedReason: ownerCannotRun } },
      }),
    )
    expect(screen.getAllByRole('alert')).toHaveLength(2)
  })

  it('is rendered on the agent detail page, next to the model banner', () => {
    const page = readFileSync(join(process.cwd(), 'src/pages/agent-detail.tsx'), 'utf8')
    expect(page).toMatch(/<ModelIssueBanner agent=\{agent\} \/>\s*<PauseReasonBanner agent=\{agent\} \/>/)
  })
})
