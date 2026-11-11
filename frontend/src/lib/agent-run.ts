import { agentsApi } from '@/lib/api'

/**
 * Run an agent and hand back the run once it has settled.
 *
 * `POST /agents/:id/invoke` answers a workflow agent with the finished
 * execution, but an autonomous agent with the run it has just STARTED
 * (`status: 'running'`, `output: null`): the loop goes on in the
 * background. A caller that shows the answer has to wait for it, or it
 * shows a running run as if it were the result. This polls the run until
 * it finishes, fails, or stops to wait for someone.
 */

/** Statuses a run does not leave on its own. */
const SETTLED = new Set(['completed', 'failed', 'cancelled', 'timeout', 'waiting_input', 'waiting_approval', 'sleeping'])

/**
 * How long Try it and the Run panel wait for a run by default: the
 * operator's ceiling on a run's duration (RUN_LIMIT_MAX_DURATION_MS, an
 * hour unless set). The backend ends every run within its run limits (15
 * minutes unless the agent or organization says otherwise), so a run
 * settles before this; it is a backstop. Five minutes was shorter than a
 * run may take: real coding assistants on a runner took six, and Try it
 * said "The run is still going." for good while the answer arrived on
 * the Runs tab.
 */
export const SETTLE_TIMEOUT_MS = 60 * 60 * 1000

/** After the first minute, poll this often: a long run needs no request a second. */
export const SLOW_INTERVAL_MS = 5000

/** Polls in a row that may fail before the wait gives up with the error. */
export const MAX_FAILED_POLLS = 3

export interface SettleOptions {
  /** Between polls in the first minute; SLOW_INTERVAL_MS after it. */
  intervalMs?: number
  /** Give up and return the run as it stands after this long. */
  timeoutMs?: number
  /** Test seam. */
  wait?: (ms: number) => Promise<void>
}

type Run = { id?: string; mode?: string; status?: string; output?: unknown; error?: string | null }

function isStartedAutonomousRun(result: unknown): result is Run & { id: string } {
  const run = result as Run | null
  return !!run && typeof run.id === 'string' && run.mode === 'autonomous' && !SETTLED.has(String(run.status))
}

export async function invokeAndSettle(agentId: string, input: unknown, options: SettleOptions = {}): Promise<any> {
  const { intervalMs = 1000, timeoutMs = SETTLE_TIMEOUT_MS, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = options
  const first = await agentsApi.invoke(agentId, input)
  if (!isStartedAutonomousRun(first)) return first

  let run: Run = first
  const started = Date.now()
  const deadline = started + timeoutMs
  // A long run is polled hundreds of times; one failed poll (a restart, a
  // dropped connection) is not the run failing. Several in a row are.
  let failedPolls = 0
  while (!SETTLED.has(String(run.status)) && Date.now() < deadline) {
    await wait(Date.now() - started < 60_000 ? intervalMs : Math.max(intervalMs, SLOW_INTERVAL_MS))
    try {
      run = (await agentsApi.getRun(agentId, first.id)) as Run
      failedPolls = 0
    } catch (err) {
      failedPolls += 1
      if (failedPolls >= MAX_FAILED_POLLS) throw err
    }
  }
  return run
}

/** "Waiting for your approval: 3 changes." from a run that waits in Approvals, or the plain line when it carries none. */
export function waitingLine(run: { error?: string | null } | null | undefined): string {
  const said = typeof run?.error === 'string' ? run.error.trim() : ''
  return said.startsWith('Waiting for your approval') ? said : 'Waiting for your approval.'
}

/** What to show for a settled run: its answer, or why there is none. */
export function runOutcome(run: any): { output?: string; error?: string } {
  if (run?.status && run.status !== 'completed') {
    if (run.status === 'waiting_approval') {
      return { error: `${waitingLine(run)} Open Approvals to decide; the run carries on once you do.` }
    }
    if (run.status === 'waiting_input') {
      return { error: 'The run is waiting for someone. Open it on the Runs tab.' }
    }
    return { error: run.error || `The run ${run.status === 'running' ? 'is still going' : 'did not finish'}.` }
  }
  const output = run?.output ?? run
  return { output: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }
}
