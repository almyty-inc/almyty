import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Router, Plus, Search, Zap } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useCreateDeepLink } from '@/hooks/use-create-deep-link'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DataTable, createSelectColumn, createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import type { ColumnDef } from '@tanstack/react-table'

import { gatewaysApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { CreateGatewayDialog } from '@/components/gateways/create-gateway-dialog'
import { GatewayDetailsSheet } from '@/components/gateways/gateway-details-sheet'
import { TeamFilter, useTeamLookup, VisibilityBadge, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import type { Gateway } from '@/types'

// Form Schema
const createGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.string().min(1, 'Type is required'),
  endpoint: z.string().min(1, 'Endpoint path is required').regex(/^\/[a-zA-Z0-9-_/]*$/, 'Must start with / and contain only alphanumeric, -, _, /'),
  description: z.string().optional(),
})

type CreateGatewayForm = z.infer<typeof createGatewaySchema>

export function GatewaysPage() {
  useEffect(() => {
    document.title = 'Gateways | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const navigate = useNavigate()
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  // Honour ?new=1 from the command palette Create Gateway action.
  useCreateDeepLink(setCreateDialogOpen)
  const [deleteGatewayDialogOpen, setDeleteGatewayDialogOpen] = useState(false)
  const [gatewayToDelete, setGatewayToDelete] = useState<Gateway | null>(null)
  const [selectedGateway, setSelectedGateway] = useState<Gateway | null>(null)
  const [gatewayDetailsOpen, setGatewayDetailsOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [toolSearch, setToolSearch] = useState('')
  const [toolFilter, setToolFilter] = useState<'all' | 'assigned' | 'unassigned'>('all')
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')

  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  const { data: gatewaysData, isLoading, isError, error: gatewaysError, refetch: refetchGateways } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: () => gatewaysApi.getAll(),
    enabled: !!currentOrganization,
  })

  const gatewaysExtracted = gatewaysData?.gateways || []
  const gateways = Array.isArray(gatewaysExtracted) ? gatewaysExtracted : []

  // Tool scoping queries
  const { data: gatewayToolsData } = useQuery({
    queryKey: ['gateway-tools', selectedGateway?.id],
    queryFn: () => gatewaysApi.getTools(selectedGateway!.id),
    enabled: !!selectedGateway && gatewayDetailsOpen,
  })

  const { data: allToolsData } = useQuery({
    queryKey: ['all-tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization && gatewayDetailsOpen,
  })

  const gatewayTools = (() => {
    const raw = gatewayToolsData?.gatewayTools || gatewayToolsData?.tools || []
    return Array.isArray(raw) ? raw : []
  })()
  const allTools = (() => {
    const raw = allToolsData?.tools || []
    return Array.isArray(raw) ? raw : []
  })()

  // Determine which tools are assigned (map gatewayTool.toolId to tool data)
  const assignedToolIds = new Set(gatewayTools.map((gt: any) => gt.toolId || gt.id))

  const assignToolMutation = useMutation({
    mutationFn: (toolId: string) => gatewaysApi.assignTool(selectedGateway!.id, toolId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-tools', selectedGateway?.id] })
      queryClient.invalidateQueries({ queryKey: ['gateways'] })
    },
    onError: () => errorNotif('Failed to assign tool'),
  })

  const removeToolMutation = useMutation({
    mutationFn: (toolId: string) => gatewaysApi.removeTool(selectedGateway!.id, toolId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['gateway-tools', selectedGateway?.id] })
      queryClient.invalidateQueries({ queryKey: ['gateways'] })
    },
    onError: () => errorNotif('Failed to remove tool'),
  })

  const filteredGateways = filterByTeamVisibility(gateways as any[], teamFilter).filter((gateway: Gateway) => {
    const matchesSearch =
      gateway.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (gateway.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      gateway.endpoint.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesType = typeFilter === 'all' || gateway.type === typeFilter
    const matchesStatus = statusFilter === 'all' || gateway.status === statusFilter

    return matchesSearch && matchesType && matchesStatus
  })


  // Form setup
  const createForm = useForm<CreateGatewayForm>({
    resolver: zodResolver(createGatewaySchema),
    defaultValues: {
      name: '',
      type: '',
      endpoint: '',
      description: '',
    }
  })

  // Handler function for gateway creation (extracted for clean state management)
  const handleCreateGateway = (data: CreateGatewayForm & { kind?: string; agentId?: string }) => {
    // Ensure endpoint starts with /
    const endpoint = data.endpoint.startsWith('/') ? data.endpoint : '/' + data.endpoint

    // Set default configuration based on gateway type
    let configuration: Record<string, any> = {}
    if (data.type === 'mcp') {
      configuration = { transport: 'http' }
    } else if (data.type === 'a2a') {
      configuration = { agentCapabilities: {} }
    } else if (data.type === 'acp') {
      configuration = { agentCapabilities: {} }
    } else if (data.type === 'utcp') {
      configuration = { protocol: 'http' }
    } else if (data.type === 'skills') {
      configuration = { format: 'skill-md' }
    }

    const payload: Record<string, any> = {
      ...data,
      endpoint,
      configuration,
    }

    // Pass kind (defaults to 'tool' for backwards compat)
    if (data.kind) {
      payload.kind = data.kind
    }
    if (data.agentId) {
      payload.agentId = data.agentId
    }

    createGatewayMutation.mutate(payload)
  }

  // Create gateway mutation
  const createGatewayMutation = useMutation({
    mutationFn: async (payload: Record<string, any>) => {
      return await gatewaysApi.create(payload)
    },
    onSuccess: async (result) => {
      // Show success message first
      success('Success', result?.message || 'Gateway created successfully')

      // Invalidate and refetch gateway queries - wait for completion
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })

      // Wait a moment for the refetch to complete and UI to update
      await new Promise(resolve => setTimeout(resolve, 500))

      // CRITICAL: Reset form BEFORE closing to clear all state
      createForm.reset()
      setCreateDialogOpen(false)
    },
    onError: (err: Error & { response?: { data?: { message?: string } }; message?: string }) => {
      errorNotif('Error', err?.response?.data?.message || err?.message || 'Failed to create gateway')
    }
  })

  // Delete gateway mutation
  const deleteGatewayMutation = useMutation({
    mutationFn: async (gatewayId: string) => {
      return await gatewaysApi.delete(gatewayId)
    },
    onSuccess: async () => {
      success('Gateway deleted', 'Gateway has been deleted successfully.')
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      setDeleteGatewayDialogOpen(false)
      setGatewayToDelete(null)
    },
    onError: (err: Error & { response?: { data?: { message?: string } } }) => {
      errorNotif('Failed to delete gateway', err.response?.data?.message || 'Please try again.')
    }
  })

  // Gateway columns for DataTable
  const gatewayColumns: ColumnDef<Gateway>[] = [
    {
      ...createSortableColumn('name', 'Gateway'),
      cell: ({ row }) => {
        const gateway = row.original
        return (
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Router className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-base">{gateway.name}</h3>
                <VisibilityBadge
                  visibility={(gateway as any).visibility}
                  teamId={(gateway as any).teamId}
                  teamLookup={teamLookup}
                />
              </div>
              <div className="text-sm text-muted-foreground">{gateway.description || 'API Gateway'}</div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'type',
      header: 'Type',
      cell: ({ row }) => {
        const gateway = row.original
        const type = gateway.type
        return (
          <div className="flex items-center gap-1.5">
            <ProtocolBadge protocol={type || 'mcp'} />
            {gateway.kind === 'agent' && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">Agent</Badge>
            )}
            {gateway.isSystem && (
              <Badge className="text-[10px] px-1.5 py-0 border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">System</Badge>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'endpoint',
      header: 'Endpoint',
      cell: ({ row }) => (
        <code className="bg-muted px-2 py-1 rounded text-sm">
          {row.original.endpoint}
        </code>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const status = row.original.status
        return (
          <Badge variant={status === 'active' ? 'success' : 'secondary'}>
            {status === 'active' ? 'Active' : status}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'tools',
      header: 'Tools',
      cell: ({ row }) => {
        const gateway = row.original
        if (gateway.isSystem) {
          return (
            <div className="text-sm">
              <span className="text-muted-foreground">Built-in tools</span>
            </div>
          )
        }
        const toolCount = gateway.tools?.length || 0
        return (
          <div className="text-center text-sm">
            <span className="font-medium">{toolCount}</span>{' '}
            <span className="text-muted-foreground">tools</span>
          </div>
        )
      },
    },
    {
      accessorKey: 'totalRequests',
      header: 'Requests',
      cell: ({ row }) => {
        const total = row.original.totalRequests || 0
        const ok = row.original.successfulRequests || 0
        return (
          <div className="text-sm">
            {total > 0
              ? <><span className="font-medium">{total}</span> <span className="text-muted-foreground">({ok} ok)</span></>
              : <span className="text-muted-foreground">0 requests</span>
            }
          </div>
        )
      },
    },
    createActionsColumn<Gateway>(
      (gateway) => {
        setSelectedGateway(gateway)
        setGatewayDetailsOpen(true)
      },
      (gateway) => {
        if (gateway.isSystem) return
        setGatewayToDelete(gateway)
        setDeleteGatewayDialogOpen(true)
      },
      [
        {
          label: 'View Details',
          onClick: (gateway) => navigate(`/gateways/${gateway.id}`),
        },
        {
          label: 'Copy Full URL',
          onClick: async (gateway) => {
            const backendUrl = import.meta.env.VITE_API_BASE_URL || window.location.origin
            const simpleSlug = currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
            const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
            const fullEndpoint = `${backendUrl}/${simpleSlug}/${gwSlug}`
            try {
              await navigator.clipboard.writeText(fullEndpoint)
              success('Copied!', 'Full endpoint URL copied to clipboard')
            } catch (err) {
              errorNotif('Failed to copy', 'Could not copy endpoint to clipboard')
            }
          },
        },
      ]
    ),
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">Gateways</h1>
          <p className="text-muted-foreground">
            {isLoading ? <span className="inline-block w-48 h-4 bg-muted animate-pulse rounded" /> : `${gateways.length} gateways (${gateways.filter((g: Gateway) => g.status === 'active').length} active) \u00B7 ${gateways.filter((g: Gateway) => !g.isSystem).reduce((sum: number, g: Gateway) => sum + (g.tools?.length || 0), 0)} tool assignments`}
          </p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} disabled={!currentOrganization}>
          <Plus className="h-4 w-4 mr-2" />
          Create Gateway
        </Button>
      </div>

      {!currentOrganization ? (
        <div className="flex items-center justify-center h-96">
          <div className="text-center">
            <p className="text-muted-foreground">No organization selected. Please select or create an organization.</p>
          </div>
        </div>
      ) : isError ? (
        <QueryError error={gatewaysError} onRetry={() => refetchGateways()} title="Couldn't load gateways" />
      ) : (
        <>

      {/* Gateways Table */}
      {!isLoading && gateways.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Zap}
              title="No gateways yet"
              description="Gateways expose your tools and agents via MCP, UTCP, Agent Skills, A2A, ACP, and more. Create one to give Claude, Cursor, or any MCP-compatible client access to your tools."
              action={
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Gateway
                </Button>
              }
              className="py-16"
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-4">
            {/* Filters */}
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search gateways..."
                    className="pl-10"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="mcp">MCP</SelectItem>
                  <SelectItem value="a2a">A2A</SelectItem>
                  <SelectItem value="acp">ACP</SelectItem>
                  <SelectItem value="utcp">UTCP</SelectItem>
                  <SelectItem value="skills">Skills</SelectItem>
                  <SelectItem value="openai_chat">OpenAI Chat</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="discord">Discord</SelectItem>
                  <SelectItem value="telegram">Telegram</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="chat_widget">Chat Widget</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
              <TeamFilter
                organizationId={currentOrganization?.id}
                value={teamFilter}
                onChange={setTeamFilter}
              />
            </div>

            <DataTable
              columns={gatewayColumns}
              data={filteredGateways}
              loading={isLoading}
              onRowClick={(gateway) => navigate(`/gateways/${gateway.id}`)}
              hideSelectionCount
              hideColumnsButton
              hidePaginationWhenSinglePage
            />
          </CardContent>
        </Card>
      )}

      </>
      )}

      {/* Create Gateway Dialog */}
      <CreateGatewayDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        createForm={createForm}
        onSubmit={handleCreateGateway}
        createGatewayMutation={createGatewayMutation}
      />


      {/* Delete Gateway Confirmation Dialog */}
      <AlertDialog open={deleteGatewayDialogOpen} onOpenChange={setDeleteGatewayDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete gateway?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{gatewayToDelete?.name}". This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (gatewayToDelete) {
                  deleteGatewayMutation.mutate(gatewayToDelete.id)
                }
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete Gateway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Gateway Details Sheet */}
      <GatewayDetailsSheet
        open={gatewayDetailsOpen}
        onOpenChange={setGatewayDetailsOpen}
        selectedGateway={selectedGateway}
        allTools={allTools}
        assignedToolIds={assignedToolIds}
        assignToolMutation={assignToolMutation}
        removeToolMutation={removeToolMutation}
        toolSearch={toolSearch}
        onToolSearchChange={setToolSearch}
        toolFilter={toolFilter}
        onToolFilterChange={setToolFilter}
      />
    </div>
  )
}
