/**
 * Modal dialog for invoking an agent with custom JSON input.
 * Displays the execution result or error after invocation.
 */
import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Play, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { CodeEditor } from '@/components/ui/code-editor'
import { CodeBlock } from '@/components/ui/code-block'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'

import { agentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'

interface InvokeDialogProps {
  agent: Agent
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function InvokeDialog({ agent, open, onOpenChange }: InvokeDialogProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [invokeInput, setInvokeInput] = useState('{\n  "message": "Hello"\n}')
  const [invokeResult, setInvokeResult] = useState<Record<string, unknown> | null>(null)

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
        success('Agent ran', 'The run finished.')
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
      ])
    },
    onError: (err: unknown) => {
      errorNotif('Invocation Failed', getApiErrorMessage(err, 'Failed to invoke agent'))
    },
  })

  const failed = !!invokeResult && (invokeResult as any).status !== 'completed'
  const output = (invokeResult as any)?.output

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Invoke Agent</DialogTitle>
          <DialogDescription>
            Provide input JSON to run "{agent.name}".
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="invoke-input">Input JSON</Label>
            <CodeEditor
              value={invokeInput}
              onChange={(value) => setInvokeInput(value)}
              language="json"
              height="160px"
            />
          </div>
          <Button
            className="w-full"
            onClick={() => invokeMutation.mutate()}
            disabled={invokeMutation.isPending}
          >
            {invokeMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Running...
              </>
            ) : (
              <>
                <Play className="h-4 w-4 mr-2" />
                Run Agent
              </>
            )}
          </Button>

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
                        className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm"
                      >
                        {output}
                      </p>
                    ) : (
                      <CodeBlock value={JSON.stringify(output, null, 2)} language="json" maxHeight="200px" />
                    )}
                  </div>
                </div>
              )}
              <details>
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  Full execution record
                </summary>
                <div className="mt-1">
                  <CodeBlock value={JSON.stringify(invokeResult, null, 2)} language="json" maxHeight="200px" />
                </div>
              </details>
            </div>
          )}

          {invokeMutation.isError && (
            <div role="alert" className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {getApiErrorMessage(invokeMutation.error, 'Execution failed')}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
