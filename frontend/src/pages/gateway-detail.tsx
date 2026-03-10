import React, { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { ArrowLeft, Router, Copy, Zap, Edit2, Settings, Download, Terminal, FileCode, BookOpen, Check, Package, Shield } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

import { gatewaysApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'

// Form Schema
const editGatewaySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  endpoint: z.string().min(1, 'Endpoint is required').transform(val => {
    // Auto-add leading slash if missing
    return val.startsWith('/') ? val : `/${val}`;
  }),
  description: z.string().optional(),
  status: z.enum(['active', 'inactive', 'maintenance', 'error']),
})

type EditGatewayForm = z.infer<typeof editGatewaySchema>

function SecurityPolicyForm({ initialPolicy, onSave, isSaving }: {
  initialPolicy: any;
  onSave: (policy: any) => void;
  isSaving: boolean;
}) {
  const [allowedDomains, setAllowedDomains] = useState(initialPolicy?.allowedDomains?.join(', ') || '')
  const [blockedDomains, setBlockedDomains] = useState(initialPolicy?.blockedDomains?.join(', ') || '')
  const [allowedMethods, setAllowedMethods] = useState(initialPolicy?.allowedHttpMethods?.join(', ') || '')
  const [maxResponseSize, setMaxResponseSize] = useState(initialPolicy?.maxResponseSizeBytes?.toString() || '')
  const [requireHttps, setRequireHttps] = useState(initialPolicy?.requireHttps || false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const policy: any = {}
    if (allowedDomains.trim()) policy.allowedDomains = allowedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (blockedDomains.trim()) policy.blockedDomains = blockedDomains.split(',').map((d: string) => d.trim()).filter(Boolean)
    if (allowedMethods.trim()) policy.allowedHttpMethods = allowedMethods.split(',').map((m: string) => m.trim().toUpperCase()).filter(Boolean)
    if (maxResponseSize.trim()) policy.maxResponseSizeBytes = parseInt(maxResponseSize, 10)
    policy.requireHttps = requireHttps
    onSave(Object.keys(policy).length > 1 || requireHttps ? policy : null)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <Label htmlFor="allowed-domains">Allowed Domains</Label>
        <Input
          id="allowed-domains"
          placeholder="api.example.com, cdn.example.com"
          value={allowedDomains}
          onChange={(e) => setAllowedDomains(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated list of allowed target domains. Leave empty to allow all.</p>
      </div>
      <div>
        <Label htmlFor="blocked-domains">Blocked Domains</Label>
        <Input
          id="blocked-domains"
          placeholder="internal.corp, admin.example.com"
          value={blockedDomains}
          onChange={(e) => setBlockedDomains(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated list of blocked domains.</p>
      </div>
      <div>
        <Label htmlFor="allowed-methods">Allowed HTTP Methods</Label>
        <Input
          id="allowed-methods"
          placeholder="GET, POST"
          value={allowedMethods}
          onChange={(e) => setAllowedMethods(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Comma-separated. Leave empty to allow all methods.</p>
      </div>
      <div>
        <Label htmlFor="max-response-size">Max Response Size (bytes)</Label>
        <Input
          id="max-response-size"
          type="number"
          placeholder="10485760"
          value={maxResponseSize}
          onChange={(e) => setMaxResponseSize(e.target.value)}
        />
        <p className="text-xs text-muted-foreground mt-1">Maximum response body size. Default: 10MB.</p>
      </div>
      <div className="flex items-center justify-between">
        <div>
          <Label htmlFor="require-https">Require HTTPS</Label>
          <p className="text-xs text-muted-foreground">Block HTTP requests, enforce HTTPS only</p>
        </div>
        <Switch id="require-https" checked={requireHttps} onCheckedChange={setRequireHttps} />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Policy'}
        </Button>
      </div>
    </form>
  )
}

function IntegrationsSection({ gatewayId, gateway, orgSlug }: { gatewayId: string; gateway: any; orgSlug: string }) {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [cliFormat, setCliFormat] = useState<'bash' | 'node'>('bash')

  const { data: skillsData, isLoading: skillsLoading } = useQuery({
    queryKey: ['gateway-skills', gatewayId],
    queryFn: () => gatewaysApi.getSkills(gatewayId),
  })

  const { data: cliData, isLoading: cliLoading } = useQuery({
    queryKey: ['gateway-cli', gatewayId, cliFormat],
    queryFn: () => gatewaysApi.getCliBundle(gatewayId, cliFormat),
  })

  const { data: sdkData, isLoading: sdkLoading } = useQuery({
    queryKey: ['gateway-sdk', gatewayId],
    queryFn: () => gatewaysApi.getSdk(gatewayId),
  })

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch {}
  }

  const downloadFile = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const backendUrl = window.location.origin.replace(':3002', ':4000')
  const mcpEndpoint = `${backendUrl}/mcp/${orgSlug}${gateway.endpoint}`

  const skillsContent = skillsData?.data?.data || skillsData?.data || ''
  const cliContent = cliData?.data?.data || cliData?.data || ''
  const sdkContent = sdkData?.data?.data || sdkData?.data || ''

  return (
    <div className="space-y-6">
      {/* MCP / npx Setup */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-orange-500" />
            MCP Integration
          </CardTitle>
          <CardDescription>Connect this gateway to AI agents via MCP protocol</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-sm font-medium">MCP Endpoint</Label>
            <div className="flex gap-2 mt-1">
              <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">
                {mcpEndpoint}
              </code>
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(mcpEndpoint, 'mcp-endpoint')}>
                {copiedField === 'mcp-endpoint' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <div>
            <Label className="text-sm font-medium">Claude Code Configuration</Label>
            <pre className="text-xs bg-muted p-3 rounded mt-1 overflow-x-auto font-mono">
{`{
  "mcpServers": {
    "${gateway.name?.toLowerCase().replace(/\\s+/g, '-') || 'gateway'}": {
      "command": "npx",
      "args": ["-y", "@anthropic-ai/mcp-client", "${mcpEndpoint}"],
      "env": { "MCP_AUTH_TOKEN": "<your-jwt-token>" }
    }
  }
}`}
            </pre>
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => copyToClipboard(JSON.stringify({
                mcpServers: {
                  [gateway.name?.toLowerCase().replace(/\s+/g, '-') || 'gateway']: {
                    command: 'npx',
                    args: ['-y', '@anthropic-ai/mcp-client', mcpEndpoint],
                    env: { MCP_AUTH_TOKEN: '<your-jwt-token>' }
                  }
                }
              }, null, 2), 'mcp-config')}
            >
              {copiedField === 'mcp-config' ? <Check className="h-4 w-4 mr-2" /> : <Copy className="h-4 w-4 mr-2" />}
              Copy Config
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Skills Bundle */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-5 w-5 text-purple-500" />
              Skills Bundle
            </CardTitle>
            <CardDescription>YAML + Markdown skill files for all gateway tools</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {skillsLoading ? (
              <div className="flex justify-center py-4"><LoadingSpinner /></div>
            ) : skillsContent ? (
              <>
                <pre className="text-xs bg-muted p-3 rounded max-h-48 overflow-auto font-mono">
                  {typeof skillsContent === 'string' ? skillsContent.slice(0, 500) : JSON.stringify(skillsContent, null, 2).slice(0, 500)}
                  {(typeof skillsContent === 'string' ? skillsContent.length : JSON.stringify(skillsContent).length) > 500 ? '\n...' : ''}
                </pre>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(typeof skillsContent === 'string' ? skillsContent : JSON.stringify(skillsContent, null, 2), 'skills')}>
                    {copiedField === 'skills' ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                    Copy
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => downloadFile(typeof skillsContent === 'string' ? skillsContent : JSON.stringify(skillsContent, null, 2), `${gateway.name}-skills.md`)}>
                    <Download className="h-4 w-4 mr-1" />
                    Download
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground py-4">No skills generated yet. Assign tools first.</p>
            )}
          </CardContent>
        </Card>

        {/* CLI Bundle */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Terminal className="h-5 w-5 text-green-500" />
              CLI Bundle
            </CardTitle>
            <CardDescription>Shell scripts for all gateway tools</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-1 mb-2">
              <Button size="sm" variant={cliFormat === 'bash' ? 'default' : 'outline'} onClick={() => setCliFormat('bash')}>Bash</Button>
              <Button size="sm" variant={cliFormat === 'node' ? 'default' : 'outline'} onClick={() => setCliFormat('node')}>Node</Button>
            </div>
            {cliLoading ? (
              <div className="flex justify-center py-4"><LoadingSpinner /></div>
            ) : cliContent ? (
              <>
                <pre className="text-xs bg-muted p-3 rounded max-h-48 overflow-auto font-mono">
                  {typeof cliContent === 'string' ? cliContent.slice(0, 500) : JSON.stringify(cliContent, null, 2).slice(0, 500)}
                  {(typeof cliContent === 'string' ? cliContent.length : JSON.stringify(cliContent).length) > 500 ? '\n...' : ''}
                </pre>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(typeof cliContent === 'string' ? cliContent : JSON.stringify(cliContent, null, 2), 'cli')}>
                    {copiedField === 'cli' ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                    Copy
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => downloadFile(typeof cliContent === 'string' ? cliContent : JSON.stringify(cliContent, null, 2), `${gateway.name}-cli.${cliFormat === 'bash' ? 'sh' : 'js'}`)}>
                    <Download className="h-4 w-4 mr-1" />
                    Download
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground py-4">No CLI bundle generated yet. Assign tools first.</p>
            )}
          </CardContent>
        </Card>

        {/* TypeScript SDK */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileCode className="h-5 w-5 text-blue-500" />
              TypeScript SDK
            </CardTitle>
            <CardDescription>Typed SDK for programmatic access</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {sdkLoading ? (
              <div className="flex justify-center py-4"><LoadingSpinner /></div>
            ) : sdkContent ? (
              <>
                <pre className="text-xs bg-muted p-3 rounded max-h-48 overflow-auto font-mono">
                  {typeof sdkContent === 'string' ? sdkContent.slice(0, 500) : JSON.stringify(sdkContent, null, 2).slice(0, 500)}
                  {(typeof sdkContent === 'string' ? sdkContent.length : JSON.stringify(sdkContent).length) > 500 ? '\n...' : ''}
                </pre>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => copyToClipboard(typeof sdkContent === 'string' ? sdkContent : JSON.stringify(sdkContent, null, 2), 'sdk')}>
                    {copiedField === 'sdk' ? <Check className="h-4 w-4 mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
                    Copy
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => downloadFile(typeof sdkContent === 'string' ? sdkContent : JSON.stringify(sdkContent, null, 2), `${gateway.name}-sdk.ts`)}>
                    <Download className="h-4 w-4 mr-1" />
                    Download
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground py-4">No SDK generated yet. Assign tools first.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export function GatewayDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()

  const [removeAllToolsDialogOpen, setRemoveAllToolsDialogOpen] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [securityDialogOpen, setSecurityDialogOpen] = useState(false)
  const [securityTarget, setSecurityTarget] = useState<{ gatewayToolId: string; toolName: string; policy: any } | null>(null)

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

  // Edit form setup - must be before early returns
  const gateway = gatewayData?.data?.data || gatewayData?.data
  const editForm = useForm<EditGatewayForm>({
    resolver: zodResolver(editGatewaySchema),
    values: {
      name: gateway?.name || '',
      endpoint: gateway?.endpoint || '',
      description: gateway?.description || '',
      status: gateway?.status || 'active',
    }
  })

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

  const gatewayToolsRaw = gatewayToolsData?.data?.data?.gatewayTools || gatewayToolsData?.data?.data?.tools || gatewayToolsData?.data?.data || []
  const gatewayTools = Array.isArray(gatewayToolsRaw) ? gatewayToolsRaw : []

  const allToolsRaw = allToolsData?.data?.data?.tools || allToolsData?.data?.data || []
  const allTools = Array.isArray(allToolsRaw) ? allToolsRaw : []

  const applyScopingPreset = (preset: 'read-only' | 'admin' | 'public' | 'all' | 'none') => {
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
          <Button variant="outline" size="sm" onClick={() => setEditDialogOpen(true)}>
            <Settings className="h-4 w-4 mr-2" />
            Edit Gateway
          </Button>
          <Badge variant={gateway.status === 'active' ? 'default' : 'secondary'}>
            {gateway.status}
          </Badge>
          <Badge variant="outline">
            {gateway.type?.toUpperCase()}
          </Badge>
        </div>
      </div>

      {/* Gateway Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
          <CardDescription>Gateway endpoint and connection details</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground mb-2">MCP Endpoint URL</p>
              <div className="flex gap-2">
                <code className="text-sm bg-muted px-3 py-2 rounded flex-1 break-all font-mono">
                  {(() => {
                    const backendUrl = window.location.origin.replace(':3002', ':4000')
                    const simpleSlug = currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
                    return `${backendUrl}/mcp/${simpleSlug}${gateway.endpoint}`
                  })()}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const backendUrl = window.location.origin.replace(':3002', ':4000')
                    const simpleSlug = currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
                    const fullEndpoint = `${backendUrl}/mcp/${simpleSlug}${gateway.endpoint}`
                    try {
                      await navigator.clipboard.writeText(fullEndpoint)
                      success('Copied!', 'Full MCP endpoint URL copied to clipboard')
                    } catch (err) {
                      errorNotif('Failed to copy', 'Could not copy endpoint to clipboard')
                    }
                  }}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Path: <code className="bg-muted px-1 py-0.5 rounded text-xs">{gateway.endpoint}</code>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Content */}
      <Tabs defaultValue="tools" className="space-y-4">
        <TabsList>
          <TabsTrigger value="tools">Tool Scoping ({gatewayTools.length}/{allTools.length})</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
        </TabsList>

        <TabsContent value="tools" className="space-y-6">
          {/* Scoping Status */}
          <Card>
            <CardHeader>
              <CardTitle>Tool Scoping</CardTitle>
              <CardDescription>
                Control which tools are available through this gateway. {gatewayTools.length} of {allTools.length} assigned
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
                      <div className="flex gap-2">
                        {isAssigned && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const gt = gatewayTools.find((gt: any) => gt.id === tool.id || gt.toolId === tool.id)
                              setSecurityTarget({
                                gatewayToolId: gt?.gatewayToolId || gt?.id || tool.id,
                                toolName: tool.name,
                                policy: gt?.securityPolicy || null,
                              })
                              setSecurityDialogOpen(true)
                            }}
                          >
                            <Shield className="h-4 w-4" />
                          </Button>
                        )}
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
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
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

        <TabsContent value="integrations" className="space-y-6">
          <IntegrationsSection gatewayId={id!} gateway={gateway} orgSlug={currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'} />
        </TabsContent>
      </Tabs>

      {/* Edit Gateway Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Gateway</DialogTitle>
            <DialogDescription>
              Update gateway settings. Note: only the gateway type (MCP/A2A/UTCP) cannot be changed after creation.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit((data) => editGatewayMutation.mutate(data))} className="space-y-6">
            <div>
              <Label htmlFor="edit-name">Gateway Name</Label>
              <Input
                id="edit-name"
                placeholder="Enter gateway name"
                {...editForm.register('name')}
              />
              {editForm.formState.errors.name && (
                <p className="text-sm text-red-500 mt-1">
                  {editForm.formState.errors.name.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Type: <Badge variant="outline" className="ml-1">{gateway.type?.toUpperCase()}</Badge> (cannot be changed)
              </p>
            </div>

            <div>
              <Label htmlFor="edit-endpoint">Endpoint Path</Label>
              <Input
                id="edit-endpoint"
                placeholder="my-gateway"
                {...editForm.register('endpoint')}
              />
              {editForm.formState.errors.endpoint && (
                <p className="text-sm text-red-500 mt-1">
                  {editForm.formState.errors.endpoint.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                The path for your gateway (slash is added automatically)
              </p>
            </div>

            <div>
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                placeholder="Enter gateway description"
                {...editForm.register('description')}
              />
            </div>

            <div>
              <Label htmlFor="edit-status">Status</Label>
              <Select
                onValueChange={(value) => editForm.setValue('status', value as any)}
                value={editForm.watch('status')}
              >
                <SelectTrigger id="edit-status">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="maintenance">Maintenance</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex justify-end space-x-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={editGatewayMutation.isPending}
              >
                {editGatewayMutation.isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

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
