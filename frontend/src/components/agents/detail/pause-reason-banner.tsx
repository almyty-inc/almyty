import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, PauseCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { Agent, AgentPauseReason } from '@/types'

type Kind = 'schedule' | 'heartbeat'

/**
 * What happened, in the words a person reading the agent page needs.
 * `MODEL_NOT_FOUND` is not here: ModelIssueBanner owns that one.
 */
const runs = (kind: Kind) => (kind === 'schedule' ? 'Scheduled runs' : 'Heartbeat runs')
const restart = (kind: Kind) => (kind === 'schedule' ? 'resume the schedule' : 'turn the heartbeat back on')
const onCopy = (kind: Kind) => (kind === 'schedule' ? 'schedule the copy instead' : 'give the copy the heartbeat instead')
const stopped = (kind: Kind) => (kind === 'schedule' ? 'paused' : 'switched off')

const COPY: Record<AgentPauseReason['code'], { what: (kind: Kind) => string; fix: (kind: Kind) => string }> = {
  OWNER_CANNOT_RUN: {
    what: (kind) => `The ${kind} was ${stopped(kind)} because this agent's owner can no longer run it.`,
    fix: (kind) =>
      `${runs(kind)} act as the agent's owner. Add the owner back to the agent's team and ${restart(kind)}, ` +
      `or duplicate the agent to own a copy and ${onCopy(kind)}.`,
  },
  OWNER_NOT_MEMBER: {
    what: (kind) =>
      `The ${kind} was ${stopped(kind)} because the member who owns this agent is no longer active in the organization.`,
    fix: (kind) =>
      `${runs(kind)} act as the agent's owner. Once they are an active member again, ${restart(kind)}, ` +
      `or duplicate the agent to own a copy and ${onCopy(kind)}.`,
  },
  RESTORE_FAILED: {
    what: (kind) => `The ${kind} was paused because it could not be restored when the service restarted.`,
    fix: (kind) => `Nothing about the agent needs to change. ${kind === 'schedule' ? 'Resume the schedule' : 'Turn the heartbeat back on'} to start it again.`,
  },
}

const known = (reason: unknown): reason is AgentPauseReason =>
  !!reason && typeof reason === 'object' && (reason as any).code in COPY

/**
 * Shown when the backend switched this agent's schedule or heartbeat off on
 * its own -- its owner can no longer run it, or the schedule did not survive
 * a restart. Without it the only trace is a failed run in the history and a
 * schedule that quietly stopped.
 */
export function PauseReasonBanner({ agent }: { agent: Agent }) {
  const schedule = agent.settings?.schedule
  const heartbeat = agent.heartbeat
  const items: Array<{ kind: Kind; reason: AgentPauseReason }> = []
  if (schedule && !schedule.enabled && known(schedule.pausedReason)) {
    items.push({ kind: 'schedule', reason: schedule.pausedReason })
  }
  if (heartbeat && !heartbeat.enabled && known(heartbeat.pausedReason)) {
    items.push({ kind: 'heartbeat', reason: heartbeat.pausedReason })
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
  const whenLabel = Number.isNaN(when.getTime()) ? '' : when.toLocaleString()

  const resume = useMutation({
    mutationFn: () => {
      if (kind === 'schedule') {
        const s = agent.settings!.schedule!
        return agentsApi.schedule(agent.id, s.intervalMinutes, s.input ?? {})
      }
      const h = agent.heartbeat!
      return agentsApi.setHeartbeat(agent.id, { enabled: true, intervalMinutes: h.intervalMinutes, prompt: h.prompt })
    },
    onSuccess: async () => {
      success(kind === 'schedule' ? 'Schedule resumed' : 'Heartbeat back on')
      await queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
    },
    onError: (err: any) => {
      errorNotif(
        kind === 'schedule' ? 'Could not resume the schedule' : 'Could not turn the heartbeat back on',
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
          {kind === 'schedule' ? 'Resume schedule' : 'Turn heartbeat back on'}
        </Button>
      </div>
    </div>
  )
}
