import React, { useState, useEffect, useCallback } from 'react'
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
  Search,
  FileUp,
  Sparkles,
  Zap,
  Brain,
  Wrench,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { agentsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import type { Agent } from '@/types'

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
  useEffect(() => {
    document.title = 'Agents | almyty'
    return () => { document.title = 'almyty' }
  }, [])

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
  const [statusFilter, setStatusFilter] = useState('all')
  const [showTemplates, setShowTemplates] = useState(true)

  // Fetch agents
  const { data: agentsData, isLoading } = useQuery({
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

  const templates: AgentTemplate[] = Array.isArray(templatesData) ? templatesData : []

  const agents: Agent[] = Array.isArray(agentsData) ? agentsData : []

  const filteredAgents = agents.filter((agent) => {
    const matchesSearch =
      !searchQuery ||
      agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (agent.description || '').toLowerCase().includes(searchQuery.toLowerCase())

    const matchesStatus = statusFilter === 'all' || agent.status === statusFilter

    return matchesSearch && matchesStatus
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
      return agentsApi.create(payload, currentOrganization?.id)
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
      return agentsApi.importAgent(data)
    },
    onSuccess: async (result: any) => {
      success('Agent Imported', 'Agent has been imported successfully.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      setImportDialogOpen(false)
      setImportJson('')
      // Navigate to the newly imported agent
      if (result?.id) {
        navigate(`/agents/${result.id}/edit`)
      }
    },
    onError: (err: any) => {
      errorNotif('Import Failed', err?.message || 'Invalid JSON or import failed')
    },
  })

  // File picker handler for import
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const handleImportFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      const text = evt.target?.result as string
      if (text) {
        setImportJson(text)
      }
    }
    reader.onerror = () => {
      errorNotif('Read Failed', 'Could not read the selected file.')
    }
    reader.readAsText(file)
    // Reset so the same file can be re-selected
    e.target.value = ''
  }, [errorNotif])

  const handleCreateSubmit = (data: CreateAgentForm) => {
    createAgentMutation.mutate(data)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">Agents</h1>
          <p className="text-muted-foreground">
            {isLoading ? <span className="inline-block w-48 h-4 bg-muted animate-pulse rounded" /> : `${agents.length} agents (${activeCount} active)`}
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

          {/* Agent Table */}
          <Card>
            <CardContent className="pt-6 space-y-4">
              {/* Filters */}
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search agents..."
                      className="pl-10"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Status</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </div>
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
                    if (target.closest('button, [role="menuitem"]')) return
                    navigate(`/agents/${agent.id}`)
                  }}
                >
                  <td className="py-3 px-4">
                    <div>
                      <span className="font-medium text-primary hover:underline">{agent.name}</span>
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
                  <td className="py-3 px-4 text-sm text-muted-foreground">{nodeCount}</td>
                  <td className="py-3 px-4 text-sm text-muted-foreground">{agent.totalExecutions || 0}</td>
                  <td className="py-3 px-4 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
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
                </tbody>
              </table>
            </CardContent>
          </Card>

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
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleImportFile}
      />
      <Dialog open={importDialogOpen} onOpenChange={(open) => {
        setImportDialogOpen(open)
        if (!open) setImportJson('')
      }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Import Agent</DialogTitle>
            <DialogDescription>
              Upload a .json file or paste an exported agent JSON to create a new agent.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => fileInputRef.current?.click()}
              >
                <FileUp className="h-4 w-4 mr-2" />
                Choose .json file
              </Button>
            </div>
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or paste JSON</span>
              </div>
            </div>
            <div>
              <Textarea
                id="import-json"
                className="font-mono text-xs"
                rows={10}
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
