import React from 'react'
import { TestTube } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface TestProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  testProvider: any | null
  testInput: string
  onTestInputChange: (value: string) => void
  onTest: () => void
  testLoading: boolean
  testResult: any | null
}

export function TestProviderDialog({
  open,
  onOpenChange,
  testProvider,
  testInput,
  onTestInputChange,
  onTest,
  testLoading,
  testResult,
}: TestProviderDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Test Provider: {testProvider?.name}</DialogTitle>
          <DialogDescription>
            Send a test request to validate provider configuration and connectivity
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-4">
            <div>
              <Label>Test Input</Label>
              <Textarea
                placeholder="Enter test prompt..."
                value={testInput}
                onChange={(e) => onTestInputChange(e.target.value)}
                className="h-64"
              />
            </div>
            <Button
              onClick={onTest}
              disabled={testLoading}
              className="w-full gap-2"
            >
              {testLoading ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                  Testing...
                </>
              ) : (
                <>
                  <TestTube className="h-4 w-4" />
                  Test Provider
                </>
              )}
            </Button>
          </div>

          <div className="space-y-4">
            <Label>Test Result</Label>
            <div className="h-64 border rounded-md p-4 bg-muted font-mono text-sm overflow-auto">
              {testResult ? (
                testResult.error ? (
                  <div className="text-red-600">
                    <div className="font-semibold">Error:</div>
                    <div>{testResult.error}</div>
                    <div className="text-xs mt-2">{testResult.timestamp}</div>
                  </div>
                ) : (
                  <div>
                    <div className="text-green-600 font-semibold mb-2">Success!</div>
                    <div className="mb-2">
                      <strong>Response:</strong>
                      <div className="mt-1">{testResult.output.response}</div>
                    </div>
                    <div className="text-xs text-muted-foreground space-y-1">
                      <div>Tokens: {testResult.output.usage.inputTokens} in, {testResult.output.usage.outputTokens} out</div>
                      <div>Cost: ${testResult.output.cost}</div>
                      <div>Response Time: {testResult.output.responseTime}ms</div>
                      <div>Timestamp: {testResult.timestamp}</div>
                    </div>
                  </div>
                )
              ) : (
                <span className="text-muted-foreground">No test result yet</span>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
