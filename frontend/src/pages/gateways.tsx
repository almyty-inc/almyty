import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Router, Plus, Settings, Zap, MoreVertical, Eye, Edit2, Trash2, Activity, Copy } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

import { gatewaysApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'

// Form Schema
const createGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  type: z.string().min(1, 'Type is required'),
  endpoint: z.string().min(1, 'Endpoint path is required').regex(/^\/[a-zA-Z0-9-_/]*$/, 'Must start with / and contain only alphanumeric, -, _, /'),
  description: z.string().optional(),
})

type CreateGatewayForm = z.infer<typeof createGatewaySchema>

export function GatewaysPage() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [gatewayDetailsOpen, setGatewayDetailsOpen] = useState(false)
  const [selectedGateway, setSelectedGateway] = useState<any | null>(null)
  const [removeAllToolsDialogOpen, setRemoveAllToolsDialogOpen] = useState(false)
  const [deleteGatewayDialogOpen, setDeleteGatewayDialogOpen] = useState(false)
  const [gatewayToDelete, setGatewayToDelete] = useState<any | null>(null)

  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()

  const { data: gatewaysData, isLoading } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: () => gatewaysApi.getAll(),
    enabled: !!currentOrganization,
  })

  const gateways = gatewaysData?.data?.data?.gateways || gatewaysData?.data?.data || []

  // Gateway tools queries
  const { data: gatewayToolsData, isLoading: isLoadingGatewayTools } = useQuery({
    queryKey: ['gateway-tools', selectedGateway?.id],
    queryFn: async () => {
      if (!selectedGateway) return null
      return await gatewaysApi.getTools(selectedGateway.id)
    },
    enabled: !!selectedGateway && gatewayDetailsOpen,
  })

  const { data: allToolsData, isLoading: isLoadingAllTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  // Safely extract tools arrays with proper null checking
  // Backend returns 'gatewayTools' field (not 'tools')
  const gatewayToolsRaw = gatewayToolsData?.data?.data?.gatewayTools || gatewayToolsData?.data?.data?.tools || gatewayToolsData?.data?.data || []
  const gatewayTools = Array.isArray(gatewayToolsRaw) ? gatewayToolsRaw : []

  const allToolsRaw = allToolsData?.data?.data?.tools || allToolsData?.data?.data || []
  const allTools = Array.isArray(allToolsRaw) ? allToolsRaw : []

  // Tool assignment mutations
  const assignToolMutation = useMutation({
    mutationFn: ({ gatewayId, toolId }: { gatewayId: string; toolId: string }) =>
      gatewaysApi.assignTool(gatewayId, toolId),
    onSuccess: async (data, variables) => {
      // Invalidate with immediate refetch for active queries
      await queryClient.invalidateQueries({
        queryKey: ['gateway-tools', variables.gatewayId],
        refetchType: 'active'
      })
      await queryClient.invalidateQueries({ queryKey: ['gateways'], refetchType: 'active' })
      await queryClient.invalidateQueries({ queryKey: ['tools'], refetchType: 'active' })

      success('Tool assigned', 'Tool has been assigned to the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tool', err.response?.data?.message || 'Please try again.')
    },
  })

  const removeToolMutation = useMutation({
    mutationFn: ({ gatewayId, toolId }: { gatewayId: string; toolId: string }) =>
      gatewaysApi.removeTool(gatewayId, toolId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools'] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      await queryClient.invalidateQueries({ queryKey: ['available-tools'] })
      success('Tool removed', 'Tool has been removed from the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove tool', err.response?.data?.message || 'Please try again.')
    },
  })

  const bulkAssignToolsMutation = useMutation({
    mutationFn: ({ gatewayId, toolIds }: { gatewayId: string; toolIds: string[] }) =>
      gatewaysApi.bulkAssignTools(gatewayId, toolIds),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools'] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      await queryClient.invalidateQueries({ queryKey: ['available-tools'] })
      success('Tools assigned', 'Tools have been assigned to the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tools', err.response?.data?.message || 'Please try again.')
    },
  })

  // Scoping preset handlers
  const applyScopingPreset = (preset: 'read-only' | 'admin' | 'public' | 'all' | 'none') => {
    if (!selectedGateway) return

    let toolsToAssign: string[] = []

    switch (preset) {
      case 'read-only':
        // Assign only GET/read operations
        toolsToAssign = allTools
          .filter((tool: any) => tool.method === 'GET' || tool.name?.toLowerCase().includes('get'))
          .map((tool: any) => tool.id)
        break
      case 'admin':
        // Assign admin/management tools
        toolsToAssign = allTools
          .filter((tool: any) =>
            tool.name?.toLowerCase().includes('admin') ||
            tool.name?.toLowerCase().includes('delete') ||
            tool.name?.toLowerCase().includes('update')
          )
          .map((tool: any) => tool.id)
        break
      case 'public':
        // Assign public/safe operations
        toolsToAssign = allTools
          .filter((tool: any) =>
            !tool.name?.toLowerCase().includes('delete') &&
            !tool.name?.toLowerCase().includes('admin')
          )
          .map((tool: any) => tool.id)
        break
      case 'all':
        // Assign all tools
        toolsToAssign = allTools.map((tool: any) => tool.id)
        break
      case 'none':
        // Remove all tools by passing empty array
        toolsToAssign = []
        break
    }

    // Always call bulk assign - even with empty array to clear all tools
    bulkAssignToolsMutation.mutate({
      gatewayId: selectedGateway.id,
      toolIds: toolsToAssign
    })
  }

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
  const handleCreateGateway = (data: CreateGatewayForm) => {
    // Ensure endpoint starts with /
    const endpoint = data.endpoint.startsWith('/') ? data.endpoint : '/' + data.endpoint

    // Set default configuration based on gateway type
    let configuration: Record<string, any> = {}
    if (data.type === 'mcp') {
      configuration = { transport: 'http' }
    } else if (data.type === 'a2a') {
      configuration = { agentCapabilities: {} }
    } else if (data.type === 'utcp') {
      configuration = { protocol: 'http' }
    }

    const payload = {
      ...data,
      endpoint,
      configuration
    }

    createGatewayMutation.mutate(payload)
  }

  // Create gateway mutation
  const createGatewayMutation = useMutation({
    mutationFn: async (payload: any) => {
      const response = await gatewaysApi.create(payload)
      return response.data
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
    onError: (err: any) => {
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
    onError: (err: any) => {
      errorNotif('Failed to delete gateway', err.response?.data?.message || 'Please try again.')
    }
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Gateways</h1>
          <p className="text-muted-foreground">
            Manage API gateways and tool compositions. Scoping is achieved by selective tool assignment.
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
      ) : isLoading ? (
        <div className="flex items-center justify-center h-96">
          <LoadingSpinner size="lg" />
        </div>
      ) : (
        <>

      {/* Gateway Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Total Gateways</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{gateways.length}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Active Gateways</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {gateways.filter(g => g.status === 'active').length}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Total Tools</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-blue-600">
              {gateways.reduce((sum, g) => sum + (g.tools?.length || 0), 0)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Gateways List */}
      <div className="space-y-4">
        {gateways.length === 0 ? (
          <Card>
            <CardContent className="text-center py-8">
              <Router className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-medium mb-2">No gateways found</h3>
              <p className="text-muted-foreground mb-4">
                Create gateways to compose and deploy your API tools
              </p>
              <Button onClick={() => setCreateDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create First Gateway
              </Button>
            </CardContent>
          </Card>
        ) : (
          gateways.map((gateway) => (
            <Card key={gateway.id} data-testid={`gateway-card-${gateway.id}`} className="hover:border-primary transition-colors">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3 flex-1">
                    <Router className="h-5 w-5 text-blue-600" />
                    <div
                      onClick={() => {
                        setSelectedGateway(gateway)
                        setGatewayDetailsOpen(true)
                      }}
                      className="cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <CardTitle
                          data-testid={`gateway-name-${gateway.id}`}
                          className="text-base hover:text-primary transition-colors"
                        >
                          {gateway.name}
                        </CardTitle>
                        {/* Scoping status badge - hidden when this gateway's sheet is open to avoid strict mode violations */}
                        {!(gatewayDetailsOpen && selectedGateway?.id === gateway.id) && (gateway.tools?.length || 0) === 0 && allTools.length > 0 && (
                          <Badge variant="outline" className="text-xs">
                            0/{allTools.length}
                          </Badge>
                        )}
                        {!(gatewayDetailsOpen && selectedGateway?.id === gateway.id) && (gateway.tools?.length || 0) > 0 && (gateway.tools?.length || 0) < allTools.length && (
                          <Badge variant="outline" className="text-xs">
                            {gateway.tools?.length}/{allTools.length}
                          </Badge>
                        )}
                        {!(gatewayDetailsOpen && selectedGateway?.id === gateway.id) && (gateway.tools?.length || 0) > 0 && (gateway.tools?.length || 0) === allTools.length && (
                          <Badge variant="default" className="text-xs">
                            {gateway.tools?.length}/{allTools.length}
                          </Badge>
                        )}
                      </div>
                      <CardDescription>
                        {gateway.description || 'API Gateway'}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <Badge variant={gateway.status === 'active' ? 'default' : 'secondary'}>
                      {gateway.status}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Edit gateway"
                      aria-label="Edit gateway"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelectedGateway(gateway)
                        setGatewayDetailsOpen(true)
                      }}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Copy endpoint"
                      aria-label="Copy endpoint"
                      onClick={async (e) => {
                        e.stopPropagation()
                        const endpoint = `${window.location.origin}${gateway.endpoint}`
                        try {
                          await navigator.clipboard.writeText(endpoint)
                          success('Copied!', 'Gateway endpoint copied to clipboard')
                        } catch (err) {
                          errorNotif('Failed to copy', 'Could not copy endpoint to clipboard')
                        }
                      }}
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      title="Delete gateway"
                      aria-label="Delete gateway"
                      onClick={(e) => {
                        e.stopPropagation()
                        setGatewayToDelete(gateway)
                        setDeleteGatewayDialogOpen(true)
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent onClick={() => {
                setSelectedGateway(gateway)
                setGatewayDetailsOpen(true)
              }}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-sm font-medium mb-2">Configuration</h4>
                    <div className="text-sm text-muted-foreground space-y-2">
                      <div className="flex items-center gap-2">
                        <span>Type: {gateway.type}</span>
                        <Badge variant="secondary" className="badge">{gateway.type?.toUpperCase()}</Badge>
                      </div>
                      <div>Endpoint: {gateway.endpoint}</div>
                      <div>Tools: {gateway.tools?.length || 0} of {allTools.length}</div>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-sm font-medium mb-2">Metrics</h4>
                    <div className="text-sm text-muted-foreground">
                      <div>Requests: {gateway.totalRequests || 0}</div>
                      <div>Success: {gateway.successfulRequests || 0}</div>
                      <div>Last Used: {gateway.lastRequestAt || 'Never'}</div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      </>
      )}

      {/* Create Gateway Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={(open) => {
        setCreateDialogOpen(open)
        if (!open) {
          createForm.reset()
        }
      }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create New Gateway</DialogTitle>
            <DialogDescription>
              Create a new gateway to expose your tools via different protocols.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={createForm.handleSubmit(handleCreateGateway)} className="space-y-6">
            <div>
              <Label htmlFor="name">Gateway Name</Label>
              <Input
                id="name"
                placeholder="Enter gateway name"
                {...createForm.register('name')}
              />
              {createForm.formState.errors.name && (
                <p className="text-sm text-red-500 mt-1">
                  {createForm.formState.errors.name.message}
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="type">Gateway Type</Label>
              <Select
                onValueChange={(value) => createForm.setValue('type', value)}
                value={createForm.watch('type')}
              >
                <SelectTrigger id="type" aria-label="Gateway Type">
                  <SelectValue placeholder="Select gateway type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mcp">MCP - Model Context Protocol</SelectItem>
                  <SelectItem value="a2a">A2A - Agent-to-Agent</SelectItem>
                  <SelectItem value="utcp">UTCP - Universal Tool Call Protocol</SelectItem>
                </SelectContent>
              </Select>
              {createForm.formState.errors.type && (
                <p className="text-sm text-red-500 mt-1">
                  {createForm.formState.errors.type.message}
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="endpoint">Endpoint Path</Label>
              <Input
                id="endpoint"
                placeholder="/my-gateway"
                {...createForm.register('endpoint')}
              />
              {createForm.formState.errors.endpoint && (
                <p className="text-sm text-red-500 mt-1">
                  {createForm.formState.errors.endpoint.message}
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="description">Description (Optional)</Label>
              <Textarea
                id="description"
                placeholder="Enter gateway description"
                {...createForm.register('description')}
              />
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={createGatewayMutation.isPending}
              >
                {createGatewayMutation.isPending ? 'Creating...' : 'Create Gateway'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Gateway Details Dialog */}
      <Dialog open={gatewayDetailsOpen} onOpenChange={(open) => {
        setGatewayDetailsOpen(open)
        if (!open) setSelectedGateway(null)
      }}>
        <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Router className="h-5 w-5" />
              {selectedGateway?.name}
              <Badge variant={selectedGateway?.status === 'active' ? 'default' : 'secondary'}>
                {selectedGateway?.status}
              </Badge>
            </DialogTitle>
            <DialogDescription>
              Gateway configuration and tool scoping management
            </DialogDescription>
          </DialogHeader>

          {selectedGateway && (
            <Tabs defaultValue="overview" className="w-full mt-6">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="tools">Tools</TabsTrigger>
                <TabsTrigger value="auth">Authentication</TabsTrigger>
                <TabsTrigger value="metrics">Metrics</TabsTrigger>
              </TabsList>

              {/* Overview Tab */}
              <TabsContent value="overview" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Gateway Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Type</span>
                      <Badge>{selectedGateway.type?.toUpperCase()}</Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Endpoint</span>
                      <code className="bg-muted px-2 py-1 rounded text-sm">{selectedGateway.endpoint}</code>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Status</span>
                      <Badge variant={selectedGateway.status === 'active' ? 'default' : 'secondary'}>
                        {selectedGateway.status}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Description</span>
                      <span className="text-sm">{selectedGateway.description || 'No description'}</span>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Usage Statistics</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Total Requests</span>
                      <span className="font-medium">{selectedGateway.totalRequests || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Successful Requests</span>
                      <span className="font-medium text-green-600">{selectedGateway.successfulRequests || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Failed Requests</span>
                      <span className="font-medium text-red-600">{selectedGateway.failedRequests || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Last Used</span>
                      <span className="text-sm">{selectedGateway.lastRequestAt || 'Never'}</span>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Tools Tab - The Key Component for Scoping */}
              <TabsContent value="tools" className="space-y-6">
                <div>
                  <h3 className="text-lg font-medium">Tool Scoping</h3>
                  <p className="text-sm text-muted-foreground">
                    Control which tools are accessible through this gateway
                  </p>
                </div>

                {isLoadingGatewayTools || isLoadingAllTools ? (
                  <div className="flex items-center justify-center h-64">
                    <LoadingSpinner size="lg" />
                  </div>
                ) : (
                  <>
                    {/* Scoping Status Badges */}
                    <div className="flex gap-2 flex-wrap" data-testid="scoping-status">
                  {gatewayTools.length === 0 && (
                    <Badge variant="outline" className="badge" data-testid="scoping-badge-no-access">
                      0/{allTools.length} No Access
                    </Badge>
                  )}
                  {gatewayTools.length > 0 && gatewayTools.length < allTools.length && (
                    <Badge variant="outline" className="badge" data-testid="scoping-badge-scoped">
                      {gatewayTools.length}/{allTools.length} Scoped
                    </Badge>
                  )}
                  {gatewayTools.length > 0 && gatewayTools.length === allTools.length && (
                    <Badge variant="default" className="badge" data-testid="scoping-badge-full-access">
                      {gatewayTools.length}/{allTools.length} Full Access
                    </Badge>
                  )}
                </div>

                {/* Scoping Presets */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Scoping Presets</CardTitle>
                    <CardDescription>
                      Quick configurations for common use cases
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      <Button
                        variant="outline"
                        onClick={() => applyScopingPreset('read-only')}
                        disabled={bulkAssignToolsMutation.isPending}
                        title="Assign only GET operations and read-only tools"
                      >
                        Read Only Operations
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => applyScopingPreset('admin')}
                        disabled={bulkAssignToolsMutation.isPending}
                        title="Assign admin, delete, and update operations"
                      >
                        Admin Tools Only
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => applyScopingPreset('public')}
                        disabled={bulkAssignToolsMutation.isPending}
                        title="Assign safe operations (excludes delete and admin)"
                      >
                        Public API Tools
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => applyScopingPreset('all')}
                        disabled={bulkAssignToolsMutation.isPending}
                        title="Assign all available tools to this gateway"
                      >
                        Assign All Tools
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setRemoveAllToolsDialogOpen(true)}
                        disabled={bulkAssignToolsMutation.isPending}
                        title="Remove all tools from this gateway"
                      >
                        Remove All Tools
                      </Button>
                    </div>

                    {/* Preset Descriptions */}
                    <div className="text-sm text-muted-foreground space-y-2 mt-4 p-3 bg-muted/50 rounded-md">
                      <p className="font-medium">Common Scoping Presets:</p>
                      <ul className="list-disc list-inside space-y-1 ml-2">
                        <li><strong>Read Only:</strong> Only GET operations - safe for public access</li>
                        <li><strong>Admin Tools:</strong> Includes delete, update, and admin operations</li>
                        <li><strong>Public API:</strong> Excludes destructive operations</li>
                      </ul>
                    </div>
                  </CardContent>
                </Card>

                {/* Scoping Explanation */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">How Scoping Works</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3 text-sm">
                      <div className="flex items-start gap-2">
                        <Badge variant="outline" className="mt-0.5">No Tools</Badge>
                        <p className="text-muted-foreground">
                          <strong>Blocks all requests</strong> - Gateway will reject all incoming requests until tools are assigned
                        </p>
                      </div>
                      <div className="flex items-start gap-2">
                        <Badge variant="outline" className="mt-0.5">Scoped</Badge>
                        <p className="text-muted-foreground">
                          <strong>Scoped gateway allows only assigned tools</strong> - Only the tools you've selected will be accessible through this gateway
                        </p>
                      </div>
                      <div className="flex items-start gap-2">
                        <Badge variant="default" className="mt-0.5">Full Access</Badge>
                        <p className="text-muted-foreground">
                          <strong>Full access provides all tools</strong> - All available tools are accessible through this gateway
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Tool Assignment List */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <h4 className="text-base font-medium">Available Tools</h4>
                    <span className="text-sm text-muted-foreground" data-testid="tools-assigned-count">
                      {gatewayTools.length} of {allTools.length} assigned
                    </span>
                  </div>

                  {allTools.length === 0 ? (
                    <Card>
                      <CardContent className="text-center py-8">
                        <Zap className="h-12 w-12 text-muted-foreground mx-auto mb-2" />
                        <p className="text-muted-foreground">
                          No tools available. Create some tools from your APIs first.
                        </p>
                      </CardContent>
                    </Card>
                  ) : (
                    <div className="space-y-2">
                      {allTools.map((tool: any) => {
                        const isAssigned = gatewayTools.some((gt: any) => gt.id === tool.id || gt.toolId === tool.id)

                        return (
                          <Card key={tool.id} data-testid={`tool-card-${tool.id}`}>
                            <CardContent className="flex items-center justify-between p-4">
                              <div className="flex-1">
                                <div className="font-medium" data-testid={`tool-name-${tool.id}`}>{tool.name}</div>
                                <div className="text-sm text-muted-foreground">
                                  {tool.description || 'No description'}
                                </div>
                                {tool.method && (
                                  <Badge variant="outline" className="mt-1">
                                    {tool.method}
                                  </Badge>
                                )}
                              </div>
                              <Button
                                variant={isAssigned ? 'destructive' : 'default'}
                                size="sm"
                                data-testid={`tool-${isAssigned ? 'remove' : 'assign'}-btn-${tool.id}`}
                                onClick={() => {
                                  if (isAssigned) {
                                    removeToolMutation.mutate({
                                      gatewayId: selectedGateway.id,
                                      toolId: tool.id,
                                    })
                                  } else {
                                    assignToolMutation.mutate({
                                      gatewayId: selectedGateway.id,
                                      toolId: tool.id,
                                    })
                                  }
                                }}
                                disabled={assignToolMutation.isPending || removeToolMutation.isPending}
                              >
                                {isAssigned ? 'Remove' : 'Assign'}
                              </Button>
                            </CardContent>
                          </Card>
                        )
                      })}
                    </div>
                  )}
                </div>
                  </>
                )}
              </TabsContent>

              {/* Authentication Tab */}
              <TabsContent value="auth" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Authentication Settings</CardTitle>
                    <CardDescription>
                      Configure authentication requirements for this gateway
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label>Authentication Type</Label>
                      <Select defaultValue="none">
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No Authentication</SelectItem>
                          <SelectItem value="api-key">API Key</SelectItem>
                          <SelectItem value="bearer">Bearer Token</SelectItem>
                          <SelectItem value="basic">Basic Auth</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Configure authentication for this specific gateway. Each gateway can have its own authentication settings.
                    </p>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Metrics Tab */}
              <TabsContent value="metrics" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Performance Metrics</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-4">
                      <div>
                        <div className="flex justify-between mb-1">
                          <span className="text-sm text-muted-foreground">Success Rate</span>
                          <span className="text-sm font-medium">
                            {selectedGateway.totalRequests > 0
                              ? Math.round((selectedGateway.successfulRequests / selectedGateway.totalRequests) * 100)
                              : 0}%
                          </span>
                        </div>
                        <div className="h-2 bg-secondary rounded-full overflow-hidden">
                          <div
                            className="h-full bg-green-500"
                            style={{
                              width: `${
                                selectedGateway.totalRequests > 0
                                  ? (selectedGateway.successfulRequests / selectedGateway.totalRequests) * 100
                                  : 0
                              }%`,
                            }}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4 pt-2">
                        <div>
                          <div className="text-2xl font-bold">{selectedGateway.totalRequests || 0}</div>
                          <div className="text-sm text-muted-foreground">Total Requests</div>
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-green-600">
                            {selectedGateway.successfulRequests || 0}
                          </div>
                          <div className="text-sm text-muted-foreground">Successful</div>
                        </div>
                        <div>
                          <div className="text-2xl font-bold text-red-600">
                            {selectedGateway.failedRequests || 0}
                          </div>
                          <div className="text-sm text-muted-foreground">Failed</div>
                        </div>
                        <div>
                          <div className="text-2xl font-bold">{gatewayTools.length}</div>
                          <div className="text-sm text-muted-foreground">Assigned Tools</div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* Remove All Tools Confirmation Dialog */}
      <AlertDialog open={removeAllToolsDialogOpen} onOpenChange={setRemoveAllToolsDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove all tools?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all tools from the gateway. The gateway will not be able to serve any requests until tools are assigned again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                applyScopingPreset('none')
                setRemoveAllToolsDialogOpen(false)
              }}
            >
              Remove All Tools
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  )
}
