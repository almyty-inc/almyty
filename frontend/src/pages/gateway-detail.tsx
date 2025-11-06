import React, { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Router, Copy, Zap } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

import { gatewaysApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'

export function GatewayDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()

  const [removeAllToolsDialogOpen, setRemoveAllToolsDialogOpen] = useState(false)

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

  const gatewayToolsRaw = gatewayToolsData?.data?.data?.gatewayTools || gatewayToolsData?.data?.data?.tools || gatewayToolsData?.data?.data || []
  const gatewayTools = Array.isArray(gatewayToolsRaw) ? gatewayToolsRaw : []

  const allToolsRaw = allToolsData?.data?.data?.tools || allToolsData?.data?.data || []
  const allTools = Array.isArray(allToolsRaw) ? allToolsRaw : []

  const applyScopingPreset = (preset: 'read-only' | 'admin' | 'public' | 'all' | 'none') => {
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
      case 'none':
        toolsToAssign = []
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

  if (!gatewayData?.data) {
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

  const gateway = gatewayData.data

  return (
    <div className="space-y-8">
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
              <h1 className="text-3xl font-bold tracking-tight">{gateway.name}</h1>
              <p className="text-muted-foreground">{gateway.description || 'API Gateway'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Badge variant={gateway.status === 'active' ? 'default' : 'secondary'}>
            {gateway.status}
          </Badge>
          <Badge variant="outline">
            {gateway.type?.toUpperCase()}
          </Badge>
        </div>
      </div>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Assigned Tools</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{gatewayTools.length}</div>
            <p className="text-xs text-muted-foreground">of {allTools.length} available</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Total Requests</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{gateway.totalRequests || 0}</div>
            <p className="text-xs text-muted-foreground">{gateway.successfulRequests || 0} successful</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Endpoint</CardTitle>
          </CardHeader>
          <CardContent>
            <code className="text-sm bg-muted px-2 py-1 rounded">{gateway.endpoint}</code>
            <Button
              size="sm"
              variant="ghost"
              className="ml-2"
              onClick={async () => {
                const endpoint = `${window.location.origin}${gateway.endpoint}`
                try {
                  await navigator.clipboard.writeText(endpoint)
                  success('Copied!', 'Gateway endpoint copied to clipboard')
                } catch (err) {
                  errorNotif('Failed to copy', 'Could not copy endpoint to clipboard')
                }
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Main Content */}
      <Tabs defaultValue="tools" className="space-y-4">
        <TabsList>
          <TabsTrigger value="tools">Tool Scoping</TabsTrigger>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="tools" className="space-y-6">
          {/* Scoping Status */}
          <Card>
            <CardHeader>
              <CardTitle>Scoping Status</CardTitle>
              <CardDescription>
                {gatewayTools.length === 0 && 'No tools assigned - gateway will block all requests'}
                {gatewayTools.length > 0 && gatewayTools.length < allTools.length && `Scoped to ${gatewayTools.length} of ${allTools.length} tools`}
                {gatewayTools.length > 0 && gatewayTools.length === allTools.length && 'Full access to all tools'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('read-only')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Read Only
                </Button>
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('admin')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Admin Tools
                </Button>
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('public')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Public API
                </Button>
                <Button
                  variant="outline"
                  onClick={() => applyScopingPreset('all')}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  All Tools
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setRemoveAllToolsDialogOpen(true)}
                  disabled={bulkAssignToolsMutation.isPending}
                >
                  Remove All
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Available Tools */}
          {isLoadingGatewayTools || isLoadingAllTools ? (
            <div className="flex items-center justify-center h-64">
              <LoadingSpinner size="lg" />
            </div>
          ) : allTools.length === 0 ? (
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
                  <Card key={tool.id}>
                    <CardContent className="flex items-center justify-between p-4">
                      <div className="flex-1">
                        <div className="font-medium">{tool.name}</div>
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
                        onClick={() => {
                          if (isAssigned) {
                            removeToolMutation.mutate({ toolId: tool.id })
                          } else {
                            assignToolMutation.mutate({ toolId: tool.id })
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
        </TabsContent>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Gateway Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Type</span>
                <Badge>{gateway.type?.toUpperCase()}</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Endpoint</span>
                <code className="bg-muted px-2 py-1 rounded text-sm">{gateway.endpoint}</code>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant={gateway.status === 'active' ? 'default' : 'secondary'}>
                  {gateway.status}
                </Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Description</span>
                <span className="text-sm">{gateway.description || 'No description'}</span>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

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
      </Tabs>

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
    </div>
  )
}
