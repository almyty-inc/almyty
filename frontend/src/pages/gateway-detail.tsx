import React, { useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Info, Router, Settings, Shield, ChevronRight } from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

import { gatewaysApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'

import {
  EditGatewayDialog,
  type EditGatewayForm,
} from '@/components/gateways/detail/edit-gateway-dialog'
import { GatewayAuthSection } from '@/components/gateways/detail/gateway-auth-section'
import { GatewayConfigurationCard } from '@/components/gateways/detail/gateway-configuration-card'
import { IntegrationsSection } from '@/components/gateways/detail/integrations-section'
import { SecurityPolicyForm } from '@/components/gateways/detail/security-policy-form'
import {
  GatewayToolsTab,
  type ScopingPreset,
  type SecurityTarget,
} from '@/components/gateways/detail/tools-tab'
import { GatewayEventsTab } from '@/components/gateways/detail/events-tab'
import {
  ChannelConfigForm,
  isChannelType,
} from '@/components/gateways/detail/channel-config-form'

export function GatewayDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()

  const [removeAllToolsDialogOpen, setRemoveAllToolsDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [securityDialogOpen, setSecurityDialogOpen] = useState(false)
  const [securityTarget, setSecurityTarget] = useState<SecurityTarget | null>(null)

  const { data: gatewayData, isLoading } = useQuery({
    queryKey: ['gateway', id],
    queryFn: () => gatewaysApi.getById(id!),
    enabled: !!id,
  })

  const { data: gatewayToolsData, isLoading: isLoadingGatewayTools } = useQuery({
    queryKey: ['gateway-tools', id],
    queryFn: () => gatewaysApi.getTools(id!),
    enabled: !!id,
  })

  const { data: allToolsData, isLoading: isLoadingAllTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const assignToolMutation = useMutation({
    mutationFn: ({ toolId }: { toolId: string }) =>
      gatewaysApi.assignTool(id!, toolId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tool assigned', 'Tool has been assigned to the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tool', err.response?.data?.message || 'Please try again.')
    },
  })

  const removeToolMutation = useMutation({
    mutationFn: ({ toolId }: { toolId: string }) =>
      gatewaysApi.removeTool(id!, toolId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tool removed', 'Tool has been removed from the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove tool', err.response?.data?.message || 'Please try again.')
    },
  })

  const bulkAssignToolsMutation = useMutation({
    mutationFn: ({ toolIds }: { toolIds: string[] }) =>
      gatewaysApi.bulkAssignTools(id!, toolIds),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Tools assigned', 'Tools have been assigned to the gateway successfully.')
    },
    onError: (err: any) => {
      errorNotif('Failed to assign tools', err.response?.data?.message || 'Please try again.')
    },
  })

  const removeAllToolsMutation = useMutation({
    mutationFn: () => gatewaysApi.removeAllTools(id!),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('All tools removed', 'All tools have been removed from the gateway.')
    },
    onError: (err: any) => {
      errorNotif('Failed to remove tools', err.response?.data?.message || 'Please try again.')
    },
  })

  const gateway = gatewayData

  // Edit gateway mutation
  const editGatewayMutation = useMutation({
    mutationFn: (data: EditGatewayForm) => gatewaysApi.update(id!, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      success('Gateway updated', 'Gateway has been updated successfully.')
      setEditDialogOpen(false)
    },
    onError: (err: any) => {
      errorNotif('Failed to update gateway', err.response?.data?.message || 'Please try again.')
    },
  })

  // Channel-config mutation: PATCHes only the configuration object.
  // Used by the per-channel-type credential form.
  const updateChannelConfigMutation = useMutation({
    mutationFn: (configuration: Record<string, any>) =>
      gatewaysApi.update(id!, { configuration }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', id] })
      success('Channel configuration saved', 'Credentials have been encrypted and stored.')
    },
    onError: (err: any) => {
      errorNotif('Failed to save channel config', err.response?.data?.message || 'Please try again.')
    },
  })

  const updateToolConfigMutation = useMutation({
    mutationFn: ({ gatewayToolId, data }: { gatewayToolId: string; data: any }) =>
      gatewaysApi.updateToolConfig(id!, gatewayToolId, data),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway-tools', id] })
      success('Security policy updated', 'Tool security policy has been saved.')
      setSecurityDialogOpen(false)
      setSecurityTarget(null)
    },
    onError: (err: any) => {
      errorNotif('Failed to update security policy', err.response?.data?.message || 'Please try again.')
    },
  })

  const gatewayToolsRaw = gatewayToolsData?.gatewayTools || gatewayToolsData?.tools || gatewayToolsData || []
  const gatewayTools = Array.isArray(gatewayToolsRaw) ? gatewayToolsRaw : []

  const allToolsRaw = allToolsData?.tools || allToolsData || []
  const allTools = Array.isArray(allToolsRaw) ? allToolsRaw : []

  const applyScopingPreset = (preset: ScopingPreset) => {
    // Special case: 'none' should remove all tools
    if (preset === 'none') {
      removeAllToolsMutation.mutate()
      return
    }

    let toolsToAssign: string[] = []

    switch (preset) {
      case 'read-only':
        toolsToAssign = allTools
          .filter((tool: any) => tool.method === 'GET' || tool.name?.toLowerCase().includes('get'))
          .map((tool: any) => tool.id)
        break
      case 'admin':
        toolsToAssign = allTools
          .filter((tool: any) =>
            tool.name?.toLowerCase().includes('admin') ||
            tool.name?.toLowerCase().includes('delete') ||
            tool.name?.toLowerCase().includes('update')
          )
          .map((tool: any) => tool.id)
        break
      case 'public':
        toolsToAssign = allTools
          .filter((tool: any) =>
            !tool.name?.toLowerCase().includes('delete') &&
            !tool.name?.toLowerCase().includes('admin')
          )
          .map((tool: any) => tool.id)
        break
      case 'all':
        toolsToAssign = allTools.map((tool: any) => tool.id)
        break
    }

    bulkAssignToolsMutation.mutate({ toolIds: toolsToAssign })
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!gatewayData) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-muted-foreground">Gateway not found</p>
          <Button className="mt-4" onClick={() => navigate('/gateways')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Gateways
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/gateways" className="hover:text-foreground">Gateways</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{gateway.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/gateways')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <Router className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-4xl font-heading font-extrabold tracking-tight">{gateway.name}</h1>
              <p className="text-muted-foreground">{gateway.description || 'API Gateway'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(true)}>
            <Settings className="h-4 w-4 mr-2" />
            Edit Gateway
          </Button>
          <Badge variant={gateway.status === 'active' ? 'success' : 'secondary'}>
            {gateway.status === 'active' ? 'Active' : gateway.status}
          </Badge>
          <Badge variant="outline">
            {gateway.type?.toUpperCase()}
          </Badge>
          {gateway.isSystem && (
            <Badge className="border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">System</Badge>
          )}
        </div>
      </div>

      {/* System gateway banner */}
      {gateway.isSystem && (
        <div className="flex items-start gap-3 rounded-lg border border-violet-200 bg-violet-50 p-4 dark:border-violet-800 dark:bg-violet-950/30">
          <Info className="h-5 w-5 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium text-violet-900 dark:text-violet-200">This is a system gateway</p>
            <p className="text-sm text-violet-700 dark:text-violet-400">
              It provides almyty platform management tools. The endpoint, tools, and deletion are managed automatically.
            </p>
          </div>
        </div>
      )}

      {/* Gateway Configuration — type-specific */}
      <GatewayConfigurationCard
        gateway={gateway}
        orgSlug={currentOrganization?.slug || currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'}
        onCopySuccess={success}
        onCopyError={errorNotif}
      />

      {/* Channel-type credential form (per-adapter token / webhook / OAuth fields) */}
      {isChannelType(gateway.type) && (
        <ChannelConfigForm
          gateway={gateway}
          type={gateway.type}
          isSaving={updateChannelConfigMutation.isPending}
          onSave={async (cfg) => {
            await updateChannelConfigMutation.mutateAsync(cfg)
          }}
          onTestConnection={async () => {
            const res: any = await gatewaysApi.testChannelConnection(gateway.id)
            // backend returns { success, data: { ok, detail } }; apiPost
            // already unwraps `data` so we usually get { ok, detail }
            // directly, but tolerate both shapes here.
            const data = res?.data ?? res
            return { ok: !!data?.ok, detail: data?.detail || '' }
          }}
        />
      )}

      {/* Authentication */}
      {gateway.type !== 'skills' && (
        <GatewayAuthSection gatewayId={gateway.id} gatewayName={gateway.name} />
      )}

      {/* Main Content */}
      <Tabs defaultValue={gateway.isSystem ? 'metrics' : 'tools'} className="space-y-4">
        <TabsList>
          {!gateway.isSystem && (
            <TabsTrigger value="tools">Tool Scoping ({gatewayTools.length}/{allTools.length})</TabsTrigger>
          )}
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
        </TabsList>

        {!gateway.isSystem && (
        <TabsContent value="tools" className="space-y-6">
          <GatewayToolsTab
            gatewayTools={gatewayTools}
            allTools={allTools}
            isLoadingGatewayTools={isLoadingGatewayTools}
            isLoadingAllTools={isLoadingAllTools}
            bulkAssignPending={bulkAssignToolsMutation.isPending}
            assignPending={assignToolMutation.isPending}
            removePending={removeToolMutation.isPending}
            onApplyPreset={applyScopingPreset}
            onRequestRemoveAll={() => setRemoveAllToolsDialogOpen(true)}
            onAssign={(toolId) => assignToolMutation.mutate({ toolId })}
            onRemove={(toolId) => removeToolMutation.mutate({ toolId })}
            onOpenSecurity={(target) => {
              setSecurityTarget(target)
              setSecurityDialogOpen(true)
            }}
          />
        </TabsContent>
        )}

        <TabsContent value="metrics" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Performance Metrics</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-2xl font-bold">{gateway.totalRequests || 0}</div>
                    <div className="text-sm text-muted-foreground">Total Requests</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-green-600">
                      {gateway.successfulRequests || 0}
                    </div>
                    <div className="text-sm text-muted-foreground">Successful</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold text-red-600">
                      {gateway.failedRequests || 0}
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

        <TabsContent value="integrations" className="space-y-6">
          <IntegrationsSection gatewayId={id!} gateway={gateway} orgSlug={currentOrganization?.slug || currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'} />
        </TabsContent>

        <TabsContent value="events" className="space-y-4">
          <GatewayEventsTab gatewayId={id!} />
        </TabsContent>
      </Tabs>

      {/* Edit Gateway Dialog */}
      <EditGatewayDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        gateway={gateway}
        isSaving={editGatewayMutation.isPending}
        onSubmit={(data) => editGatewayMutation.mutate(data)}
        isSystem={gateway.isSystem}
      />

      {/* Remove All Tools Confirmation */}
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

      {/* Security Policy Dialog */}
      <Dialog open={securityDialogOpen} onOpenChange={(open) => { setSecurityDialogOpen(open); if (!open) setSecurityTarget(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              Security Policy: {securityTarget?.toolName}
            </DialogTitle>
            <DialogDescription>
              Configure security constraints for this tool in the gateway.
            </DialogDescription>
          </DialogHeader>
          {securityTarget && (
            <SecurityPolicyForm
              initialPolicy={securityTarget.policy}
              onSave={(policy) => {
                updateToolConfigMutation.mutate({
                  gatewayToolId: securityTarget.gatewayToolId,
                  data: { securityPolicy: policy },
                })
              }}
              isSaving={updateToolConfigMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
