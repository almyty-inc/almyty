/**
 * Durable runs step 2: an open run that is still going follows its event
 * log live, and a dropped connection resumes after the last event it
 * showed, so the run's history on screen has nothing missing and nothing
 * twice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, screen, fireEvent, waitFor } from '@testing-library/react'

import { renderWithProviders } from '@/test/setup'
import { RunsTab } from '@/components/agents/detail/runs-tab'
import { useLiveRun } from '@/hooks/use-live-run'
import { SseParser, applyRunLogEvent, readRunStream, type RunLogEvent } from '@/lib/run-stream'
import type { AgentRun } from '@/types'

vi.mock('@/lib/api', () => ({
  promotedSkillsApi: { promote: vi.fn() },
  api: { get: vi.fn() },
  getApiBaseUrl: () => 'https://api.test',
}))
vi.mock('@/store/app', () => ({ useNotifications: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/store/organization-selection', () => ({ readCurrentOrgId: () => 'org-2' }))

const running = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-1', agentId: 'agent-1', organizationId: 'org-1', mode: 'autonomous', status: 'running',
  thread: [], workingMemory: {}, currentStep: 1, maxSteps: 20, totalCost: 0.01, totalTokens: 50,
  executionTime: 900, createdAt: '2026-10-27T10:00:00Z', updatedAt: '2026-10-27T10:00:01Z',
  steps: [{ type: 'llm_call', timestamp: 't0', output: 'first look' }],
  headSeq: 4,
  ...over,
})

/** The events of one step commit, as the backend logs them (run-events.ts). */
const commit = (from: number, index: number, over: Record<string, any> = {}): RunLogEvent[] => [
  { seq: from, type: 'tool_call', step: index, payload: { index, callIndex: 0, step: { type: 'tool_call', input: { tool: 'crm_lookup' }, timestamp: `t${index}` } } },
  { seq: from + 1, type: 'tool_result', step: index, payload: { index, callIndex: 0, result: { output: `answer ${index}`, duration: 12 } } },
  {
    seq: from + 2,
    type: 'step_committed',
    step: index,
    payload: { status: 'running', currentStep: index + 1, totalCost: 0.01 * (index + 1), totalTokens: 50 * (index + 1), toolCallCount: index, executionTime: 900, ...over },
  },
]

describe('reading the stream', () => {
  it('splits server-sent events wherever a chunk ends, keeping ids, skipping comments', () => {
    const parser = new SseParser()
    const text = 'id: 5\nevent: run.log\ndata: {"seq":5}\n\n: keep-alive\n\nevent: llm.chunk\ndata: {"x":1}\n\n'
    const out = [...parser.push(text.slice(0, 13)), ...parser.push(text.slice(13, 40)), ...parser.push(text.slice(40))]
    expect(out).toEqual([
      { id: '5', event: 'run.log', data: '{"seq":5}' },
      { event: 'llm.chunk', data: '{"x":1}' },
    ])
  })

  it('folds a commit into the run the way the backend folds it into the row', () => {
    let run = running()
    for (const e of commit(5, 1, { status: 'completed', output: 'All set.' })) run = applyRunLogEvent(run, e)
    expect(run.headSeq).toBe(7)
    expect(run.status).toBe('completed')
    expect(run.output).toBe('All set.')
    expect(run.steps).toEqual([
      { type: 'llm_call', timestamp: 't0', output: 'first look' },
      { type: 'tool_call', input: { tool: 'crm_lookup' }, timestamp: 't1', output: 'answer 1', duration: 12 },
    ])
    expect(run.currentStep).toBe(2)
  })

  it('asks after the seq, with the cookie and the selected organization', async () => {
    const fetchMock = vi.fn(async () => new Response('id: 3\nevent: run.log\ndata: {"seq":3,"type":"status_changed","step":0,"payload":{}}\n\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const seen: number[] = []
    await readRunStream('agent-1', 'run-1', 2, { onLog: (e) => seen.push(e.seq) })
    expect(fetchMock).toHaveBeenCalledWith('https://api.test/agents/agent-1/runs/run-1/stream?after=2', {
      credentials: 'include',
      headers: { Accept: 'text/event-stream', 'X-Organization-Id': 'org-2' },
      signal: undefined,
    })
    expect(seen).toEqual([3])
    vi.unstubAllGlobals()
  })
})

describe('useLiveRun', () => {
  it('resumes from the last seq it applied after the connection breaks, and applies nothing twice', async () => {
    const afters: number[] = []
    let call = 0
    const read = vi.fn(async (_agentId: string, _runId: string, after: number, handlers: any) => {
      afters.push(after)
      call++
      if (call === 1) {
        for (const e of commit(5, 1)) handlers.onLog(e)
        throw new Error('network dropped')
      }
      // The server sends from the seq asked for; an old one is ignored all the same.
      handlers.onLog(commit(5, 1)[2])
      for (const e of commit(8, 2, { status: 'completed', output: 'Done.' })) handlers.onLog(e)
    })
    const onFinished = vi.fn()
    const { result } = renderHook(() => useLiveRun('agent-1', running(), true, { read: read as any, onFinished }))

    await waitFor(() => expect(result.current.run.status).toBe('completed'), { timeout: 3000 })
    expect(afters).toEqual([4, 7])
    expect(result.current.run.headSeq).toBe(10)
    expect(result.current.run.steps.map((s) => s.output)).toEqual(['first look', 'answer 1', 'answer 2'])
    expect(onFinished).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.connection).toBe('ended'))
  })

  it('an event that skips ahead: reconnects from the last seq it has instead of showing a hole', async () => {
    const afters: number[] = []
    let call = 0
    const read = vi.fn(async (_a: string, _r: string, after: number, handlers: any, signal: AbortSignal) => {
      afters.push(after)
      call++
      if (call === 1) {
        handlers.onLog(commit(5, 1)[0])
        handlers.onLog(commit(5, 1)[2]) // seq 7 with 6 missing
        expect(signal.aborted).toBe(true)
        return
      }
      for (const e of commit(5, 1, { status: 'completed' }).slice(1)) handlers.onLog(e)
    })
    const { result } = renderHook(() => useLiveRun('agent-1', running(), true, { read: read as any }))
    await waitFor(() => expect(result.current.run.status).toBe('completed'))
    expect(afters).toEqual([4, 5])
    expect(result.current.run.steps[1]).toMatchObject({ output: 'answer 1', duration: 12 })
  })

  it('a finished run, or a closed one, is not streamed', () => {
    const read = vi.fn()
    renderHook(() => useLiveRun('agent-1', running({ status: 'completed' }), true, { read: read as any }))
    renderHook(() => useLiveRun('agent-1', running(), false, { read: read as any }))
    expect(read).not.toHaveBeenCalled()
  })
})

