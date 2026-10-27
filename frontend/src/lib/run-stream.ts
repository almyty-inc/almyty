/**
 * A run's live progress, resumable (durable runs step 2).
 *
 * The backend's run stream (`GET /agents/:id/runs/:runId/stream?after=<seq>`)
 * sends every event of the run's log after `seq`, in order, as `run.log`
 * events whose SSE id is their seq, then keeps going live. A view keeps
 * the last seq it applied and reconnects with it, so a dropped
 * connection loses nothing and shows nothing twice.
 *
 * Read with fetch rather than EventSource: an EventSource cannot send the
 * X-Organization-Id header a member of several organizations needs on
 * every request.
 */
import { getApiBaseUrl } from '@/lib/api'
import { readCurrentOrgId } from '@/store/organization-selection'
import type { AgentRun, AgentRunStep } from '@/types'

/** One event of a run's log, as the stream sends it (backend run-events.ts). */
export interface RunLogEvent {
  seq: number
  type: string
  step: number | null
  payload: Record<string, any>
  createdAt?: string
}

/** One server-sent event. */
export interface SseMessage {
  id?: string
  event: string
  data: string
}

/** Splits a text/event-stream into messages, a chunk at a time. */
export class SseParser {
  private buffer = ''

  push(chunk: string): SseMessage[] {
    this.buffer += chunk.replace(/\r\n?/g, '\n')
    const out: SseMessage[] = []
    let end = this.buffer.indexOf('\n\n')
    while (end !== -1) {
      const block = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 2)
      const message: SseMessage = { event: 'message', data: '' }
      const data: string[] = []
      for (const line of block.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon === -1 ? line : line.slice(0, colon)
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') message.event = value
        else if (field === 'data') data.push(value)
        else if (field === 'id') message.id = value
      }
      message.data = data.join('\n')
      if (data.length || message.id !== undefined) out.push(message)
      end = this.buffer.indexOf('\n\n')
    }
    return out
  }
}

export const TERMINAL_RUN_STATUSES: ReadonlyArray<AgentRun['status']> = ['completed', 'failed', 'cancelled', 'timeout']

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v)

function applyObjectChange(current: any, change: Record<string, any>): any {
  if ('replace' in change) return change.replace
  const next = { ...(isObject(current) ? current : {}) }
  for (const [key, value] of Object.entries(change.set ?? {})) next[key] = value
  for (const key of change.unset ?? []) delete next[key]
  return next
}

/**
 * A run as a view shows it, with one more logged event applied: the same
 * fold the backend checks its rows against (projectRunEvents), for the
 * fields the run view shows. A marker event changes nothing.
 */
export function applyRunLogEvent(run: AgentRun, event: RunLogEvent): AgentRun {
  const p = event.payload ?? {}
  const next: AgentRun = { ...run, headSeq: event.seq }
  switch (event.type) {
    case 'run_started':
      return {
        ...next,
        status: p.status ?? run.status,
        currentStep: p.currentStep ?? 0,
        output: p.output ?? undefined,
        error: p.error ?? undefined,
        metadata: p.metadata ?? undefined,
        steps: Array.isArray(p.steps) ? [...p.steps] : [],
        totalCost: 0,
        totalTokens: 0,
        executionTime: 0,
      }
    case 'model_call':
    case 'step_recorded':
    case 'tool_call': {
      const steps = [...(run.steps ?? [])]
      steps[p.index] = { ...(p.step as AgentRunStep) }
      return { ...next, steps }
    }
    case 'tool_result': {
      const steps = [...(run.steps ?? [])]
      steps[p.index] = { ...steps[p.index], ...p.result }
      return { ...next, steps }
    }
    case 'step_replaced': {
      const steps = [...(run.steps ?? [])]
      steps[p.index] = p.step
      return { ...next, steps }
    }
    case 'steps_reset':
      return { ...next, steps: Array.isArray(p.steps) ? [...p.steps] : [] }
    case 'metadata_changed':
      return { ...next, metadata: applyObjectChange(run.metadata, p) }
    case 'memory_changed':
      return run.workingMemory === undefined ? next : { ...next, workingMemory: applyObjectChange(run.workingMemory, p) }
    case 'step_committed':
      return {
        ...next,
        status: p.status ?? run.status,
        currentStep: p.currentStep ?? run.currentStep,
        totalCost: p.totalCost ?? run.totalCost,
        totalTokens: p.totalTokens ?? run.totalTokens,
        executionTime: p.executionTime ?? run.executionTime,
        ...('output' in p ? { output: p.output } : {}),
        ...('error' in p ? { error: p.error ?? undefined } : {}),
      }
    default:
      return next
  }
}

/** Where a run's stream is read from, resuming after `after`. */
export function runStreamUrl(agentId: string, runId: string, after: number): string {
  return `${getApiBaseUrl()}/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream?after=${after}`
}

export interface RunStreamHandlers {
  /** A logged event, in seq order. */
  onLog: (event: RunLogEvent) => void
  /** Anything else the stream sends (live progress, `stream.timeout`, `done`). */
  onEvent?: (type: string, data: any) => void
  /** The server answered: the stream is open, whether or not anything has happened yet. */
  onOpen?: () => void
}

/**
 * Read a run's stream from `after` until the server ends it. Resolves when
 * it ends; rejects when the connection cannot be made or breaks.
 */
export async function readRunStream(
  agentId: string,
  runId: string,
  after: number,
  handlers: RunStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  const orgId = readCurrentOrgId()
  if (orgId) headers['X-Organization-Id'] = orgId
  const response = await fetch(runStreamUrl(agentId, runId, after), { credentials: 'include', headers, signal })
  if (!response.ok || !response.body) throw new Error(`Run stream answered ${response.status}`)
  handlers.onOpen?.()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) return
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      let data: any = null
      try {
        data = message.data ? JSON.parse(message.data) : null
      } catch {
        continue
      }
      if (message.event === 'run.log' && data) handlers.onLog(data as RunLogEvent)
      else handlers.onEvent?.(message.event, data)
    }
  }
}
