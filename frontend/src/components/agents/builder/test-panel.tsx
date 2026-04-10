/**
 * Inline test panel for the agent builder. Provides a JSON input editor,
 * a run button, and an output preview pane. Appears at the bottom of the
 * builder when editing an existing workflow agent.
 */
import React, { useState } from 'react'
import { Loader2, Play, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { CodeEditor } from '@/components/ui/code-editor'
import { agentsApi } from '@/lib/api'

export interface TestPanelProps {
  agentId: string
  onClose: () => void
}

export function TestPanel({ agentId, onClose }: TestPanelProps) {
  const [testInput, setTestInput] = useState('{"message": "Hello"}')
  const [testOutput, setTestOutput] = useState<string | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  const runTest = async () => {
    if (!agentId) return
    setTestLoading(true)
    setTestOutput(null)
    try {
      const input = JSON.parse(testInput)
      const result = await agentsApi.invoke(agentId, input)
      setTestOutput(JSON.stringify(result, null, 2))
    } catch (err: any) {
      setTestOutput(`Error: ${err?.response?.data?.message || err?.message || 'Execution failed'}`)
    } finally {
      setTestLoading(false)
    }
  }

  return (
    <div className="border-t bg-muted/30 shrink-0">
      <div className="flex items-center justify-between px-4 py-2 border-b">
        <span className="text-sm font-semibold">Test Agent</span>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Close test panel" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="flex gap-4 p-4 max-h-[250px]">
        <div className="flex-1 space-y-2">
          <Label className="text-xs">Input JSON</Label>
          <CodeEditor
            value={testInput}
            onChange={(value) => setTestInput(value)}
            language="json"
            height="140px"
            placeholder='{"message": "Hello"}'
          />
          <Button size="sm" onClick={runTest} disabled={testLoading}>
            {testLoading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Play className="h-4 w-4 mr-2" />}
            Run
          </Button>
        </div>
        <div className="flex-1 space-y-2">
          <Label className="text-xs">Output</Label>
          <pre className="font-mono text-xs bg-background border rounded-md p-3 h-[170px] overflow-auto whitespace-pre-wrap">
            {testOutput || 'Run the agent to see output...'}
          </pre>
        </div>
      </div>
    </div>
  )
}