describe('the runs tab, live', () => {
  /** A fetch that answers each call with the next stream body, then hangs up. */
  const streams = (bodies: string[]) => {
    const calls: string[] = []
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url)
      const body = bodies.shift()
      if (body === undefined) return new Promise<Response>(() => undefined)
      return new Response(body, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    return calls
  }
  const sse = (events: RunLogEvent[]) => events.map((e) => `id: ${e.seq}\nevent: run.log\ndata: ${JSON.stringify(e)}\n\n`).join('')

  beforeEach(() => vi.useRealTimers())
  afterEach(() => vi.unstubAllGlobals())

  it('an open run shows its new steps as they land, and after a dropped connection carries on from where it was', async () => {
    const calls = streams([
      // First connection: one step, then the connection drops.
      sse(commit(5, 1)),
      // Second: the next step and the end of the run.
      sse(commit(8, 2, { status: 'completed', output: 'Refund issued.' })),
    ])
    renderWithProviders(<RunsTab agentId="agent-1" runs={[running()]} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))

    expect(await screen.findByText(/answer 1/)).toBeInTheDocument()
    expect(await screen.findByText(/answer 2/, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(calls).toEqual([
      'https://api.test/agents/agent-1/runs/run-1/stream?after=4',
      'https://api.test/agents/agent-1/runs/run-1/stream?after=7',
    ])
    // History intact: each step once, in order.
    expect(screen.getAllByTestId(/^run-step-\d+$/).map((el) => el.getAttribute('data-testid'))).toEqual(['run-step-0', 'run-step-1', 'run-step-2'])
    expect(screen.getAllByText(/answer 1/)).toHaveLength(1)
    expect(await screen.findByText('Refund issued.')).toBeInTheDocument()
  })

  it('says it is live as soon as the stream is open, before anything has happened', async () => {
    // An open stream on which nothing arrives yet.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start() {} }), { status: 200 })))
    renderWithProviders(<RunsTab agentId="agent-1" runs={[running()]} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(await screen.findByTestId('run-live')).toHaveTextContent('Live')
    expect(screen.queryByTestId('run-reconnecting')).not.toBeInTheDocument()
  })

  it.each([400, 401, 403, 404, 410])('a %i ends it: no retry, the last known state stays, and a plain note says so', async (status) => {
    const fetchMock = vi.fn(async () => new Response('{"success":false}', { status }))
    vi.stubGlobal('fetch', fetchMock)
    renderWithProviders(<RunsTab agentId="agent-1" runs={[running()]} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(await screen.findByTestId('run-gone')).toHaveTextContent('This run is no longer available')
    // Longer than the first reconnect delay: nothing asked again.
    await new Promise((r) => setTimeout(r, 800))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/first look/)).toBeInTheDocument()
    expect(screen.queryByTestId('run-reconnecting')).not.toBeInTheDocument()
  })

  it('a 5xx or a network error is retried', async () => {
    let call = 0
    const fetchMock = vi.fn(async () => {
      call++
      if (call === 1) return new Response('', { status: 503 })
      if (call === 2) throw new TypeError('Failed to fetch')
      return new Response(new ReadableStream({ start() {} }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderWithProviders(<RunsTab agentId="agent-1" runs={[running()]} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(await screen.findByTestId('run-live', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(screen.queryByTestId('run-gone')).not.toBeInTheDocument()
  })
})
