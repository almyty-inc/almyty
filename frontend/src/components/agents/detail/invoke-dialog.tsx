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
    mutationFn: async () => {
      let input: any
      try {
        input = JSON.parse(invokeInput)
      } catch {
        throw new Error('Invalid JSON input')
      }
      return agentsApi.invoke(agent.id, input)
    },
    onSuccess: (result) => {
      setInvokeResult(result)
      success('Agent Invoked', 'Execution completed.')
      queryClient.invalidateQueries({ queryKey: ['agent-executions', agent.id] })
      queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
    },
    onError: (err: any) => {
      errorNotif('Invocation Failed', err?.response?.data?.message || err?.message || 'Failed to invoke agent')
    },
  })

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
            <div>
              <Label>Result</Label>
              <div className="mt-1">
                <CodeBlock value={JSON.stringify(invokeResult, null, 2)} language="json" maxHeight="200px" />
              </div>
            </div>
          )}

          {invokeMutation.error && (
            <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
              {(invokeMutation.error as any)?.message || 'Execution failed'}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
