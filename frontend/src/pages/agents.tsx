import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import {
  Bot,
  Plus,
  MoreHorizontal,
  Play,
  Pause,
  Copy,
  Trash2,
  Pencil,
  Activity,
  Clock,
  CircleDot,
  Search,
  FileUp,
  Sparkles,
  Zap,
  Brain,
  Wrench,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { agentsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import type { Agent, AgentStatus } from '@/types'

interface AgentTemplate {
  id: string
  name: string
  description: string
  category: string
  pipeline: any
}

const statusVariant: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  active: 'default',
  draft: 'outline',
  inactive: 'secondary',
  error: 'destructive',
}

const createAgentSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
})

type CreateAgentForm = z.infer<typeof createAgentSchema>

const DEFAULT_PIPELINE = {
  nodes: [
    { id: 'input_1', type: 'input' as const, position: { x: 0, y: 200 }, data: { schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } } },
    { id: 'llm_1', type: 'llm_call' as const, position: { x: 300, y: 200 }, data: { providerId: '', userPromptTemplate: '{{input.message}}' } },
    { id: 'output_1', type: 'output' as const, position: { x: 600, y: 200 }, data: { mapping: '{{nodes.llm_1.output}}' } },
  ],
  edges: [
    { id: 'e1', source: 'input_1', target: 'llm_1' },
    { id: 'e2', source: 'llm_1', target: 'output_1' },
  ],
}

