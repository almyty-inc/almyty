import React, { useState, useMemo, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { type Node, type Edge } from '@xyflow/react'
import { ArrowLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

import { agentsApi, memoriesApi, filesApi, versionsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type {
  Agent,
  AgentExecution,
  PipelineNode,
  PipelineEdge,
  AgentVersionSnapshot,
  AgentAuditEntry,
  AgentRun,
  Memory,
  AgentFile,
} from '@/types'

import { AgentHeader } from '@/components/agents/detail/agent-header'
import { AgentStats } from '@/components/agents/detail/agent-stats'
import { PipelineCanvas } from '@/components/agents/detail/pipeline-canvas'
import { OverviewTab } from '@/components/agents/detail/overview-tab'
import { RunsTab } from '@/components/agents/detail/runs-tab'
import { MemoryTab } from '@/components/agents/detail/memory-tab'
import { FilesTab } from '@/components/agents/detail/files-tab'
import { InterfacesTab } from '@/components/agents/detail/interfaces-tab'
import { PromotedSkillsTab } from '@/components/agents/detail/promoted-skills-tab'
import { ConstraintsTab } from '@/components/agents/detail/constraints-tab'
import { InvokeDialog } from '@/components/agents/detail/invoke-dialog'

export function AgentDetailPage() {
  useEffect(() => {
    document.title = 'Agent Details | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const orgId = useOrganizationStore((s) => s.currentOrganization?.id)

  const [invokeDialogOpen, setInvokeDialogOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('overview')

  // Webhook state (lifted so overview tab can use it, synced from agent data)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleInterval, setScheduleInterval] = useState(60)
  const [scheduleInput, setScheduleInput] = useState('{}')

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
      // apiGet already unwraps the {success, data} envelope via extractData,
      // so `res` is the versions array itself — `res.data` would double-unwrap
      // to undefined and silently empty the Change History. Match the other
      // list callers in this file.
      const res = await versionsApi.getVersions('Agent', id!)
      return Array.isArray(res) ? res : (res?.data || [])
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

  // Fetch memories — agent-scoped reads route through the canonical
  // store via the workspace scope. We don't filter by agent_id here
  // because canonical scoping is per-workspace; the memory tab can
  // narrow client-side via tags or use search if needed.
  const { data: memoriesData } = useQuery({
    queryKey: ['agent-memories', id, orgId],
    queryFn: async () => {
      if (!orgId) return []
      const d: any = await memoriesApi.list({
        scope: { scope_type: 'workspace', scope_id: orgId },
        mode: 'memory',
        limit: 100,
      })
      return d?.data?.items ?? d?.items ?? []
    },
    enabled: !!id && !!orgId && activeTab === 'memory',
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

  // Technical documentation export handler (EU AI Act Annex-IV-style Markdown)
  const handleExportTechDoc = async () => {
    try {
      const markdown = await agentsApi.exportTechnicalDocumentation(id!)
      const blob = new Blob([markdown], { type: 'text/markdown' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${agent?.name?.replace(/[^a-z0-9]/gi, '_').toLowerCase() || 'agent'}-technical-documentation.md`
      a.click()
      URL.revokeObjectURL(url)
      success('Exported', 'Technical documentation downloaded.')
    } catch (err: any) {
      errorNotif('Export Failed', err?.message || 'Failed to export technical documentation')
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

  return (
    <div className="space-y-6">
      <AgentHeader
        agent={agent}
        onExport={handleExport}
        onExportTechDoc={handleExportTechDoc}
        onDuplicate={() => duplicateMutation.mutate()}
        onInvoke={() => setInvokeDialogOpen(true)}
      />

      <AgentStats agent={agent} />

      {/* Pipeline Canvas (read-only) -- hidden for autonomous agents */}
      {agent.mode !== 'autonomous' && (
        <PipelineCanvas flowNodes={flowNodes} flowEdges={flowEdges} />
      )}

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-7">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="memory">Memory</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="interfaces">Interfaces</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="constraints">Constraints</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-6">
          <OverviewTab
            agent={agent}
            executions={executions}
            executionsError={executionsError as Error | null}
            versions={versions}
            entityVersions={entityVersions}
            auditLog={auditLog}
            webhookUrl={webhookUrl}
            setWebhookUrl={setWebhookUrl}
            scheduleEnabled={scheduleEnabled}
            setScheduleEnabled={setScheduleEnabled}
            scheduleInterval={scheduleInterval}
            setScheduleInterval={setScheduleInterval}
            scheduleInput={scheduleInput}
            setScheduleInput={setScheduleInput}
          />
        </TabsContent>

        <TabsContent value="runs" className="space-y-4">
          <RunsTab runs={runs} />
        </TabsContent>

        <TabsContent value="memory" className="space-y-4">
          <MemoryTab agentId={id!} memories={memories} />
        </TabsContent>

        <TabsContent value="files" className="space-y-4">
          <FilesTab agentId={id!} files={files} />
        </TabsContent>

        <TabsContent value="interfaces" className="space-y-4">
          <InterfacesTab agentId={id!} />
        </TabsContent>

        <TabsContent value="skills" className="space-y-4">
          <PromotedSkillsTab agentId={id!} />
        </TabsContent>

        <TabsContent value="constraints" className="space-y-4">
          <ConstraintsTab agentId={id!} />
        </TabsContent>
      </Tabs>

      {/* Invoke Dialog */}
      <InvokeDialog
        agent={agent}
        open={invokeDialogOpen}
        onOpenChange={setInvokeDialogOpen}
      />
    </div>
  )
}
