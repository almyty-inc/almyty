import React, { useState, useMemo } from 'react'
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
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

import { nodeTypes } from '@/components/agents/nodes'
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
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [invokeDialogOpen, setInvokeDialogOpen] = useState(false)
  const [invokeInput, setInvokeInput] = useState('{\n  "message": "Hello"\n}')
  const [invokeResult, setInvokeResult] = useState<any>(null)

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
  const { data: executionsData } = useQuery({
    queryKey: ['agent-executions', id],
    queryFn: async () => {
      const res = await agentsApi.getExecutions(id!, { limit: 20 })
      const d = res.data?.data || res.data
      return Array.isArray(d) ? d : d?.executions || []
    },
    enabled: !!id,
  })

  const executions: AgentExecution[] = Array.isArray(executionsData) ? executionsData : []

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
            >
              <Background gap={16} size={1} />
              <Controls showInteractive={false} />
              <MiniMap
                nodeStrokeWidth={3}
                className="!bg-background !border"
                maskColor="rgba(0,0,0,0.08)"
              />
            </ReactFlow>
          </div>
        </CardContent>
      </Card>

      {/* Recent Executions */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Recent Executions</CardTitle>
        </CardHeader>
        <CardContent>
          {executions.length === 0 ? (
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
