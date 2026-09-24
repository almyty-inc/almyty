/**
 * Inline panel for running an agent with custom JSON input, opened by the
 * header's "Run" button and rendered in the detail view above the stats.
 * Displays the run's output or the reason it failed, and stays open so
 * the input can be tweaked and run again.
 *
 * Copy here says "run" throughout -- the same word the header button,
 * the Runs tab and the stat cards use. It used to be titled "Invoke
 * Agent" over a "Run Agent" button, reporting an "Invocation Failed".
 */
import React, { useEffect, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Loader2, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { CodeEditor } from '@/components/ui/code-editor'
import { CodeBlock } from '@/components/ui/code-block'

import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

const DEFAULT_INPUT = '{\n  "message": "Hello"\n}'

interface RunPanelProps {
  agent: Agent
  onClose: () => void
}

export function RunPanel({ agent, onClose }: RunPanelProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const sectionRef = useRef<HTMLElement>(null)

  const [invokeInput, setInvokeInput] = useState(DEFAULT_INPUT)
  const [invokeResult, setInvokeResult] = useState<Record<string, unknown> | null>(null)
  // Input edited since the last run (or since the panel opened) asks before
  // a navigation throws it away. Running it, or closing the panel, does not.
  const [lastRunInput, setLastRunInput] = useState(DEFAULT_INPUT)
  const guard = useLeaveGuard(invokeInput !== lastRunInput)

  // Opened from the header: bring the panel into view on small screens,
  // where it would otherwise start below the fold.
  useEffect(() => {
    sectionRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [])

  const invokeMutation = useMutation({
    onMutate: () => setInvokeResult(null),
    mutationFn: async () => {
      let input: any
      try {
        input = JSON.parse(invokeInput)
      } catch {
        throw new Error('Invalid JSON input')
      }
      return agentsApi.invoke(agent.id, input)
    },
    // A run that finishes is not a run that worked. The endpoint answers
    // 200 with `status: 'failed'` and an `error` string in the body, and
    // this used to raise "Execution completed." over it while printing
    // the whole execution row -- ids and nulls included -- as the result.
    onSuccess: async (result: any) => {
      setInvokeResult(result)
      if (result?.status === 'completed') {
        success('Run finished', 'The agent finished this run.')
      } else {
        errorNotif(
          result?.status === 'cancelled' ? 'Run cancelled' : 'Run failed',
          result?.error || 'The agent did not finish this run.',
        )
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['agent-executions', agent.id] }),
        queryClient.invalidateQueries({ queryKey: ['agent-runs', agent.id] }),
        queryClient.invalidateQueries({ queryKey: ['agent', agent.id] }),
        // The list's run count is read from this key, and it went on
        // saying the old number until a reload.
        queryClient.invalidateQueries({ queryKey: ['agents'] }),
        // The run-failure banner at the top of this page reads its own
        // key with a 15s staleTime, so a run that just failed here did
        // not raise the banner until that window passed.
        queryClient.invalidateQueries({ queryKey: ['agent-latest-run', agent.id] }),
      ])
    },
    onError: (err: unknown) => {
      errorNotif('Run failed', getApiErrorMessage(err, 'Failed to start the run'))
    },
  })

  const failed = !!invokeResult && (invokeResult as any).status !== 'completed'
  const output = (invokeResult as any)?.output

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (invokeMutation.isPending) return
    setLastRunInput(invokeInput)
    invokeMutation.mutate()
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby="run-panel-title"
      data-testid="run-panel"
      className="space-y-4 rounded-xl border bg-card p-4 text-card-foreground sm:p-6"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 id="run-panel-title" className="text-base font-semibold">Run agent</h2>
          <p className="text-sm text-muted-foreground">
            Provide input JSON to run "{agent.name}".
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          aria-label="Close run panel"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <form onSubmit={submit} noValidate className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="invoke-input">Input JSON</Label>
          <CodeEditor
            value={invokeInput}
            onChange={(value) => setInvokeInput(value)}
            language="json"
            height="160px"
          />
        </div>
        <div className="flex justify-end">
          <Button type="submit" className="w-full sm:w-auto" disabled={invokeMutation.isPending}>
            {invokeMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Run agent
              </>
            )}
          </Button>
        </div>
      </form>

      {invokeResult && (
        <div className="space-y-2">
          {/*
            What the agent said, or why it did not say anything --
            the raw execution row is still one click away for
            debugging, but it is no longer the answer.
          */}
          {failed ? (
            <div role="alert" data-testid="invoke-failed" className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {(invokeResult as any).error || 'The agent did not finish this run.'}
            </div>
          ) : (
            <div role="status" aria-live="polite">
              <Label>Output</Label>
              <div className="mt-1">
                {output === null || output === undefined ? (
                  <p data-testid="invoke-no-output" className="text-sm text-muted-foreground">
                    The run finished without producing any output.
                  </p>
                ) : typeof output === 'string' ? (
                  // An agent's answer is prose. Putting it in a code
                  // editor made a sentence look like a payload.
                  <p
                    data-testid="invoke-output-text"
                    className="whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-sm"
                  >
                    {output}
                  </p>
                ) : (
                  <CodeBlock value={JSON.stringify(output, null, 2)} language="json" maxHeight="320px" />
                )}
              </div>
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              Full run record
            </summary>
            <div className="mt-1">
              <CodeBlock value={JSON.stringify(invokeResult, null, 2)} language="json" maxHeight="320px" />
            </div>
          </details>
        </div>
      )}

      {invokeMutation.isError && (
        <div role="alert" className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
          {getApiErrorMessage(invokeMutation.error, 'The run failed.')}
        </div>
      )}
      {guard.element}
    </section>
  )
}