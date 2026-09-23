import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, Link } from 'react-router-dom'
import {
  Bot,
  Plus,
  MoreHorizontal,
  Play,
  Pause,
  Copy,
  Trash2,
  Pencil,
  Search,
  FileUp,
  Sparkles,
  Zap,
  Brain,
  Wrench,
  Globe,
  Building2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { QueryError } from '@/components/ui/query-error'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { agentsApi, externalAgentsApi } from '@/lib/api'
import { pluralized } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { ImportExternalA2ADialog } from '@/components/agents/import-external-a2a-dialog'
import { TeamFilter, useTeamLookup, VisibilityBadge, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import type { Agent, ExternalAgent } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'

interface AgentTemplate {
  id: string
  name: string
  description: string
  category: string
  pipeline: {
    nodes: Array<{ id: string; type: string; position?: { x: number; y: number }; data?: Record<string, unknown> }>
    edges: Array<{ id: string; source: string; target: string }>
  }
}

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline' | 'success'> = {
  active: 'success',
  draft: 'outline',
  inactive: 'secondary',
  error: 'destructive',
}

export function AgentsPage() {
  useEffect(() => {
    document.title = 'Agents | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [importExternalOpen, setImportExternalOpen] = useState(false)
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [showTemplates, setShowTemplates] = useState(true)
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  // Fetch agents
  const { data: agentsData, isLoading, isError, error: agentsError, refetch: refetchAgents } = useQuery({
    queryKey: ['agents', currentOrganization?.id],
    queryFn: async () => {
      const d = await agentsApi.getAll()
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })

  // Fetch templates
  const { data: templatesData } = useQuery({
    queryKey: ['agent-templates'],
    queryFn: async () => {
      const d = await agentsApi.getTemplates()
      return d || []
    },
    enabled: !!currentOrganization,
  })

  // Fetch external agents
  const { data: externalAgentsData } = useQuery({
    queryKey: ['external-agents', currentOrganization?.id],
    queryFn: () => externalAgentsApi.getAll(),
    enabled: !!currentOrganization,
  })

  const externalAgents: ExternalAgent[] = (() => {
    const raw = externalAgentsData?.externalAgents || (Array.isArray(externalAgentsData) ? externalAgentsData : [])
    return Array.isArray(raw) ? raw : []
  })()

  const templates: AgentTemplate[] = Array.isArray(templatesData) ? templatesData : []

  const agents: Agent[] = Array.isArray(agentsData) ? agentsData : []

  const filteredAgents = filterByTeamVisibility(agents as any[], teamFilter).filter((agent: Agent) => {
    const matchesSearch = !searchQuery ||
      agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (agent.description || '').toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === 'all' || agent.status === statusFilter
    return matchesSearch && matchesStatus
  })

  const activeCount = agents.filter((a) => a.status === 'active').length

  // The same four keys the detail page drops for these operations. A
  // list-page activate used to invalidate ['agents'] only, so the
  // detail page -- and its version list and audit log, both of which
  // gain a row from the operation -- kept serving the old answer.
  const invalidateAgent = async (agentId: string) => {
    await queryClient.invalidateQueries({ queryKey: ['agent', agentId] })
    await queryClient.invalidateQueries({ queryKey: ['agents'] })
    await queryClient.invalidateQueries({ queryKey: ['entity-versions', 'Agent', agentId] })
    await queryClient.invalidateQueries({ queryKey: ['agent-audit-log', agentId] })
  }
  // Delete agent mutation
  const deleteAgentMutation = useMutation({
    mutationFn: async (agentId: string) => {
      return await agentsApi.delete(agentId)
    },
    onSuccess: async (_result, agentId) => {
      success('Agent Deleted', 'Agent has been deleted successfully.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      // The detail page's caches for this agent would otherwise be
      // served to whoever navigated to it next. agent-detail.tsx does
      // the same four keys for the same operations; the list page only
      // ever dropped ['agents'].
      queryClient.removeQueries({ queryKey: ['agent', agentId] })
      queryClient.removeQueries({ queryKey: ['entity-versions', 'Agent', agentId] })
      queryClient.removeQueries({ queryKey: ['agent-audit-log', agentId] })
      setDeleteDialogOpen(false)
      setAgentToDelete(null)
    },
    onError: (err: any) => {
      errorNotif('Failed to delete agent', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Activate mutation
  const activateMutation = useMutation({
    mutationFn: (id: string) => agentsApi.activate(id),
    onSuccess: async (_result, id) => {
      success('Agent Activated', 'Agent is now active.')
      await invalidateAgent(id)
    },
    onError: (err: any) => {
      errorNotif('Error', getApiErrorMessage(err, 'Failed to activate agent'))
    },
  })

  // Deactivate mutation
  const deactivateMutation = useMutation({
    mutationFn: (id: string) => agentsApi.deactivate(id),
    onSuccess: async (_result, id) => {
      success('Agent Deactivated', 'Agent is now inactive.')
      await invalidateAgent(id)
    },
    onError: (err: any) => {
      errorNotif('Error', getApiErrorMessage(err, 'Failed to deactivate agent'))
    },
  })

  // Duplicate mutation
  const duplicateMutation = useMutation({
    mutationFn: (id: string) => agentsApi.duplicate(id),
    onSuccess: async (_result, id) => {
      success('Agent Duplicated', 'A copy of the agent has been created.')
      await invalidateAgent(id)
    },
    onError: (err: any) => {
      errorNotif('Error', getApiErrorMessage(err, 'Failed to duplicate agent'))
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title="Agents"
        description={
          isLoading ? (
            <span className="inline-block w-48 h-4 bg-muted animate-pulse rounded" />
          ) : (
            `${pluralized(agents.length, 'agent')} · ${activeCount} active${externalAgents.length > 0 ? ` · ${externalAgents.length} external` : ''}`
          )
        }
        actions={
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={!currentOrganization}>
                  <FileUp className="h-4 w-4 mr-2" />
                  Import
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => navigate('/agents/import')}>
                  <FileUp className="h-4 w-4 mr-2" />
                  Import from JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setImportExternalOpen(true)}>
                  <Globe className="h-4 w-4 mr-2" />
                  Import external A2A agent
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button onClick={() => navigate('/agents/new')} disabled={!currentOrganization}>
              <Plus className="h-4 w-4 mr-2" />
              Create agent
            </Button>
          </>
        }
      />
      <PageIntro topic="agents" />

      {!currentOrganization ? (
        <EmptyState
          variant="panel"
          icon={Building2}
          title="No organization selected"
          description="Select or create an organization to see its agents."
        />
      ) : isError ? (
        <QueryError error={agentsError} onRetry={() => refetchAgents()} title="Couldn't load agents" />
      ) : !isLoading && agents.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Bot}
          title="No agents yet"
          description="Agents call models and tools to do a job — with cross-vendor verification if you want a second opinion."
          action={
            <Button onClick={() => navigate('/agents/new')}>
              <Plus className="h-4 w-4 mr-2" />
              Create agent
            </Button>
          }
        />
      ) : (
        <>
          {/* Templates Section */}
          {templates.length > 0 && showTemplates && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  <h2 className="text-sm font-semibold">Start from a Template</h2>
                </div>
                <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => setShowTemplates(false)}>
                  Hide
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
                {templates.map((template) => {
                  const Icon = template.category === 'basic' ? Zap : template.id === 'research-agent' ? Brain : template.id === 'tool-augmented' ? Wrench : Bot
                  // These are the headline "create an agent" entry, and they
                  // were a <Card onClick> -- no tab stop, no Enter, no
                  // cmd-click. A Link wrapping the card keeps the look and
                  // gives it real link behaviour.
                  return (
                    <Link
                      key={template.id}
                      to={`/agents/new?template=${template.id}`}
                      className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <Card className="h-full hover:shadow-md transition-shadow cursor-pointer border-dashed">
                        <CardContent className="pt-4 pb-4">
                          <div className="flex items-start gap-3">
                            <div className="w-8 h-8 rounded-md bg-amber-500/10 flex items-center justify-center shrink-0">
                              <Icon className="h-4 w-4 text-amber-600" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium text-sm">{template.name}</p>
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{template.description}</p>
                              <Badge variant="outline" className="mt-1.5 text-[10px]">{template.category}</Badge>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    </Link>
                  )
                })}
              </div>
            </div>
          )}

          {/* Agent Table */}
          <Card>
            <CardContent className="pt-6 space-y-4">
              {agents.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search agents..."
                      className="pl-10"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm w-32"
                  >
                    <option value="all">All Status</option>
                    <option value="draft">Draft</option>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                  <TeamFilter
                    organizationId={currentOrganization?.id}
                    value={teamFilter}
                    onChange={setTeamFilter}
                  />
                </div>
              )}
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border/50">
                    <th className="py-3 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Name</th>
                    <th className="py-3 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Status</th>
                    <th className="py-3 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Nodes</th>
                    <th className="py-3 px-4 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">Runs</th>
                    <th className="py-3 px-4 text-right text-xs font-medium text-muted-foreground uppercase tracking-wider"></th>
                  </tr>
                </thead>
                <tbody>
            {filteredAgents.map((agent) => {
              const nodeCount = agent.pipeline?.nodes?.length || 0
              return (
                <tr
                  key={agent.id}
                  className="border-b border-border/50 hover:bg-accent/30 cursor-pointer transition-colors"
                  onClick={(e) => {
                    const target = e.target as HTMLElement
                    // The name is now a real link, so let the anchor handle its
                    // own click rather than navigating twice.
                    if (target.closest('button, a, [role="menuitem"]')) return
                    navigate(`/agents/${agent.id}`)
                  }}
                >
                  <td className="py-3 px-4">
                    <div>
                      <div className="flex items-center gap-1.5">
                        {/*
                          onClick on a <tr> is unreachable by keyboard, and the
                          row menu only offers Edit -- there was no way to open
                          an agent without a mouse. This link is that way in.
                        */}
                        <Link
                          to={`/agents/${agent.id}`}
                          className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
                        >
                          {agent.name}
                        </Link>
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">Native</Badge>
                        <VisibilityBadge
                          visibility={(agent as any).visibility}
                          teamId={(agent as any).teamId}
                          teamLookup={teamLookup}
                        />
                      </div>
                      <div className="text-xs text-muted-foreground truncate max-w-[300px]">
                        {agent.description || 'No description'}
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <Badge variant={statusVariant[agent.status] || 'secondary'}>
                      {agent.status === 'active' ? 'Active' : agent.status === 'draft' ? 'Draft' : agent.status}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-foreground">
                    {agent.mode === 'autonomous' ? (
                      <Badge
                        variant="outline"
                        className="text-[10px] px-1.5 py-0 border-violet-600 text-violet-600 dark:border-violet-500 dark:text-violet-400"
                      >
                        Autonomous
                      </Badge>
                    ) : (
                      nodeCount
                    )}
                  </td>
                  <td className="py-3 px-4 text-sm text-muted-foreground">{agent.totalExecutions || 0}</td>
                  <td className="py-3 px-4 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Open actions menu">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}/edit`)}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => duplicateMutation.mutate(agent.id)}>
                              <Copy className="h-4 w-4 mr-2" />
                              Duplicate
                            </DropdownMenuItem>
                            {agent.status === 'active' ? (
                              <DropdownMenuItem onClick={() => deactivateMutation.mutate(agent.id)}>
                                <Pause className="h-4 w-4 mr-2" />
                                Deactivate
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem onClick={() => activateMutation.mutate(agent.id)}>
                                <Play className="h-4 w-4 mr-2" />
                                Activate
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive focus:text-destructive"
                              onClick={() => {
                                setAgentToDelete(agent)
                                setDeleteDialogOpen(true)
                              }}
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                  </td>
                </tr>
              )
            })}
            {externalAgents
              .filter((ea) => !searchQuery || ea.name.toLowerCase().includes(searchQuery.toLowerCase()) || (ea.description || '').toLowerCase().includes(searchQuery.toLowerCase()))
              .map((ea) => (
              <tr
                key={`ext-${ea.id}`}
                className="border-b border-border/50 hover:bg-accent/30 transition-colors"
              >
                <td className="py-3 px-4">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <Globe className="h-3.5 w-3.5 text-cyan-500 shrink-0" />
                      <span className="font-medium">{ea.name}</span>
                      <ProtocolBadge protocol="a2a" label="External A2A" className="text-[10px] px-1.5 py-0 normal-case" />
                    </div>
                    <div className="text-xs text-muted-foreground truncate max-w-[300px]">
                      {ea.description || ea.agentCardUrl}
                    </div>
                  </div>
                </td>
                <td className="py-3 px-4">
                  <Badge variant={ea.status === 'active' ? 'success' : ea.status === 'error' ? 'destructive' : 'secondary'}>
                    {ea.status === 'card_stale' ? 'Stale' : ea.status}
                  </Badge>
                </td>
                <td className="py-3 px-4 text-sm text-muted-foreground">-</td>
                <td className="py-3 px-4 text-sm text-muted-foreground">{ea.totalRequests || 0}</td>
                <td className="py-3 px-4 text-right" />
              </tr>
            ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {!isLoading && agents.length > 0 && filteredAgents.length === 0 && (
            <EmptyState
              variant="panel"
              icon={Search}
              title="No matching agents"
              description={searchQuery ? `Nothing matches "${searchQuery}" with the current filters.` : 'Nothing matches the current filters.'}
            />
          )}
        </>
      )}

      {/* Delete Agent Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{agentToDelete?.name}" and all its execution history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (agentToDelete) {
                  deleteAgentMutation.mutate(agentToDelete.id)
                }
              }}
              variant="destructive"
            >
              Delete agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import External A2A Dialog */}
      <ImportExternalA2ADialog
        open={importExternalOpen}
        onOpenChange={setImportExternalOpen}
      />

    </div>
  )
}
