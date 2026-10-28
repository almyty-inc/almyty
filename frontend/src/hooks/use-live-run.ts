/**
 * A run kept live from its event log while it is open and still going
 * (durable runs step 2).
 *
 * Starts from the run as listed (its row, up to its `headSeq`) and applies
 * every logged event after it. The last seq applied is kept across
 * connections: when the stream drops, times out or the server ends it
 * while the run is still going, it reconnects after that seq, so the
 * history on screen has nothing missing and nothing shown twice. An event
 * at or before the last seq is ignored; one that skips ahead means the
 * view missed something, so it reconnects from the last seq it has.
 */
import { useEffect, useRef, useState } from 'react'

import { TERMINAL_RUN_STATUSES, applyRunLogEvent, isPermanentStreamError, readRunStream } from '@/lib/run-stream'
import type { AgentRun } from '@/types'

/** 'gone': the server refused the stream for good (the run is gone or not ours to see); the view keeps what it last had. */
export type LiveRunConnection = 'off' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'gone'

/** Reconnect delays, in ms: quick at first, then backing off. */
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000]

export interface LiveRunOptions {
  /** Read a run's stream; the real one unless a test hands its own. */
  read?: typeof readRunStream
  /** Called once when the run is seen to finish, e.g. to refetch the list. */
  onFinished?: (run: AgentRun) => void
}

export function useLiveRun(agentId: string | undefined, run: AgentRun, enabled: boolean, options: LiveRunOptions = {}) {
  const [live, setLive] = useState<AgentRun>(run)
  const [connection, setConnection] = useState<LiveRunConnection>('off')
  const liveRef = useRef<AgentRun>(run)
  const lastSeq = useRef<number>(run.headSeq ?? 0)
  const read = options.read ?? readRunStream
  const onFinished = useRef(options.onFinished)
  useEffect(() => {
    onFinished.current = options.onFinished
  }, [options.onFinished])

  // A newer copy of the run from the list (a refetch) moves the view
  // forward; an older one does not move it back.
  useEffect(() => {
    if ((run.headSeq ?? 0) >= lastSeq.current) {
      liveRef.current = run
      lastSeq.current = run.headSeq ?? 0
      setLive(run)
    }
  }, [run])

  const going = !TERMINAL_RUN_STATUSES.includes(run.status)
  const watching = enabled && !!agentId && going

  useEffect(() => {
    if (!watching || !agentId) {
      setConnection('off')
      return
    }
    let stopped = false
    let attempt = 0
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let finished = false

    const apply = (event: { seq: number }) => {
      if (event.seq <= lastSeq.current) return 'old'
      if (event.seq !== lastSeq.current + 1) return 'gap'
      const next = applyRunLogEvent(liveRef.current, event as any)
      liveRef.current = next
      lastSeq.current = event.seq
      setLive(next)
      if (!finished && TERMINAL_RUN_STATUSES.includes(next.status)) {
        finished = true
        onFinished.current?.(next)
      }
      return 'applied'
    }

    const connect = () => {
      if (stopped) return
      controller = new AbortController()
      const mine = controller
      setConnection(attempt === 0 ? 'connecting' : 'reconnecting')
      let skipped = false
      read(
        agentId,
        run.id,
        lastSeq.current,
        {
          onLog: (event) => {
            setConnection('live')
            attempt = 0
            if (apply(event) === 'gap' && !skipped) {
              skipped = true
              mine.abort()
            }
          },
          onEvent: () => setConnection('live'),
          onOpen: () => setConnection('live'),
        },
        mine.signal,
      )
        .then(
          () => false,
          // An answer that will not change on retry (gone, not allowed, a bad
          // seq) ends it; a network error or a 5xx is retried.
          (err) => isPermanentStreamError(err),
        )
        .then((permanent) => {
          if (stopped) return
          if (permanent) {
            setConnection('gone')
            return
          }
          if (finished || TERMINAL_RUN_STATUSES.includes(liveRef.current.status)) {
            setConnection('ended')
            return
          }
          // The stream ended or broke while the run is still going: pick
          // up after the last seq applied.
          const delay = skipped ? 0 : RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]
          attempt++
          setConnection('reconnecting')
          timer = setTimeout(connect, delay)
        })
    }

    connect()
    return () => {
      stopped = true
      controller?.abort()
      if (timer) clearTimeout(timer)
    }
    // run.id and agentId identify the stream; the run object changes on every refetch.
  }, [watching, agentId, run.id, read])

  return { run: live, connection }
}
