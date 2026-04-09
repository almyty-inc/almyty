import React, { useState, useMemo, useEffect, useRef } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
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
  ChevronRight,
  Brain,
  FileText,
  Plug,
  Plus,
  ChevronDown,
  ChevronUp,
  Tag,
  MessageSquare,
  Upload,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useOrganizationStore } from '@/store/organization'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { CodeEditor } from '@/components/ui/code-editor'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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

import { CodeBlock } from '@/components/ui/code-block'
import { nodeTypes } from '@/components/agents/nodes'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { agentsApi, memoriesApi, filesApi, interfacesApi, versionsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { formatDateTime, formatRelativeTime } from '@/lib/utils'
import type { Agent, AgentExecution, PipelineNode, PipelineEdge, AgentVersionSnapshot, AgentCostEstimate, AgentAuditEntry, AgentRun, Memory, AgentFile, AgentInterface, InterfaceType, InterfaceStatus } from '@/types'

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  active: 'success',
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

const runStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  pending: 'secondary',
  running: 'default',
  waiting_input: 'outline',
  completed: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
  timeout: 'destructive',
}

const interfaceStatusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  active: 'success',
  inactive: 'secondary',
  error: 'destructive',
}

const interfaceTypeIcons: Record<string, string> = {
  chat_widget: '💬',
  slack: '📱',
  discord: '🎮',
  telegram: '✈️',
  whatsapp: '📞',
  email: '📧',
  webhook: '🔗',
  google_chat: '🟢',
  microsoft_teams: '🟣',
  signal: '🔵',
  matrix: '🟩',
  irc: '⌨️',
}

function getDefaultInterfaceConfig(type: string): Record<string, any> {
  switch (type) {
    case 'chat_widget':
      return { welcomeMessage: '', primaryColor: '#8b5cf6', position: 'bottom-right', theme: 'auto' }
    case 'slack':
      return { botToken: '', signingSecret: '', channelIds: '' }
    case 'discord':
      return { botToken: '', guildIds: '' }
    case 'telegram':
      return { botToken: '' }
    case 'whatsapp':
      return { accountSid: '', authToken: '', phoneNumber: '' }
    case 'email':
      return { resendApiKey: '', replyFrom: '', receiveAddress: '' }
    case 'webhook':
      return { callbackUrl: '', secret: '' }
    case 'google_chat':
      return { webhookUrl: '', spaceId: '' }
    case 'microsoft_teams':
      return { botId: '', botPassword: '', tenantId: '' }
    case 'signal':
      return { phoneNumber: '', apiUrl: '' }
    case 'matrix':
      return { homeserverUrl: '', accessToken: '', roomId: '' }
    case 'irc':
      return { server: '', port: '6667', channel: '', nick: '' }
    default:
      return {}
  }
}

function maskSecret(value: string): string {
  if (!value || value.length <= 4) return '****'
  return value.slice(0, 4) + '****'
}

