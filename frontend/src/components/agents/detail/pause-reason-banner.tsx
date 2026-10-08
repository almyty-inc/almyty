import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, PauseCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { Agent, AgentPauseReason } from '@/types'
import { formatDateTime } from '@/lib/utils'
import { requestFromStored } from '@/lib/schedule'

type Kind = 'schedule' | 'always_on'

/**
 * What happened, in the words a person reading the agent page needs.
 * `MODEL_NOT_FOUND` is not here: ModelIssueBanner owns that one.
 */
const runs = (kind: Kind) => (kind === 'schedule' ? 'Scheduled runs' : 'Always-on runs')
const restart = (kind: Kind) => (kind === 'schedule' ? 'resume the schedule' : 'turn Always on back on')
const onCopy = (kind: Kind) => (kind === 'schedule' ? 'schedule the copy instead' : 'turn Always on on for the copy instead')
const stopped = (kind: Kind) => (kind === 'schedule' ? 'paused' : 'switched off')
const named = (kind: Kind) => (kind === 'schedule' ? 'schedule' : 'Always on setting')

const COPY: Record<AgentPauseReason['code'], { what: (kind: Kind) => string; fix: (kind: Kind) => string }> = {
  OWNER_CANNOT_RUN: {
    what: (kind) => `The ${named(kind)} was ${stopped(kind)} because this agent's owner can no longer run it.`,
    fix: (kind) =>
      `${runs(kind)} act as the agent's owner. Add the owner back to the agent's team and ${restart(kind)}, ` +
      `or duplicate the agent to own a copy and ${onCopy(kind)}.`,
  },
  OWNER_NOT_MEMBER: {
    what: (kind) =>
      `The ${named(kind)} was ${stopped(kind)} because the member who owns this agent is no longer active in the organization.`,
    fix: (kind) =>
      `${runs(kind)} act as the agent's owner. Once they are an active member again, ${restart(kind)}, ` +
      `or duplicate the agent to own a copy and ${onCopy(kind)}.`,
  },
  RESTORE_FAILED: {
    what: (kind) => `The ${named(kind)} was paused because it could not be restored when the service restarted.`,
    fix: (kind) => `Nothing about the agent needs to change. ${kind === 'schedule' ? 'Resume the schedule' : 'Turn Always on back on'} to start it again.`,
  },
  WAKE_LOOP: {
    what: () => 'Always on was paused because the agent woke more often in an hour than it may.',
    fix: () =>
      'Something kept waking it: a webhook that fires too often, or a channel it reports into and also listens to. ' +
      'Look at what woke it on its Always on page, change that, then turn Always on back on.',
  },
  CAPACITY_EXHAUSTED: {
    what: () => 'Always on was paused because your plan includes fewer always-on agents than were on.',
    fix: () =>
      'It turns back on by itself as soon as there is room. To make room now, turn Always on off for another agent, ' +
      'or move to a plan that includes more. Once there is room you can also turn it back on here.',
  },
  IDENTITY_LAPSED: {
    what: (kind) =>
      `The ${named(kind)} was ${stopped(kind)} because this agent acts as itself, which needs the Business plan, and the plan no longer includes it. It was not run as its owner instead.`,
    fix: (kind) =>
      `Upgrade to Business and ${restart(kind)}, or switch Acts as back to its owner under Capabilities and ${restart(kind)}.`,
  },
}

const known = (reason: unknown): reason is AgentPauseReason =>
  !!reason && typeof reason === 'object' && (reason as any).code in COPY

/**
 * Shown when the backend switched this agent's schedule or Always on off on
 * its own -- its owner can no longer run it, an always-on agent kept waking itself, or the schedule did not survive
 * a restart. Without it the only trace is a failed run in the history and a
 * schedule that quietly stopped.
 */
export function PauseReasonBanner({ agent }: { agent: Agent }) {
  const schedule = agent.settings?.schedule
  const alwaysOn = agent.alwaysOn
  const items: Array<{ kind: Kind; reason: AgentPauseReason }> = []
  if (schedule && !schedule.enabled && known(schedule.pausedReason)) {
    items.push({ kind: 'schedule', reason: schedule.pausedReason })
  }
  if (alwaysOn && !alwaysOn.enabled && known(alwaysOn.pausedReason)) {
    items.push({ kind: 'always_on', reason: alwaysOn.pausedReason })
  }
  if (items.length === 0) return null
  return (
    <>
      {items.map((item) => (
        <PausedNotice key={item.kind} agent={agent} kind={item.kind} reason={item.reason} />
      ))}
    </>
  )
}

function PausedNotice({ agent, kind, reason }: { agent: Agent; kind: Kind; reason: AgentPauseReason }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const copy = COPY[reason.code]
  const when = new Date(reason.detectedAt)
  const whenLabel = Number.isNaN(when.getTime()) ? '' : formatDateTime(when)

  const resume = useMutation({
    mutationFn: () => {
      if (kind === 'schedule') {
        // The whole stored schedule, so a time-of-day one resumes as it was.
        return agentsApi.schedule(agent.id, requestFromStored(agent.settings!.schedule!))
      }
      return agentsApi.setAlwaysOn(agent.id, { enabled: true })
    },
    onSuccess: async () => {
      success(kind === 'schedule' ? 'Schedule resumed' : 'Always on is back on')
      await queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
      await queryClient.invalidateQueries({ queryKey: ['agent-always-on', agent.id] })
    },
    onError: (err: any) => {
      errorNotif(
        kind === 'schedule' ? 'Could not resume the schedule' : 'Could not turn Always on back on',
        getApiErrorMessage(err, 'Please try again.'),
      )
    },
  })

  return (
    <div
      role="alert"
      data-pause-kind={kind}
      className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <div className="space-y-1">
        <p className="font-medium">{copy.what(kind)}</p>
        <p className="text-muted-foreground">
          {reason.message}
          {whenLabel && <> Detected {whenLabel}.</>}
        </p>
        <p>{copy.fix(kind)}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-1"
          disabled={resume.isPending}
          onClick={() => resume.mutate()}
        >
          {resume.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {kind === 'schedule' ? 'Resume schedule' : 'Turn it back on'}
        </Button>
      </div>
    </div>
  )
}
