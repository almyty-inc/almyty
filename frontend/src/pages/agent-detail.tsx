import React, { useState, useMemo, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  ArrowLeft,
  Pencil,
  Play,
  Activity,
  Clock,
  CheckCircle2,
  XCircle,
  DollarSign,
  Loader2,
  Download,
  Copy,
  History,
  RotateCcw,
  Calculator,
  Webhook,
  Timer,
  Save,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useOrganizationStore } from '@/store/organization'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { nodeTypes } from '@/components/agents/nodes'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { agentsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import type { Agent, AgentExecution, PipelineNode, PipelineEdge } from '@/types'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  draft: 'outline',
  inactive: 'secondary',
  error: 'destructive',
}

const execStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  completed: 'default',
  running: 'secondary',
  pending: 'outline',
  failed: 'destructive',
  cancelled: 'secondary',
  timeout: 'destructive',
}

export function AgentDetailPage() {
  useEffect(() => {
    document.title = 'Agent Details | apifai'
    return () => { document.title = 'apifai' }
  }, [])

  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const { currentOrganization } = useOrganizationStore()

  const [invokeDialogOpen, setInvokeDialogOpen] = useState(false)
  const [invokeInput, setInvokeInput] = useState('{\n  "message": "Hello"\n}')
  const [invokeResult, setInvokeResult] = useState<any>(null)
  const [rollbackIndex, setRollbackIndex] = useState<number | null>(null)
  const [integrationTab, setIntegrationTab] = useState<'curl' | 'python' | 'node'>('curl')
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState<string | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  // Webhook state
  const [webhookUrl, setWebhookUrl] = useState('')
  const [webhookSaving, setWebhookSaving] = useState(false)

  // Schedule state
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleInterval, setScheduleInterval] = useState(60)
  const [scheduleInput, setScheduleInput] = useState('{}')
  const [scheduleSaving, setScheduleSaving] = useState(false)

  // Fetch agent
  const { data: agentData, isLoading } = useQuery({
    queryKey: ['agent', id],
    queryFn: async () => {
      const res = await agentsApi.getById(id!)
      return res.data?.data || res.data
    },
    enabled: !!id,
  })

  const agent = agentData as Agent | undefined

  // Fetch executions
  const { data: executionsData, error: executionsError } = useQuery({
    queryKey: ['agent-executions', id],
    queryFn: async () => {
      const res = await agentsApi.getExecutions(id!, { limit: 20 })
      const d = res.data?.data || res.data
      return Array.isArray(d) ? d : d?.executions || []
    },
    enabled: !!id,
  })

  const executions: AgentExecution[] = Array.isArray(executionsData) ? executionsData : []

  // Fetch version history
  const { data: versionsData } = useQuery({
    queryKey: ['agent-versions', id],
    queryFn: async () => {
      const res = await agentsApi.getVersions(id!)
      return res.data?.data || []
    },
    enabled: !!id,
  })

  const versions: any[] = Array.isArray(versionsData) ? versionsData : []

  // Fetch cost estimate
  const { data: costEstimateData } = useQuery({
    queryKey: ['agent-cost-estimate', id],
    queryFn: async () => {
      const res = await agentsApi.getCostEstimate(id!)
      return res.data?.data || null
    },
    enabled: !!id,
  })

  const costEstimate = costEstimateData as any | null

  // Sync webhook/schedule state from agent data
  React.useEffect(() => {
    if (agent) {
      setWebhookUrl(agent.webhookUrl || '')
      const schedule = agent.settings?.schedule
      if (schedule) {
        setScheduleEnabled(!!schedule.enabled)
        setScheduleInterval(schedule.intervalMinutes || 60)
        setScheduleInput(JSON.stringify(schedule.input || {}, null, 2))
      }
    }
  }, [agent])

  // Build React Flow nodes/edges from pipeline (read-only)
  const flowNodes: Node[] = useMemo(() => {
    if (!agent?.pipeline?.nodes) return []
    return agent.pipeline.nodes.map((n: PipelineNode) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
      selectable: false,
      draggable: false,
    }))
  }, [agent])

  const flowEdges: Edge[] = useMemo(() => {
    if (!agent?.pipeline?.edges) return []
    return agent.pipeline.edges.map((e: PipelineEdge) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      label: e.label,
    }))
  }, [agent])

  // Invoke mutation
  const invokeMutation = useMutation({
    mutationFn: async () => {
      let input: any
      try {
        input = JSON.parse(invokeInput)
      } catch {
        throw new Error('Invalid JSON input')
      }
      const res = await agentsApi.invoke(id!, input)
      return res.data?.data || res.data
    },
    onSuccess: (result) => {
      setInvokeResult(result)
      success('Agent Invoked', 'Execution completed.')
      queryClient.invalidateQueries({ queryKey: ['agent-executions', id] })
      queryClient.invalidateQueries({ queryKey: ['agent', id] })
    },
    onError: (err: any) => {
      errorNotif('Invocation Failed', err?.response?.data?.message || err?.message || 'Failed to invoke agent')
    },
  })

  // Duplicate mutation
  const duplicateMutation = useMutation({
    mutationFn: async () => {
      return agentsApi.duplicate(id!)
    },
    onSuccess: async () => {
      success('Agent Duplicated', 'A copy has been created.')
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (err: any) => {
      errorNotif('Duplicate Failed', err?.response?.data?.message || err?.message || 'Failed to duplicate')
    },
  })

  // Rollback mutation
  const rollbackMutation = useMutation({
    mutationFn: async (versionIndex: number) => {
      return agentsApi.rollback(id!, versionIndex)
    },
    onSuccess: async () => {
      success('Rolled Back', 'Agent has been rolled back to the selected version.')
      queryClient.invalidateQueries({ queryKey: ['agent', id] })
      queryClient.invalidateQueries({ queryKey: ['agent-versions', id] })
      setRollbackIndex(null)
    },
    onError: (err: any) => {
      errorNotif('Rollback Failed', err?.response?.data?.message || err?.message || 'Failed to rollback')
    },
  })

  // Export handler
  const handleExport = async () => {
    try {
      const res = await agentsApi.exportAgent(id!)
      const exportData = res.data?.data || res.data
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agent?.name?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'agent'}.json`
      a.click()
      URL.revokeObjectURL(url)
      success('Exported', 'Agent JSON downloaded.')
    } catch (err: any) {
      errorNotif('Export Failed', err?.message || 'Failed to export agent')
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!agent) {
    return (
      <div className="flex flex-col items-center justify-center h-96 space-y-4">
        <p className="text-muted-foreground">Agent not found.</p>
        <Button variant="outline" onClick={() => navigate('/agents')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back to Agents
        </Button>
      </div>
    )
  }

  const successRate = agent.totalExecutions > 0
    ? ((agent.successfulExecutions / agent.totalExecutions) * 100).toFixed(1)
    : '0'

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/agents')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">{agent.name}</h1>
              <Badge variant={statusVariant[agent.status] || 'secondary'}>{agent.status}</Badge>
            </div>
            {agent.description && (
              <p className="text-muted-foreground mt-0.5">{agent.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExport}>
            <Download className="h-4 w-4 mr-2" />
            Export
          </Button>
          <Button variant="outline" size="sm" onClick={() => duplicateMutation.mutate()}>
            <Copy className="h-4 w-4 mr-2" />
            Duplicate
          </Button>
          <Button variant="outline" onClick={() => setInvokeDialogOpen(true)}>
            <Play className="h-4 w-4 mr-2" />
            Invoke
          </Button>
          <Button onClick={() => navigate(`/agents/${id}/edit`)}>
            <Pencil className="h-4 w-4 mr-2" />
            Edit
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Executions</span>
            </div>
            <div className="text-2xl font-bold mt-1">{agent.totalExecutions}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-sm text-muted-foreground">Success Rate</span>
            </div>
            <div className="text-2xl font-bold mt-1">{successRate}%</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Avg Execution Time</span>
            </div>
            <div className="text-2xl font-bold mt-1">
              {agent.averageExecutionTime > 0
                ? `${(agent.averageExecutionTime / 1000).toFixed(1)}s`
                : '--'}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Total Cost</span>
            </div>
            <div className="text-2xl font-bold mt-1">
              {agent.totalCost > 0 ? `$${agent.totalCost.toFixed(4)}` : '--'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Pipeline Canvas (read-only) */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pipeline</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="h-[350px] border-t">
            {flowNodes.length === 0 ? (
              <div className="flex items-center justify-center h-full bg-muted/10">
                <p className="text-sm text-muted-foreground">No nodes in pipeline. Edit the agent to add nodes.</p>
              </div>
            ) : (
              <ErrorBoundary
                fallback={
                  <div className="flex items-center justify-center h-full bg-muted/10">
                    <p className="text-sm text-destructive">Failed to render pipeline canvas.</p>
                  </div>
                }
              >
                <ReactFlow
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.3 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  panOnDrag
                  zoomOnScroll
                  className="bg-muted/10"
                  proOptions={{ hideAttribution: true }}
                >
                  <Background gap={16} size={1} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </ErrorBoundary>
            )}
          </div>
        </CardContent>
      </Card>

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
                      setTestLoading(true)
                      setTestOutput(null)
                      agentsApi.invoke(agent.id, { message: testInput })
                        .then((res: any) => {
                          const output = res.data?.data?.output || res.data?.output || JSON.stringify(res.data)
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
                  }}
                  disabled={testLoading}
                />
                <Button
                  disabled={!testInput.trim() || testLoading}
                  onClick={() => {
                    setTestLoading(true)
                    setTestOutput(null)
                    agentsApi.invoke(agent.id, { message: testInput })
                      .then((res: any) => {
                        const output = res.data?.data?.output || res.data?.output || JSON.stringify(res.data)
                        setTestOutput(typeof output === 'string' ? output : JSON.stringify(output, null, 2))
                        setTestInput('')
                      })
                      .catch((err: any) => {
                        const msg = err.response?.data?.message || err.message || 'Invocation failed'
                        setTestOutput(`Error: ${msg}`)
                        errorNotif('Invocation Failed', msg)
                      })
                      .finally(() => setTestLoading(false))
                  }}
                >
                  {testLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                </Button>
              </div>
              {testOutput && (
                <div className="bg-muted/50 rounded-lg p-3 text-sm whitespace-pre-wrap max-h-[200px] overflow-auto">
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
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Integration</CardTitle>
              <div className="flex gap-1">
                {(['curl', 'python', 'node'] as const).map(tab => (
                  <Button
                    key={tab}
                    variant={integrationTab === tab ? 'default' : 'ghost'}
                    size="sm"
                    className="h-7 text-xs px-2"
                    onClick={() => setIntegrationTab(tab)}
                  >
                    {tab === 'curl' ? 'cURL' : tab === 'python' ? 'Python' : 'Node.js'}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {(() => {
              const apiBase = window.location.origin.replace('app.', 'api.')
              const agentRef = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
              const snippets: Record<string, string> = {
                curl: `curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"agent:${agentRef}","messages":[{"role":"user","content":"Hello"}]}'`,
                python: `from openai import OpenAI

client = OpenAI(base_url="${apiBase}/v1", api_key="YOUR_API_KEY")
r = client.chat.completions.create(
    model="agent:${agentRef}",
    messages=[{"role": "user", "content": "Hello"}]
)
print(r.choices[0].message.content)`,
                node: `import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${apiBase}/v1', apiKey: 'YOUR_API_KEY' });
const r = await client.chat.completions.create({
  model: 'agent:${agentRef}',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(r.choices[0].message.content);`,
              }
              return (
                <div className="relative">
                  <pre className="bg-muted/50 rounded-lg p-3 font-mono text-xs overflow-auto max-h-[180px] whitespace-pre-wrap">
                    {snippets[integrationTab]}
                  </pre>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="absolute top-2 right-2 h-6 px-2 text-xs"
                    onClick={() => navigator.clipboard.writeText(snippets[integrationTab])}
                  >
                    <Copy className="h-3 w-3 mr-1" /> Copy
                  </Button>
                </div>
              )
            })()}
          </CardContent>
        </Card>
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
                    queryClient.invalidateQueries({ queryKey: ['agent', id] })
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
                        queryClient.invalidateQueries({ queryKey: ['agent', id] })
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
                    <Textarea
                      id="schedule-input"
                      className="mt-1 font-mono text-xs"
                      rows={3}
                      value={scheduleInput}
                      onChange={(e) => setScheduleInput(e.target.value)}
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
                        queryClient.invalidateQueries({ queryKey: ['agent', id] })
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
        {/* Cost Estimate */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <Calculator className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Pipeline Cost Estimate</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            {costEstimate ? (
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">LLM calls per run</span>
                  <span className="font-medium">{costEstimate.estimatedLlmCalls}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Tool calls per run</span>
                  <span className="font-medium">{costEstimate.estimatedToolCalls}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Parallel execution</span>
                  <span className="font-medium">{costEstimate.hasParallelExecution ? 'Yes' : 'No'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Est. cost per run</span>
                  <span className="font-medium">
                    {costEstimate.estimatedCostRange.low.toFixed(1)}-{costEstimate.estimatedCostRange.high.toFixed(1)} cents
                  </span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t">
                  <span>{costEstimate.nodeCount} nodes</span>
                  <span>{costEstimate.edgeCount} edges</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Loading cost estimate...</p>
            )}
          </CardContent>
        </Card>

        {/* Version History */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <History className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-base">Version History</CardTitle>
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
                  <div key={index} className="flex items-center justify-between text-sm p-2 rounded-md bg-muted/50">
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
      </div>

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
                  rollbackMutation.mutate(rollbackIndex)
                }
              }}
            >
              Rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Invoke Dialog */}
      <Dialog open={invokeDialogOpen} onOpenChange={setInvokeDialogOpen}>
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
              <Textarea
                id="invoke-input"
                className="mt-1 font-mono text-xs"
                rows={6}
                value={invokeInput}
                onChange={(e) => setInvokeInput(e.target.value)}
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
                <pre className="mt-1 p-3 rounded-md bg-muted text-xs font-mono overflow-x-auto max-h-[200px] overflow-y-auto">
                  {JSON.stringify(invokeResult, null, 2)}
                </pre>
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
    </div>
  )
}