export function AgentsPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importJson, setImportJson] = useState('')
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [showTemplates, setShowTemplates] = useState(true)

  // Fetch agents
  const { data: agentsData, isLoading } = useQuery({
    queryKey: ['agents', currentOrganization?.id],
    queryFn: async () => {
      const response = await agentsApi.getAll()
      const d = response.data?.data || response.data
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })

  // Fetch templates
  const { data: templatesData } = useQuery({
    queryKey: ['agent-templates'],
    queryFn: async () => {
      const response = await agentsApi.getTemplates()
      return response.data?.data || []
    },
    enabled: !!currentOrganization,
  })

  const templates: AgentTemplate[] = Array.isArray(templatesData) ? templatesData : []

  const agents: Agent[] = Array.isArray(agentsData) ? agentsData : []

  const filteredAgents = agents.filter((agent) => {
    if (!searchQuery) return true
    return (
      agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (agent.description || '').toLowerCase().includes(searchQuery.toLowerCase())
    )
  })

  const activeCount = agents.filter((a) => a.status === 'active').length

  // Form setup
  const createForm = useForm<CreateAgentForm>({
    resolver: zodResolver(createAgentSchema),
    defaultValues: { name: '', description: '' },
  })

  // Create agent mutation
  const createAgentMutation = useMutation({
    mutationFn: async (data: CreateAgentForm) => {
      const payload = {
        name: data.name,
        description: data.description || undefined,
        pipeline: DEFAULT_PIPELINE,
      }
      const response = await agentsApi.create(payload, currentOrganization?.id)
      return response.data
    },
    onSuccess: async (result) => {
      success('Agent Created', `${createForm.getValues('name')} is ready to configure.`)
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      createForm.reset()
      setCreateDialogOpen(false)
    },
    onError: (err: any) => {
      errorNotif('Error', err?.response?.data?.message || err?.message || 'Failed to create agent')
    },
  })

  // Delete agent mutation
  const deleteAgentMutation = useMutation({
    mutationFn: async (agentId: string) => {
      return await agentsApi.delete(agentId)
    },
    onSuccess: async () => {
      success('Agent Deleted', 'Agent has been deleted successfully.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      setDeleteDialogOpen(false)
      setAgentToDelete(null)
    },
    onError: (err: any) => {
      errorNotif('Failed to delete agent', err?.response?.data?.message || 'Please try again.')
    },
  })

  // Activate mutation
  const activateMutation = useMutation({
    mutationFn: (id: string) => agentsApi.activate(id),
    onSuccess: async () => {
      success('Agent Activated', 'Agent is now active.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (err: any) => {
      errorNotif('Error', err?.response?.data?.message || 'Failed to activate agent')
    },
  })

  // Deactivate mutation
  const deactivateMutation = useMutation({
    mutationFn: (id: string) => agentsApi.deactivate(id),
    onSuccess: async () => {
      success('Agent Deactivated', 'Agent is now inactive.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (err: any) => {
      errorNotif('Error', err?.response?.data?.message || 'Failed to deactivate agent')
    },
  })

  // Duplicate mutation
  const duplicateMutation = useMutation({
    mutationFn: (id: string) => agentsApi.duplicate(id),
    onSuccess: async () => {
      success('Agent Duplicated', 'A copy of the agent has been created.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
    onError: (err: any) => {
      errorNotif('Error', err?.response?.data?.message || 'Failed to duplicate agent')
    },
  })

  // Import mutation
  const importAgentMutation = useMutation({
    mutationFn: async (jsonStr: string) => {
      const data = JSON.parse(jsonStr)
      const response = await agentsApi.importAgent(data)
      return response.data
    },
    onSuccess: async () => {
      success('Agent Imported', 'Agent has been imported successfully.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      setImportDialogOpen(false)
      setImportJson('')
    },
    onError: (err: any) => {
      errorNotif('Import Failed', err?.message || 'Invalid JSON or import failed')
    },
  })

  const handleCreateSubmit = (data: CreateAgentForm) => {
    createAgentMutation.mutate(data)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground">
            {agents.length} agents ({activeCount} active)
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportDialogOpen(true)} disabled={!currentOrganization}>
            <FileUp className="h-4 w-4 mr-2" />
            Import
          </Button>
          <Button onClick={() => navigate('/agents/new')} disabled={!currentOrganization}>
            <Plus className="h-4 w-4 mr-2" />
            Create Agent
          </Button>
        </div>
      </div>

      {!currentOrganization ? (
        <div className="flex items-center justify-center h-96">
          <div className="text-center">
            <p className="text-muted-foreground">No organization selected. Please select or create an organization.</p>
          </div>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center h-96">
          <LoadingSpinner size="lg" />
        </div>
      ) : agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Bot className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Create your first agent</h3>
            <p className="text-muted-foreground mb-6 text-center max-w-md">
              Agents orchestrate LLM calls, tool executions, and data transformations into powerful pipelines.
            </p>
            <Button size="lg" onClick={() => navigate('/agents/new')}>
              <Plus className="h-4 w-4 mr-2" />
              Create Agent
            </Button>
          </CardContent>
        </Card>
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
                  return (
                    <Card
                      key={template.id}
                      className="hover:shadow-md transition-shadow cursor-pointer border-dashed"
                      onClick={() => navigate(`/agents/new?template=${template.id}`)}
                    >
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
                  )
                })}
              </div>
            </div>
          )}

          {/* Search */}
          {agents.length > 0 && (
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search agents..."
                className="pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
          )}

          {/* Agent Cards Grid */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {filteredAgents.map((agent) => {
              const nodeCount = agent.pipeline?.nodes?.length || 0
              return (
                <Card
                  key={agent.id}
                  className="hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => navigate(`/agents/${agent.id}`)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0">
                          <Bot className="h-5 w-5 text-white" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-base truncate">{agent.name}</CardTitle>
                          <CardDescription className="text-xs truncate">
                            {agent.description || 'No description'}
                          </CardDescription>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Badge variant={statusVariant[agent.status] || 'secondary'}>
                          {agent.status}
                        </Badge>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                            <DropdownMenuItem onClick={() => navigate(`/agents/${agent.id}`)}>
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
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-sm text-muted-foreground">
                      <div className="flex items-center gap-4">
                        <div className="flex items-center gap-1">
                          <CircleDot className="h-3.5 w-3.5" />
                          <span>{nodeCount} nodes</span>
                        </div>
                        <div className="flex items-center gap-1">
                          <Activity className="h-3.5 w-3.5" />
                          <span>{agent.totalExecutions || 0} runs</span>
                        </div>
                      </div>
                      {agent.averageExecutionTime > 0 && (
                        <div className="flex items-center gap-1">
                          <Clock className="h-3.5 w-3.5" />
                          <span>{(agent.averageExecutionTime / 1000).toFixed(1)}s avg</span>
                        </div>
                      )}
                    </div>
                    {agent.totalExecutions > 0 && (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <span className="text-green-600">{agent.successfulExecutions || 0} ok</span>
                        <span className="text-muted-foreground">/</span>
                        <span className="text-muted-foreground">{agent.totalExecutions} total</span>
                        {agent.totalCost > 0 && (
                          <>
                            <span className="text-muted-foreground">·</span>
                            <span className="text-muted-foreground">${agent.totalCost.toFixed(4)}</span>
                          </>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>

          {filteredAgents.length === 0 && searchQuery && (
            <div className="text-center py-12 text-muted-foreground">
              No agents match "{searchQuery}"
            </div>
          )}
        </>
      )}

      {/* Create Agent Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={(open) => {
        setCreateDialogOpen(open)
        if (!open) {
          createForm.reset()
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>
              Create a new agent with a default pipeline. You can customize the pipeline after creation.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createForm.handleSubmit(handleCreateSubmit)} className="space-y-4">
            <div>
              <Label htmlFor="agent-name">Name</Label>
              <Input
                id="agent-name"
                placeholder="My Agent"
                {...createForm.register('name')}
                className="mt-1"
              />
              {createForm.formState.errors.name && (
                <p className="text-sm text-red-500 mt-1">
                  {createForm.formState.errors.name.message}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="agent-description">Description (optional)</Label>
              <Textarea
                id="agent-description"
                placeholder="What does this agent do?"
                {...createForm.register('description')}
                className="mt-1"
              />
            </div>
            <div className="flex justify-end space-x-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreateDialogOpen(false)
                  createForm.reset()
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createAgentMutation.isPending}>
                {createAgentMutation.isPending ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Creating...
                  </>
                ) : (
                  'Create'
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Agent
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Import Agent Dialog */}
      <Dialog open={importDialogOpen} onOpenChange={(open) => {
        setImportDialogOpen(open)
        if (!open) setImportJson('')
      }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import Agent</DialogTitle>
            <DialogDescription>
              Paste an exported agent JSON to create a new agent from it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="import-json">Agent JSON</Label>
              <Textarea
                id="import-json"
                className="mt-1 font-mono text-xs"
                rows={12}
                placeholder='{"name": "My Agent", "pipeline": { ... }}'
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setImportDialogOpen(false); setImportJson('') }}>
                Cancel
              </Button>
              <Button
                onClick={() => importAgentMutation.mutate(importJson)}
                disabled={importAgentMutation.isPending || !importJson.trim()}
              >
                {importAgentMutation.isPending ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Importing...
                  </>
                ) : (
                  <>
                    <FileUp className="h-4 w-4 mr-2" />
                    Import
                  </>
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