function getInterfaceConfigSummary(type: string, config: Record<string, any>): { label: string; value: string; secret?: boolean }[] {
  if (!config) return []
  switch (type) {
    case 'chat_widget':
      return [
        { label: 'Welcome', value: config.welcomeMessage || '(default)' },
        { label: 'Color', value: config.primaryColor || '#8b5cf6' },
        { label: 'Position', value: config.position || 'bottom-right' },
        { label: 'Theme', value: config.theme || 'auto' },
      ]
    case 'slack':
      return [
        { label: 'Bot Token', value: config.botToken || '', secret: true },
        { label: 'Signing Secret', value: config.signingSecret || '', secret: true },
        { label: 'Channels', value: config.channelIds || '' },
      ]
    case 'discord':
      return [
        { label: 'Bot Token', value: config.botToken || '', secret: true },
        { label: 'Guild IDs', value: config.guildIds || '' },
      ]
    case 'telegram':
      return [
        { label: 'Bot Token', value: config.botToken || '', secret: true },
      ]
    case 'whatsapp':
      return [
        { label: 'Account SID', value: config.accountSid || '' },
        { label: 'Auth Token', value: config.authToken || '', secret: true },
        { label: 'Phone', value: config.phoneNumber || '' },
      ]
    case 'email':
      return [
        { label: 'API Key', value: config.resendApiKey || '', secret: true },
        { label: 'Reply From', value: config.replyFrom || '' },
        { label: 'Receive At', value: config.receiveAddress || '' },
      ]
    case 'webhook':
      return [
        { label: 'URL', value: config.callbackUrl || '' },
        { label: 'Secret', value: config.secret || '', secret: true },
      ]
    case 'google_chat':
      return [
        { label: 'Webhook URL', value: config.webhookUrl || '', secret: true },
        { label: 'Space ID', value: config.spaceId || '' },
      ]
    case 'microsoft_teams':
      return [
        { label: 'Bot ID', value: config.botId || '' },
        { label: 'Bot Password', value: config.botPassword || '', secret: true },
        { label: 'Tenant ID', value: config.tenantId || '' },
      ]
    case 'signal':
      return [
        { label: 'Phone Number', value: config.phoneNumber || '' },
        { label: 'API URL', value: config.apiUrl || '' },
      ]
    case 'matrix':
      return [
        { label: 'Homeserver', value: config.homeserverUrl || '' },
        { label: 'Access Token', value: config.accessToken || '', secret: true },
        { label: 'Room ID', value: config.roomId || '' },
      ]
    case 'irc':
      return [
        { label: 'Server', value: config.server || '' },
        { label: 'Port', value: config.port || '6667' },
        { label: 'Channel', value: config.channel || '' },
        { label: 'Nick', value: config.nick || '' },
      ]
    default:
      return []
  }
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

function diffObjects(prev: Record<string, any>, curr: Record<string, any>): { field: string; from: any; to: any }[] {
  const changes: { field: string; from: any; to: any }[] = []
  const allKeys = new Set([...Object.keys(prev || {}), ...Object.keys(curr || {})])
  for (const key of allKeys) {
    if (JSON.stringify(prev?.[key]) !== JSON.stringify(curr?.[key])) {
      changes.push({ field: key, from: prev?.[key], to: curr?.[key] })
    }
  }
  return changes
}

function formatDiffValue(value: any): string {
  if (value === undefined || value === null) return '(none)'
  if (typeof value === 'object') {
    const str = JSON.stringify(value)
    return str.length > 60 ? str.slice(0, 60) + '...' : str
  }
  const str = String(value)
  return str.length > 60 ? str.slice(0, 60) + '...' : str
}

export function AgentDetailPage() {
  useEffect(() => {
    document.title = 'Agent Details | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const { currentOrganization } = useOrganizationStore()

  const [invokeDialogOpen, setInvokeDialogOpen] = useState(false)
  const [invokeInput, setInvokeInput] = useState('{\n  "message": "Hello"\n}')
  const [invokeResult, setInvokeResult] = useState<Record<string, unknown> | null>(null)
  const [rollbackIndex, setRollbackIndex] = useState<number | null>(null)
  const [expandedVersionId, setExpandedVersionId] = useState<number | null>(null)
  const [integrationTab, setIntegrationTab] = useState<'curl' | 'python' | 'node'>('curl')
  const [testInput, setTestInput] = useState('')
  const [testOutput, setTestOutput] = useState<string | null>(null)
  const [testLoading, setTestLoading] = useState(false)

  // Active tab
  const [activeTab, setActiveTab] = useState('overview')

  // Runs tab state
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)

  // Memory tab state
  const [addMemoryOpen, setAddMemoryOpen] = useState(false)
  const [newMemoryContent, setNewMemoryContent] = useState('')
  const [newMemoryType, setNewMemoryType] = useState<string>('fact')
  const [newMemoryTags, setNewMemoryTags] = useState('')

  // Files tab state
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Interfaces tab state
  const [deployInterfaceOpen, setDeployInterfaceOpen] = useState(false)
  const [newInterfaceType, setNewInterfaceType] = useState<string>('chat_widget')
  const [newInterfaceName, setNewInterfaceName] = useState('')
  const [interfaceConfig, setInterfaceConfig] = useState<Record<string, any>>({
    welcomeMessage: '',
    primaryColor: '#8b5cf6',
    position: 'bottom-right',
    theme: 'auto',
  })

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
    queryFn: () => agentsApi.getById(id!),
    enabled: !!id,
  })

  const agent = agentData as Agent | undefined

  // Fetch executions
  const { data: executionsData, error: executionsError } = useQuery({
    queryKey: ['agent-executions', id],
    queryFn: async () => {
      const d = await agentsApi.getExecutions(id!, { limit: 20 })
      return Array.isArray(d) ? d : d?.executions || []
    },
    enabled: !!id,
  })

  const executions: AgentExecution[] = Array.isArray(executionsData) ? executionsData : []

  // Fetch version history
  const { data: versionsData } = useQuery({
    queryKey: ['agent-versions', id],
    queryFn: async () => {
      const d = await agentsApi.getVersions(id!)
      return d || []
    },
    enabled: !!id,
  })

  const versions: AgentVersionSnapshot[] = Array.isArray(versionsData) ? versionsData : []

  // Fetch entity version history (typeorm-versions)
  const { data: entityVersionsData } = useQuery({
    queryKey: ['entity-versions', 'Agent', id],
    queryFn: async () => {
      const res = await versionsApi.getVersions('Agent', id!)
      return res?.data || []
    },
    enabled: !!id,
  })

  const entityVersions: Array<{
    id: number
    itemType: string
    itemId: string
    event: string
    owner: string
    object: Record<string, any>
    timestamp: string
  }> = Array.isArray(entityVersionsData) ? entityVersionsData : []

  // Cost data comes from real execution history (agent.totalCost / agent.totalExecutions)

  // Fetch audit log
  const { data: auditLogData } = useQuery({
    queryKey: ['agent-audit-log', id],
    queryFn: async () => {
      const d = await agentsApi.getAuditLog(id!)
      return d || []
    },
    enabled: !!id,
  })

  const auditLog: AgentAuditEntry[] = Array.isArray(auditLogData) ? auditLogData : []

  // Fetch runs (autonomous mode)
  const { data: runsData } = useQuery({
    queryKey: ['agent-runs', id],
    queryFn: async () => {
      const d = await agentsApi.listRuns(id!)
      return Array.isArray(d) ? d : d?.data || []
    },
    enabled: !!id && activeTab === 'runs',
  })

  const runs: AgentRun[] = Array.isArray(runsData) ? runsData : []

  // Fetch memories
  const { data: memoriesData } = useQuery({
    queryKey: ['agent-memories', id],
    queryFn: async () => {
      const d = await memoriesApi.getAll({ agentId: id! })
      return Array.isArray(d) ? d : d?.data || []
    },
    enabled: !!id && activeTab === 'memory',
  })

  const memories: Memory[] = Array.isArray(memoriesData) ? memoriesData : []

  // Fetch files
  const { data: filesData } = useQuery({
    queryKey: ['agent-files', id],
    queryFn: async () => {
      const d = await filesApi.getAll({ agentId: id! })
      return Array.isArray(d) ? d : d?.data || []
    },
    enabled: !!id && activeTab === 'files',
  })

  const files: AgentFile[] = Array.isArray(filesData) ? filesData : []

  // Fetch interfaces
  const { data: interfacesData } = useQuery({
    queryKey: ['agent-interfaces', id],
    queryFn: async () => {
      const d = await interfacesApi.getAll(id!)
      return Array.isArray(d) ? d : d?.data || []
    },
    enabled: !!id && activeTab === 'interfaces',
  })

  const interfaces: AgentInterface[] = Array.isArray(interfacesData) ? interfacesData : []

  // Add memory mutation
  const addMemoryMutation = useMutation({
    mutationFn: async () => {
      return memoriesApi.create({
        content: newMemoryContent,
        type: newMemoryType,
        scope: 'agent',
        agentIds: [id!],
        tags: newMemoryTags.split(',').map(t => t.trim()).filter(Boolean),
      })
    },
    onSuccess: () => {
      success('Memory Added', 'Memory has been created for this agent.')
      queryClient.invalidateQueries({ queryKey: ['agent-memories', id] })
      setAddMemoryOpen(false)
      setNewMemoryContent('')
      setNewMemoryType('fact')
      setNewMemoryTags('')
    },
    onError: (err: any) => {
      errorNotif('Failed', err?.response?.data?.message || err?.message || 'Failed to add memory')
    },
  })

  // Upload file mutation
  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      return filesApi.upload(file, id!)
    },
    onSuccess: () => {
      success('File Uploaded', 'File has been uploaded.')
      queryClient.invalidateQueries({ queryKey: ['agent-files', id] })
    },
    onError: (err: any) => {
      errorNotif('Upload Failed', err?.response?.data?.message || err?.message || 'Failed to upload file')
    },
  })

  // Deploy interface mutation
  const deployInterfaceMutation = useMutation({
    mutationFn: async () => {
      return interfacesApi.create({
        agentId: id!,
        type: newInterfaceType,
        name: newInterfaceName || `${newInterfaceType} interface`,
        configuration: interfaceConfig,
      })
    },
    onSuccess: () => {
      success('Interface Deployed', 'Interface has been created.')
      queryClient.invalidateQueries({ queryKey: ['agent-interfaces', id] })
      setDeployInterfaceOpen(false)
      setNewInterfaceName('')
      setNewInterfaceType('chat_widget')
      setInterfaceConfig(getDefaultInterfaceConfig('chat_widget'))
    },
    onError: (err: any) => {
      errorNotif('Deploy Failed', err?.response?.data?.message || err?.message || 'Failed to deploy interface')
    },
  })

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
      return agentsApi.invoke(id!, input)
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
      const exportData = await agentsApi.exportAgent(id!)
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
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/agents" className="hover:text-foreground">Agents</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{agent.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/agents')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold">{agent.name}</h1>
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

      {/* Pipeline Canvas (read-only) — hidden for autonomous agents */}
      {agent.mode !== 'autonomous' && (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pipeline</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="h-[350px] border-t">
            {flowNodes.length === 0 ? (
              <div className="flex items-center justify-center h-full bg-gradient-to-br from-muted/20 via-muted/10 to-transparent">
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
                  className="bg-gradient-to-br from-muted/20 via-muted/5 to-transparent"
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
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="interfaces">Interfaces</TabsTrigger>
        </TabsList>

        {/* ── Overview Tab ── */}
        <TabsContent value="overview" className="space-y-6">
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
                      }}
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
                  const orgSlug = currentOrganization?.slug || currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
                  const agentRef = agent.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
                  const unifiedUrl = `${apiBase}/${orgSlug}/${agentRef}`
                  const snippets: Record<string, string> = {
                    curl: `# Unified endpoint
curl -X POST ${unifiedUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"message":"Hello"}'

# OpenAI-compatible endpoint
curl ${apiBase}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"agent:${agentRef}","messages":[{"role":"user","content":"Hello"}]}'`,
                    python: `import requests

# Unified endpoint
r = requests.post("${unifiedUrl}", json={"message": "Hello"})
print(r.json())

# Or use OpenAI-compatible endpoint
from openai import OpenAI

client = OpenAI(base_url="${apiBase}/v1", api_key="YOUR_API_KEY")
r = client.chat.completions.create(
    model="agent:${agentRef}",
    messages=[{"role": "user", "content": "Hello"}]
)
print(r.choices[0].message.content)`,
                    node: `// Unified endpoint
const r = await fetch('${unifiedUrl}', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Hello' }),
});
console.log(await r.json());

// Or use OpenAI-compatible endpoint
import OpenAI from 'openai';

const client = new OpenAI({ baseURL: '${apiBase}/v1', apiKey: 'YOUR_API_KEY' });
const r2 = await client.chat.completions.create({
  model: 'agent:${agentRef}',
  messages: [{ role: 'user', content: 'Hello' }],
});
console.log(r2.choices[0].message.content);`,
                  }
                  const langMap: Record<string, string> = { curl: 'bash', python: 'python', node: 'javascript' }
                  return (
                    <CodeBlock
                      value={snippets[integrationTab]}
                      language={langMap[integrationTab]}
                      maxHeight="180px"
                    />
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
            {/* Pipeline Info — hidden for autonomous agents */}
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

            {/* Pipeline Version History — hidden for autonomous agents */}
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
        </TabsContent>

        {/* ── Runs Tab ── */}
        <TabsContent value="runs" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Autonomous Runs</CardTitle>
                <Badge variant="outline">{runs.length} run{runs.length !== 1 ? 's' : ''}</Badge>
              </div>
              <CardDescription className="text-xs">
                Autonomous agent runs with step-by-step execution details
              </CardDescription>
            </CardHeader>
            <CardContent>
              {runs.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No runs yet. Start a run by invoking the agent in autonomous mode.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8"></TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Input</TableHead>
                        <TableHead>Steps</TableHead>
                        <TableHead>Cost</TableHead>
                        <TableHead>Tokens</TableHead>
                        <TableHead>Duration</TableHead>
                        <TableHead>Created</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {runs.map((run) => (
                        <React.Fragment key={run.id}>
                          <TableRow
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                          >
                            <TableCell className="px-2">
                              {expandedRunId === run.id
                                ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                                : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                            </TableCell>
                            <TableCell>
                              <Badge variant={runStatusVariant[run.status] || 'secondary'}>
                                {run.status === 'completed' && <CheckCircle2 className="h-3 w-3 mr-1" />}
                                {run.status === 'failed' && <XCircle className="h-3 w-3 mr-1" />}
                                {run.status === 'running' && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                                {run.status.replace('_', ' ')}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm max-w-[200px] truncate">
                              {run.input ? JSON.stringify(run.input).slice(0, 80) : '--'}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.currentStep}/{run.maxSteps}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.totalCost > 0 ? `$${run.totalCost.toFixed(4)}` : '--'}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.totalTokens > 0 ? run.totalTokens.toLocaleString() : '--'}
                            </TableCell>
                            <TableCell className="text-sm">
                              {run.executionTime > 0 ? formatDuration(run.executionTime) : '--'}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {formatDateTime(run.createdAt)}
                            </TableCell>
                          </TableRow>
                          {expandedRunId === run.id && (
                            <TableRow>
                              <TableCell colSpan={8} className="bg-muted/30 p-4">
                                <div className="space-y-4">
                                  {/* Steps */}
                                  {run.steps && run.steps.length > 0 && (
                                    <div>
                                      <h4 className="text-sm font-medium mb-2">Steps</h4>
                                      <div className="space-y-2">
                                        {run.steps.map((step, idx) => (
                                          <div key={idx} className="flex items-start gap-3 p-2 rounded bg-background border text-sm">
                                            <div className="flex items-center gap-2 shrink-0">
                                              <span className="text-xs font-mono text-muted-foreground">#{idx + 1}</span>
                                              <Badge variant="outline" className="text-[10px]">{step.type}</Badge>
                                            </div>
                                            <div className="min-w-0 flex-1">
                                              {step.input && (
                                                <div className="text-xs text-muted-foreground truncate">
                                                  In: {typeof step.input === 'string' ? step.input : JSON.stringify(step.input)}
                                                </div>
                                              )}
                                              {step.output && (
                                                <div className="text-xs truncate">
                                                  Out: {typeof step.output === 'string' ? step.output : JSON.stringify(step.output)}
                                                </div>
                                              )}
                                              {step.error && (
                                                <div className="text-xs text-destructive truncate">
                                                  Error: {step.error}
                                                </div>
                                              )}
                                            </div>
                                            <div className="text-[10px] text-muted-foreground shrink-0 text-right">
                                              {step.duration ? formatDuration(step.duration) : ''}
                                              {step.cost ? ` / $${step.cost.toFixed(4)}` : ''}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {/* Thread */}
                                  {run.thread && run.thread.length > 0 && (
                                    <div>
                                      <h4 className="text-sm font-medium mb-2">Thread</h4>
                                      <div className="space-y-1 max-h-[300px] overflow-y-auto">
                                        {run.thread.map((msg, idx) => (
                                          <div key={idx} className={`p-2 rounded text-sm ${msg.role === 'assistant' ? 'bg-primary/5 border-l-2 border-primary' : 'bg-background border'}`}>
                                            <span className="text-xs font-medium text-muted-foreground">{msg.role}</span>
                                            <div className="text-xs mt-0.5 whitespace-pre-wrap">
                                              {typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2)}
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  {/* Error */}
                                  {run.error && (
                                    <div className="p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                                      {run.error}
                                    </div>
                                  )}
                                  {/* Output */}
                                  {run.output && (
                                    <div>
                                      <h4 className="text-sm font-medium mb-1">Output</h4>
                                      <div className="bg-muted rounded p-2 text-xs whitespace-pre-wrap max-h-[200px] overflow-auto">
                                        {typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2)}
                                      </div>
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}
                        </React.Fragment>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Memory Tab ── */}
        <TabsContent value="memory" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Memories</CardTitle>
                  <CardDescription className="text-xs mt-1">
                    Knowledge and context accessible to this agent
                  </CardDescription>
                </div>
                <Button size="sm" onClick={() => setAddMemoryOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Memory
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {memories.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No memories yet. Add memories to give this agent persistent knowledge.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Content</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead>Tags</TableHead>
                        <TableHead>Access Count</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {memories.map((mem) => (
                        <TableRow key={mem.id}>
                          <TableCell className="text-sm max-w-[300px] truncate">
                            {mem.content}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">{mem.type}</Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="text-xs">{mem.scope}</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {mem.tags && mem.tags.length > 0 ? (
                              <div className="flex gap-1 flex-wrap">
                                {mem.tags.map((tag, idx) => (
                                  <span key={idx} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-muted text-[10px]">
                                    <Tag className="h-2.5 w-2.5" />{tag}
                                  </span>
                                ))}
                              </div>
                            ) : '--'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {mem.accessCount}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Files Tab ── */}
        <TabsContent value="files" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">Files</CardTitle>
                  <CardDescription className="text-xs mt-1">
                    Files uploaded for this agent
                  </CardDescription>
                </div>
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        uploadFileMutation.mutate(file)
                        e.target.value = ''
                      }
                    }}
                  />
                  <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={uploadFileMutation.isPending}>
                    {uploadFileMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Upload className="h-4 w-4 mr-2" />
                    )}
                    Upload File
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {files.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  No files uploaded yet. Upload files to make them available to this agent.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Uploaded By</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="w-10"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {files.map((file) => (
                        <TableRow key={file.id}>
                          <TableCell className="text-sm font-medium">
                            <div className="flex items-center gap-2">
                              <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                              {file.name}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{file.mimeType}</TableCell>
                          <TableCell className="text-sm">{formatFileSize(file.size)}</TableCell>
                          <TableCell className="text-xs text-muted-foreground font-mono">
                            {file.uploadedBy?.slice(0, 8) || '--'}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {formatDateTime(file.createdAt)}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0"
                              onClick={async () => {
                                try {
                                  const response = await filesApi.download(file.id)
                                  const blob = new Blob([response.data])
                                  const url = URL.createObjectURL(blob)
                                  const a = document.createElement('a')
                                  a.href = url
                                  a.download = file.name
                                  a.click()
                                  URL.revokeObjectURL(url)
                                } catch (err: any) {
                                  errorNotif('Download Failed', err?.message || 'Failed to download file')
                                }
                              }}
                            >
                              <Download className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Interfaces Tab ── */}
        <TabsContent value="interfaces" className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold">Deployed Interfaces</h3>
              <p className="text-xs text-muted-foreground">Channels where this agent is accessible</p>
            </div>
            <Button size="sm" onClick={() => setDeployInterfaceOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Deploy Interface
            </Button>
          </div>

          {interfaces.length === 0 ? (
            <Card>
              <CardContent className="py-8">
                <p className="text-sm text-muted-foreground text-center">
                  No interfaces deployed yet. Deploy an interface to make this agent accessible via chat widgets, Slack, Discord, and more.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {interfaces.map((iface) => {
                const configSummary = getInterfaceConfigSummary(iface.type, iface.configuration)
                const isWebhookType = ['slack', 'discord', 'telegram', 'whatsapp', 'email', 'webhook', 'google_chat', 'microsoft_teams', 'signal', 'matrix', 'irc'].includes(iface.type)
                const webhookUrl = isWebhookType ? `https://api.staging.almyty.com/interfaces/${iface.id}/webhook` : null
                const embedSnippet = iface.type === 'chat_widget' ? `<script src="https://api.staging.almyty.com/widget/${iface.id}"></script>` : null

                return (
                  <Card key={iface.id} className="hover:shadow-md transition-shadow">
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex items-center gap-2">
                          <span className="text-2xl">{interfaceTypeIcons[iface.type] || '🔌'}</span>
                          <div>
                            <div className="font-medium text-sm">{iface.name}</div>
                            <div className="text-xs text-muted-foreground">{iface.type.replace('_', ' ')}</div>
                          </div>
                        </div>
                        <Badge variant={interfaceStatusVariant[iface.status] || 'secondary'}>
                          {iface.status}
                        </Badge>
                      </div>

                      {/* Configuration summary */}
                      {configSummary.length > 0 && (
                        <div className="mb-3 rounded border bg-muted/30 p-2 space-y-1">
                          {configSummary.map((item) => (
                            <div key={item.label} className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground">{item.label}</span>
                              <span className="font-mono truncate max-w-[60%] text-right">
                                {item.secret ? maskSecret(item.value) : (item.value || '-')}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Webhook URL or Embed snippet */}
                      {webhookUrl && (
                        <div className="mb-3 rounded border bg-muted/30 p-2">
                          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Webhook URL</div>
                          <div className="flex items-center gap-1">
                            <code className="text-[11px] break-all flex-1">{webhookUrl}</code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => { navigator.clipboard.writeText(webhookUrl); success('Copied', 'Webhook URL copied to clipboard.') }}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )}
                      {embedSnippet && (
                        <div className="mb-3 rounded border bg-muted/30 p-2">
                          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">Embed Snippet</div>
                          <div className="flex items-center gap-1">
                            <code className="text-[11px] break-all flex-1">{embedSnippet}</code>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 shrink-0"
                              onClick={() => { navigator.clipboard.writeText(embedSnippet); success('Copied', 'Embed snippet copied to clipboard.') }}
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )}

                      <div className="space-y-1 text-xs text-muted-foreground">
                        <div className="flex items-center gap-1">
                          <MessageSquare className="h-3 w-3" />
                          <span>{iface.totalMessages} message{iface.totalMessages !== 1 ? 's' : ''}</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          <span>Last active: {iface.lastMessageAt ? formatDateTime(iface.lastMessageAt) : 'Never'}</span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>
      </Tabs>

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

      {/* Add Memory Dialog */}
      <Dialog open={addMemoryOpen} onOpenChange={setAddMemoryOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Memory</DialogTitle>
            <DialogDescription>
              Create a new memory entry scoped to this agent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="memory-content">Content</Label>
              <Textarea
                id="memory-content"
                placeholder="Enter memory content..."
                value={newMemoryContent}
                onChange={(e) => setNewMemoryContent(e.target.value)}
                className="mt-1"
                rows={4}
              />
            </div>
            <div>
              <Label htmlFor="memory-type">Type</Label>
              <Select value={newMemoryType} onValueChange={setNewMemoryType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fact">Fact</SelectItem>
                  <SelectItem value="preference">Preference</SelectItem>
                  <SelectItem value="context">Context</SelectItem>
                  <SelectItem value="episode">Episode</SelectItem>
                  <SelectItem value="instruction">Instruction</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="memory-tags">Tags (comma-separated)</Label>
              <Input
                id="memory-tags"
                placeholder="tag1, tag2, tag3"
                value={newMemoryTags}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewMemoryTags(e.target.value)}
                className="mt-1"
              />
            </div>
            <Button
              className="w-full"
              disabled={!newMemoryContent.trim() || addMemoryMutation.isPending}
              onClick={() => addMemoryMutation.mutate()}
            >
              {addMemoryMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <Brain className="h-4 w-4 mr-2" />
                  Add Memory
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Deploy Interface Dialog */}
      <Dialog open={deployInterfaceOpen} onOpenChange={setDeployInterfaceOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Deploy Interface</DialogTitle>
            <DialogDescription>
              Deploy this agent to a new channel.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="interface-type">Type</Label>
              <Select value={newInterfaceType} onValueChange={(val) => { setNewInterfaceType(val); setInterfaceConfig(getDefaultInterfaceConfig(val)) }}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="chat_widget">Chat Widget</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="discord">Discord</SelectItem>
                  <SelectItem value="telegram">Telegram</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="google_chat">Google Chat</SelectItem>
                  <SelectItem value="microsoft_teams">Microsoft Teams</SelectItem>
                  <SelectItem value="signal">Signal</SelectItem>
                  <SelectItem value="matrix">Matrix</SelectItem>
                  <SelectItem value="irc">IRC</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="interface-name">Name</Label>
              <Input
                id="interface-name"
                placeholder={`${newInterfaceType.replace('_', ' ')} interface`}
                value={newInterfaceName}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewInterfaceName(e.target.value)}
                className="mt-1"
              />
            </div>

            {/* ── Type-specific configuration ── */}
            {newInterfaceType === 'chat_widget' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Widget Settings</p>
                <div>
                  <Label htmlFor="cfg-welcome">Welcome Message</Label>
                  <Input
                    id="cfg-welcome"
                    placeholder="Hi! How can I help you?"
                    value={interfaceConfig.welcomeMessage || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, welcomeMessage: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-color">Primary Color</Label>
                  <Input
                    id="cfg-color"
                    placeholder="#8b5cf6"
                    value={interfaceConfig.primaryColor || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, primaryColor: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-position">Position</Label>
                  <Select value={interfaceConfig.position || 'bottom-right'} onValueChange={(val) => setInterfaceConfig(prev => ({ ...prev, position: val }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="bottom-right">Bottom Right</SelectItem>
                      <SelectItem value="bottom-left">Bottom Left</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="cfg-theme">Theme</Label>
                  <Select value={interfaceConfig.theme || 'auto'} onValueChange={(val) => setInterfaceConfig(prev => ({ ...prev, theme: val }))}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="auto">Auto</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {newInterfaceType === 'slack' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Slack Settings</p>
                <div>
                  <Label htmlFor="cfg-slack-token">Bot Token</Label>
                  <Input
                    id="cfg-slack-token"
                    type="password"
                    placeholder="xoxb-..."
                    value={interfaceConfig.botToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-slack-secret">Signing Secret</Label>
                  <Input
                    id="cfg-slack-secret"
                    type="password"
                    placeholder="Signing secret"
                    value={interfaceConfig.signingSecret || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, signingSecret: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-slack-channels">Channel IDs</Label>
                  <Input
                    id="cfg-slack-channels"
                    placeholder="C01234, C56789"
                    value={interfaceConfig.channelIds || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, channelIds: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'discord' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Discord Settings</p>
                <div>
                  <Label htmlFor="cfg-discord-token">Bot Token</Label>
                  <Input
                    id="cfg-discord-token"
                    type="password"
                    placeholder="Bot token"
                    value={interfaceConfig.botToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-discord-guilds">Guild IDs</Label>
                  <Input
                    id="cfg-discord-guilds"
                    placeholder="123456789, 987654321"
                    value={interfaceConfig.guildIds || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, guildIds: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'telegram' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Telegram Settings</p>
                <div>
                  <Label htmlFor="cfg-telegram-token">Bot Token</Label>
                  <Input
                    id="cfg-telegram-token"
                    type="password"
                    placeholder="123456:ABC-DEF..."
                    value={interfaceConfig.botToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'whatsapp' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">WhatsApp Settings</p>
                <div>
                  <Label htmlFor="cfg-wa-sid">Twilio Account SID</Label>
                  <Input
                    id="cfg-wa-sid"
                    placeholder="AC..."
                    value={interfaceConfig.accountSid || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, accountSid: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-wa-auth">Twilio Auth Token</Label>
                  <Input
                    id="cfg-wa-auth"
                    type="password"
                    placeholder="Auth token"
                    value={interfaceConfig.authToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, authToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-wa-phone">Phone Number</Label>
                  <Input
                    id="cfg-wa-phone"
                    placeholder="+1234567890"
                    value={interfaceConfig.phoneNumber || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, phoneNumber: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'email' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Email Settings</p>
                <div>
                  <Label htmlFor="cfg-email-key">Resend API Key</Label>
                  <Input
                    id="cfg-email-key"
                    type="password"
                    placeholder="re_..."
                    value={interfaceConfig.resendApiKey || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, resendApiKey: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-email-from">Reply From Address</Label>
                  <Input
                    id="cfg-email-from"
                    placeholder="agent@yourdomain.com"
                    value={interfaceConfig.replyFrom || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, replyFrom: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-email-receive">Receive Address</Label>
                  <Input
                    id="cfg-email-receive"
                    placeholder="inbox@yourdomain.com"
                    value={interfaceConfig.receiveAddress || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, receiveAddress: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'webhook' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Webhook Settings</p>
                <div>
                  <Label htmlFor="cfg-webhook-url">Callback URL</Label>
                  <Input
                    id="cfg-webhook-url"
                    placeholder="https://..."
                    value={interfaceConfig.callbackUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, callbackUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-webhook-secret">Secret</Label>
                  <Input
                    id="cfg-webhook-secret"
                    type="password"
                    placeholder="HMAC verification secret"
                    value={interfaceConfig.secret || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, secret: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'google_chat' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Google Chat Settings</p>
                <div>
                  <Label htmlFor="cfg-gchat-webhook">Webhook URL</Label>
                  <Input
                    id="cfg-gchat-webhook"
                    placeholder="https://chat.googleapis.com/v1/spaces/..."
                    value={interfaceConfig.webhookUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, webhookUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-gchat-space">Space ID</Label>
                  <Input
                    id="cfg-gchat-space"
                    placeholder="spaces/AAAA..."
                    value={interfaceConfig.spaceId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, spaceId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'microsoft_teams' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Microsoft Teams Settings</p>
                <div>
                  <Label htmlFor="cfg-teams-botid">Bot ID</Label>
                  <Input
                    id="cfg-teams-botid"
                    placeholder="Bot (App) ID"
                    value={interfaceConfig.botId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-teams-password">Bot Password</Label>
                  <Input
                    id="cfg-teams-password"
                    type="password"
                    placeholder="Bot password / client secret"
                    value={interfaceConfig.botPassword || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, botPassword: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-teams-tenant">Tenant ID</Label>
                  <Input
                    id="cfg-teams-tenant"
                    placeholder="Azure AD Tenant ID"
                    value={interfaceConfig.tenantId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, tenantId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'signal' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Signal Settings</p>
                <div>
                  <Label htmlFor="cfg-signal-phone">Signal Phone Number</Label>
                  <Input
                    id="cfg-signal-phone"
                    placeholder="+1234567890"
                    value={interfaceConfig.phoneNumber || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, phoneNumber: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-signal-api">signal-cli API URL</Label>
                  <Input
                    id="cfg-signal-api"
                    placeholder="http://localhost:8080"
                    value={interfaceConfig.apiUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, apiUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'matrix' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Matrix Settings</p>
                <div>
                  <Label htmlFor="cfg-matrix-hs">Homeserver URL</Label>
                  <Input
                    id="cfg-matrix-hs"
                    placeholder="https://matrix.org"
                    value={interfaceConfig.homeserverUrl || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, homeserverUrl: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-matrix-token">Access Token</Label>
                  <Input
                    id="cfg-matrix-token"
                    type="password"
                    placeholder="syt_..."
                    value={interfaceConfig.accessToken || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, accessToken: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-matrix-room">Room ID</Label>
                  <Input
                    id="cfg-matrix-room"
                    placeholder="!abc123:matrix.org"
                    value={interfaceConfig.roomId || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, roomId: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {newInterfaceType === 'irc' && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">IRC Settings</p>
                <div>
                  <Label htmlFor="cfg-irc-server">Server</Label>
                  <Input
                    id="cfg-irc-server"
                    placeholder="irc.libera.chat"
                    value={interfaceConfig.server || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, server: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-irc-port">Port</Label>
                  <Input
                    id="cfg-irc-port"
                    placeholder="6667"
                    value={interfaceConfig.port || '6667'}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, port: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-irc-channel">Channel</Label>
                  <Input
                    id="cfg-irc-channel"
                    placeholder="#my-channel"
                    value={interfaceConfig.channel || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, channel: e.target.value }))}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label htmlFor="cfg-irc-nick">Nick</Label>
                  <Input
                    id="cfg-irc-nick"
                    placeholder="mybot"
                    value={interfaceConfig.nick || ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setInterfaceConfig(prev => ({ ...prev, nick: e.target.value }))}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            <Button
              className="w-full"
              disabled={deployInterfaceMutation.isPending}
              onClick={() => deployInterfaceMutation.mutate()}
            >
              {deployInterfaceMutation.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Plug className="h-4 w-4 mr-2" />
                  Deploy
                </>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
