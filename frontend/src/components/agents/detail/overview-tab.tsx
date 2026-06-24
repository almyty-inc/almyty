/**
 * Overview tab for the agent detail page. Contains Try-It panel,
 * integration snippets, webhook/schedule config, recent executions,
 * pipeline info, version history, change history, and audit log.
 */
import React, { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Calculator,
  History,
  Clock,
  Webhook,
  Timer,
  Save,
  RotateCcw,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { CodeEditor } from '@/components/ui/code-editor'
import { Switch } from '@/components/ui/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

import { agentsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { formatDateTime, formatRelativeTime } from '@/lib/utils'
import { execStatusVariant, diffObjects, formatDiffValue } from './constants'
import { IntegrationSnippets } from './integration-snippets'
import { AgentConfigPanel } from './agent-config-panel'
import type { Agent, AgentExecution, AgentVersionSnapshot, AgentAuditEntry } from '@/types'

interface OverviewTabProps {
  agent: Agent
  executions: AgentExecution[]
  executionsError: Error | null
  versions: AgentVersionSnapshot[]
  entityVersions: Array<{
    id: number
    itemType: string
    itemId: string
    event: string
    owner: string
    object: Record<string, any>
    timestamp: string
  }>
  auditLog: AgentAuditEntry[]
  webhookUrl: string
  setWebhookUrl: (url: string) => void
  scheduleEnabled: boolean
  setScheduleEnabled: (enabled: boolean) => void
  scheduleInterval: number
  setScheduleInterval: (interval: number) => void
  scheduleInput: string
  setScheduleInput: (input: string) => void
}

export function OverviewTab({
  agent,
  executions,
  executionsError,
  versions,
  entityVersions,
  auditLog,
  webhookUrl,
  setWebhookUrl,
  scheduleEnabled,
  setScheduleEnabled,
  scheduleInterval,
  setScheduleInterval,
  scheduleInput,
  setScheduleInput,
}: OverviewTabProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState<string | null>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [webhookSaving, setWebhookSaving] = useState(false)
  const [scheduleSaving, setScheduleSaving] = useState(false)
  const [rollbackIndex, setRollbackIndex] = useState<number | null>(null)
  const [expandedVersionId, setExpandedVersionId] = useState<number | null>(null)

  // Rollback mutation (inline, matching original)
  const handleRollback = async (versionIndex: number) => {
    try {
      await agentsApi.rollback(agent.id, versionIndex)
      success('Rolled Back', 'Agent has been rolled back to the selected version.')
      queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
      queryClient.invalidateQueries({ queryKey: ['agent-versions', agent.id] })
      setRollbackIndex(null)
    } catch (err: any) {
      errorNotif('Rollback Failed', err?.response?.data?.message || err?.message || 'Failed to rollback')
    }
  }

  const handleTest = () => {
    setTestLoading(true)
    setTestOutput(null)
    agentsApi.invoke(agent.id, { message: testInput })
      .then((res: any) => {
        const output = res?.output || JSON.stringify(res)
        setTestOutput(typeof output === 'string' ? output : JSON.stringify(output, null, 2))
        setTestInput('')
      })
      .catch((err: any) => {
        const msg = err.response?.data?.message || err.message || 'Invocation failed'
        setTestOutput(`Error: ${msg}`)
        errorNotif('Invocation Failed', msg)
      })
      .finally(() => setTestLoading(false))
  }

  return (
    <>
      {/* Models & Verification — the autonomous multi-LLM story */}
      {agent.mode === 'autonomous' && <AgentConfigPanel agent={agent} />}
      {/* Try It + Integration */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Try It */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Try It</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  placeholder="Type a message to test this agent..."
                  value={testInput}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTestInput(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' && testInput.trim() && !testLoading) {
                      handleTest()
                    }
                  }}
                  disabled={testLoading}
                />
                <Button
                  disabled={!testInput.trim() || testLoading}
                  onClick={handleTest}
                >
                  {testLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                </Button>
              </div>
              {testOutput && (
                <div className="bg-muted rounded-lg p-3 text-sm whitespace-pre-wrap max-h-[200px] overflow-auto">
                  {testOutput}
                </div>
              )}
              {!testOutput && (
                <p className="text-xs text-muted-foreground">Send a message to invoke this agent and see the response.</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Integration */}
        <IntegrationSnippets agent={agent} />
      </div>

      {/* Webhook + Schedule */}
      <div className="grid gap-6 md:grid-cols-2">
        {/* Webhook */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Webhook className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Webhook</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Receive a POST notification when this agent finishes executing
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div>
                <Label htmlFor="webhook-url">Webhook URL</Label>
                <Input
                  id="webhook-url"
                  placeholder="https://example.com/webhook"
                  value={webhookUrl}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setWebhookUrl(e.target.value)}
                  className="mt-1"
                />
              </div>
              <Button
                size="sm"
                disabled={webhookSaving}
                onClick={async () => {
                  setWebhookSaving(true)
                  try {
                    await agentsApi.update(agent.id, { webhookUrl: webhookUrl || null })
                    queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
                    success('Saved', 'Webhook URL updated.')
                  } catch (err: any) {
                    errorNotif('Failed', err?.response?.data?.message || err?.message || 'Failed to save webhook URL')
                  } finally {
                    setWebhookSaving(false)
                  }
                }}
              >
                {webhookSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                Save
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Schedule */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Schedule</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Run this agent automatically at a fixed interval
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label htmlFor="schedule-toggle">Enable schedule</Label>
                <Switch
                  id="schedule-toggle"
                  checked={scheduleEnabled}
                  onCheckedChange={async (checked: boolean) => {
                    setScheduleEnabled(checked)
                    if (!checked) {
                      setScheduleSaving(true)
                      try {
                        await agentsApi.unschedule(agent.id)
                        queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
                        success('Unscheduled', 'Agent schedule removed.')
                      } catch (err: any) {
                        errorNotif('Failed', err?.response?.data?.message || err?.message || 'Failed to unschedule')
                        setScheduleEnabled(true)
                      } finally {
                        setScheduleSaving(false)
                      }
                    }
                  }}
                />
              </div>
              {scheduleEnabled && (
                <>
                  <div>
                    <Label htmlFor="schedule-interval">Interval (minutes)</Label>
                    <Input
                      id="schedule-interval"
                      type="number"
                      min={1}
                      value={scheduleInterval}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setScheduleInterval(parseInt(e.target.value) || 1)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label htmlFor="schedule-input">Input JSON</Label>
                    <CodeEditor
                      value={scheduleInput}
                      onChange={(value) => setScheduleInput(value)}
                      language="json"
                      height="80px"
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={scheduleSaving}
                    onClick={async () => {
                      setScheduleSaving(true)
                      try {
                        let parsedInput: any = {}
                        try {
                          parsedInput = JSON.parse(scheduleInput)
                        } catch {
                          errorNotif('Invalid JSON', 'Schedule input must be valid JSON')
                          setScheduleSaving(false)
                          return
                        }
                        await agentsApi.schedule(agent.id, scheduleInterval, parsedInput)
                        queryClient.invalidateQueries({ queryKey: ['agent', agent.id] })
                        success('Scheduled', `Agent will run every ${scheduleInterval} minute(s).`)
                      } catch (err: any) {
                        errorNotif('Failed', err?.response?.data?.message || err?.message || 'Failed to schedule')
                      } finally {
                        setScheduleSaving(false)
                      }
                    }}
                  >
                    {scheduleSaving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
                    Save Schedule
                  </Button>
                  {agent.settings?.schedule?.enabled && (
                    <p className="text-xs text-muted-foreground">
                      Next run in ~{agent.settings.schedule.intervalMinutes} minute(s) from last execution
                    </p>
                  )}
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Executions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Executions</CardTitle>
        </CardHeader>
        <CardContent>
          {executionsError ? (
            <div className="text-center py-6">
              <p className="text-sm text-destructive">Failed to load executions</p>
              <p className="text-xs text-muted-foreground mt-1">
                {(executionsError as Error)?.message || 'An error occurred while fetching execution history.'}
              </p>
            </div>
          ) : executions.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No executions yet. Click "Invoke" to run this agent.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Tokens</TableHead>
                    <TableHead>Started</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {executions.map((exec) => (
                    <TableRow key={exec.id}>
                      <TableCell>
                        <Badge variant={execStatusVariant[exec.status] || 'secondary'}>
                          {exec.status === 'completed' && <CheckCircle2 className="h-3 w-3 mr-1" />}
                          {exec.status === 'failed' && <XCircle className="h-3 w-3 mr-1" />}
                          {exec.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {exec.executionTime ? `${(exec.executionTime / 1000).toFixed(2)}s` : '--'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {exec.totalCost > 0 ? `$${exec.totalCost.toFixed(4)}` : '--'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {exec.totalTokens > 0 ? exec.totalTokens.toLocaleString() : '--'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDateTime(exec.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cost Estimate & Version Info */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Pipeline Info -- hidden for autonomous agents */}
        {agent.mode !== 'autonomous' && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Pipeline</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Nodes</span>
                <span className="font-medium">{agent.pipeline?.nodes?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Edges</span>
                <span className="font-medium">{agent.pipeline?.edges?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">LLM calls</span>
                <span className="font-medium">{(agent.pipeline?.nodes || []).filter((n: any) => n.type === 'llm_call').length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Tool calls</span>
                <span className="font-medium">{(agent.pipeline?.nodes || []).filter((n: any) => n.type === 'tool_call').length}</span>
              </div>
              {agent.totalExecutions > 0 && (
                <div className="flex justify-between pt-1 border-t">
                  <span className="text-muted-foreground">Avg cost per run</span>
                  <span className="font-medium">${(agent.totalCost / agent.totalExecutions).toFixed(4)}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        )}

        {/* Pipeline Version History -- hidden for autonomous agents */}
        {agent.mode !== 'autonomous' && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Pipeline Versions</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Current: v{agent.version}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {versions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No version snapshots yet. Versions are saved automatically when the pipeline is updated.
              </p>
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {versions.map((v, index) => (
                  <div key={index} className="flex items-center justify-between text-sm p-2 rounded-md bg-muted">
                    <div className="min-w-0">
                      <div className="font-medium text-xs">v{v.version}</div>
                      <div className="text-xs text-muted-foreground truncate">{v.changelog}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {v.savedAt ? formatDateTime(v.savedAt) : ''}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="shrink-0 text-xs"
                      onClick={() => setRollbackIndex(index)}
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Rollback
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        )}

        {/* Entity Change History (typeorm-versions) */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Change History</CardTitle>
            </div>
            <CardDescription className="text-xs">
              All changes tracked automatically
            </CardDescription>
          </CardHeader>
          <CardContent>
            {entityVersions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No changes recorded yet.
              </p>
            ) : (
              <div className="space-y-1 max-h-[300px] overflow-y-auto">
                {entityVersions.map((ev, index) => {
                  const prevVersion = index < entityVersions.length - 1 ? entityVersions[index + 1] : null
                  const isExpanded = expandedVersionId === ev.id
                  const eventLabel = ev.event === 'INSERT' ? 'Created' : ev.event === 'UPDATE' ? 'Updated' : 'Deleted'
                  const changes = prevVersion ? diffObjects(prevVersion.object || {}, ev.object || {}) : []

                  return (
                    <div key={ev.id} className="border rounded-md">
                      <button
                        className="w-full flex items-center justify-between text-sm p-2 hover:bg-muted/50 transition-colors"
                        onClick={() => setExpandedVersionId(isExpanded ? null : ev.id)}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant={ev.event === 'INSERT' ? 'default' : ev.event === 'UPDATE' ? 'secondary' : 'destructive'} className="text-[10px] px-1.5 py-0">
                            {eventLabel}
                          </Badge>
                          <span className="text-xs text-muted-foreground truncate">
                            {ev.owner && ev.owner !== 'system' ? ev.owner : 'system'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-[10px] text-muted-foreground">
                            {formatRelativeTime(ev.timestamp)}
                          </span>
                          {ev.event === 'UPDATE' && changes.length > 0 && (
                            isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                          )}
                        </div>
                      </button>
                      {isExpanded && ev.event === 'UPDATE' && changes.length > 0 && (
                        <div className="px-2 pb-2 border-t">
                          <div className="space-y-1 mt-1">
                            {changes.map((change, ci) => (
                              <div key={ci} className="text-[11px] font-mono bg-muted rounded px-2 py-1">
                                <span className="text-muted-foreground">{change.field}:</span>{' '}
                                <span className="text-red-500 line-through">{formatDiffValue(change.from)}</span>{' '}
                                <span className="text-green-600">{formatDiffValue(change.to)}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {isExpanded && ev.event === 'INSERT' && (
                        <div className="px-2 pb-2 border-t">
                          <p className="text-[11px] text-muted-foreground mt-1">Entity created</p>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Audit Log */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Audit Log</CardTitle>
          </div>
          <CardDescription className="text-xs">
            History of changes made to this agent
          </CardDescription>
        </CardHeader>
        <CardContent>
          {auditLog.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No audit entries yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Timestamp</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...auditLog].reverse().map((entry, index) => (
                    <TableRow key={index}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatDateTime(entry.timestamp)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {entry.action.replace(/_/g, ' ')}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">
                        {entry.userId?.slice(0, 8) || '--'}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                        {entry.details ? JSON.stringify(entry.details) : '--'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rollback Confirmation */}
      <AlertDialog open={rollbackIndex !== null} onOpenChange={(open) => { if (!open) setRollbackIndex(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rollback to this version?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace the current pipeline with the one from version
              {rollbackIndex !== null && versions[rollbackIndex] ? ` v${versions[rollbackIndex].version}` : ''}.
              The current pipeline state will be preserved in the version history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (rollbackIndex !== null) {
                  handleRollback(rollbackIndex)
                }
              }}
            >
              Rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
