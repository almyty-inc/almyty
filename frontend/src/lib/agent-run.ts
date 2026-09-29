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

export interface SettleOptions {
  /** Between polls. */
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
  const { intervalMs = 1000, timeoutMs = 5 * 60 * 1000, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = options
  const first = await agentsApi.invoke(agentId, input)
  if (!isStartedAutonomousRun(first)) return first

  let run: Run = first
  const deadline = Date.now() + timeoutMs
  while (!SETTLED.has(String(run.status)) && Date.now() < deadline) {
    await wait(intervalMs)
    run = (await agentsApi.getRun(agentId, first.id)) as Run
  }
  return run
}

/** What to show for a settled run: its answer, or why there is none. */
export function runOutcome(run: any): { output?: string; error?: string } {
  if (run?.status && run.status !== 'completed') {
    if (run.status === 'waiting_input' || run.status === 'waiting_approval') {
      return { error: 'The run is waiting for someone. Open it on the Runs tab.' }
    }
    return { error: run.error || `The run ${run.status === 'running' ? 'is still going' : 'did not finish'}.` }
  }
  const output = run?.output ?? run
  return { output: typeof output === 'string' ? output : JSON.stringify(output, null, 2) }
}
