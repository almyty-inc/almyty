import React, { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Code, Play, Zap, Settings, Download, Terminal, FileCode, BookOpen, Copy, Check, ChevronRight, Globe, Bot, Server } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'

import { CodeBlock } from '@/components/ui/code-block'
import { toolsApi, workspacesApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { GatewayToolAssociation } from '@/types'

export function ToolDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const notifications = useNotifications()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()

  const [executionParameters, setExecutionParameters] = useState<Record<string, string>>({})
  const [executionResult, setExecutionResult] = useState<Record<string, any> | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('')

  const { data: toolData, isLoading, isError, error: toolError, refetch: refetchTool } = useQuery({
    queryKey: ['tool', id],
    queryFn: async () => {
      if (!currentOrganization?.id) throw new Error('No organization selected')
      return await toolsApi.getById(id!, currentOrganization.id)
    },
    enabled: !!id && !!currentOrganization,
  })

  useEffect(() => {
    const name = (toolData as any)?.name
    document.title = name ? `${name} | almyty` : 'Tool | almyty'
    return () => { document.title = 'almyty' }
  }, [toolData])

  const runnerId = (toolData as any)?.runnerConfig?.runnerId as string | undefined
  const requiresWorkspace = !!(toolData as any)?.runnerConfig?.requiresWorkspace
  const workspacesQuery = useQuery({
    queryKey: ['workspaces', { runnerId }],
    queryFn: () => workspacesApi.getAll(),
    enabled: !!runnerId,
    select: (all: any) => {
      const list = Array.isArray(all) ? all : (all?.data ?? [])
      return list.filter((w: any) => w.runnerId === runnerId && w.status === 'active')
    },
  })

  const [sentParameters, setSentParameters] = React.useState<Record<string, string> | null>(null)
  const executeToolMutation = useMutation({
    mutationFn: ({ parameters }: { parameters: Record<string, string> }) => {
      if (!currentOrganization?.id) throw new Error('No organization selected')
      setSentParameters(parameters)
      return toolsApi.execute(id!, { parameters }, currentOrganization.id)
    },
    onSuccess: (response: any) => {
      // API returns { success, data?, error?, message?, metadata? }.
      // A 200 OK with success:false means the executor refused (tool
      // in draft state, parameter validation, rate-limited, etc.).
      // Don't surface that as a green Success toast.
      const ok = response?.success !== false
      setExecutionResult({
        success: ok,
        data: ok ? response : undefined,
        error: ok ? undefined : (response?.error || 'Tool execution failed'),
        message: response?.message,
        fullError: ok ? undefined : response,
      })
      if (ok) {
        notifications.success('Success', 'Tool executed successfully')
      } else {
        notifications.error('Execution failed', response?.error || response?.message || 'Tool execution returned success=false')
      }
    },
    onError: (error: Error & { response?: { data?: Record<string, any>; status?: number }; config?: { url?: string; method?: string } }) => {
      notifications.error('Error', error.message || 'Failed to execute tool')
      setExecutionResult({
        success: false,
        error: error.response?.data?.error || error.message || 'Failed to execute tool',
        message: error.response?.data?.message,
        statusCode: error.response?.status,
        url: error.config?.url,
        method: error.config?.method,
        fullError: error.response?.data,
      })
    },
  })

  const toggleStatusMutation = useMutation({
    mutationFn: ({ status }: { status: string }) =>
      status === 'active'
        ? toolsApi.activate(id!, currentOrganization!.id)
        : toolsApi.deactivate(id!, currentOrganization!.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tool', id] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      notifications.success('Success', 'Tool status updated')
    },
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="flex items-center justify-center h-96">
        <QueryError
          error={toolError}
          onRetry={() => refetchTool()}
          title="Couldn't load tool"
        />
      </div>
    )
  }

  if (!toolData) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-muted-foreground">Tool not found</p>
          <Button className="mt-4" onClick={() => navigate('/tools')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Tools
          </Button>
        </div>
      </div>
    )
  }

  const tool = toolData

  return (
    <div className="space-y-8">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/tools" className="hover:text-foreground">Tools</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{tool.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/tools')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center">
              <Code className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-4xl font-heading font-extrabold tracking-tight">{tool.name}</h1>
              <p className="text-muted-foreground">{tool.description || 'AI-generated tool from API operation'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/tools/${id}/edit`)}>
            <Settings className="h-4 w-4 mr-2" />
            Edit Tool
          </Button>
          <Badge variant={tool.status === 'active' ? 'success' : 'secondary'}>
            {tool.status === 'active' ? 'Active' : tool.status}
          </Badge>
          <Switch
            checked={tool.status === 'active'}
            onCheckedChange={(checked) => {
              toggleStatusMutation.mutate({
                status: checked ? 'active' : 'inactive',
              })
            }}
          />
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="details" className="space-y-4">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          <TabsTrigger value="test">Test Tool</TabsTrigger>
          <TabsTrigger value="exports">Exports</TabsTrigger>
          <TabsTrigger value="gateways">Gateways ({tool.gatewayAssociations?.length || 0})</TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="details">
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Parameters</CardTitle>
              </CardHeader>
          <CardContent>
            {tool.parameters?.properties && Object.keys(tool.parameters.properties).length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground mb-3">
                  {Object.keys(tool.parameters.properties).length} parameter(s)
                  {tool.parameters.required?.length > 0 && ` • ${tool.parameters.required.length} required`}
                </p>
                <div className="space-y-2">
                  {(Object.entries(tool.parameters.properties) as [string, Record<string, any>][]).map(([key, schema]) => (
                    <div key={key} className="flex items-start justify-between text-xs border-b pb-2">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <code className="font-mono font-medium">{key}</code>
                          {tool.parameters.required?.includes(key) && (
                            <span className="text-red-500 text-xs">*</span>
                          )}
                        </div>
                        {schema.description && (
                          <p className="text-muted-foreground mt-1">{schema.description}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs ml-2">
                        {schema.type || 'string'}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">No parameters</p>
            )}
          </CardContent>
        </Card>

        {tool.runnerConfig ? (
          <Card className="border-cyan-200 dark:border-cyan-900">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Server className="h-4 w-4 text-cyan-500" />
                Runner-backed tool
              </CardTitle>
              <CardDescription className="text-xs">
                Dispatched through the runner subsystem. Configuration lives on the runner; this tool row is read-only.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Runner</span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 font-mono text-cyan-600 dark:text-cyan-400"
                  onClick={() => navigate(`/runners/${tool.runnerConfig!.runnerId}`)}
                >
                  {tool.runnerConfig.runnerName}
                </Button>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Method</span>
                <code className="bg-muted px-2 py-0.5 rounded font-mono">{tool.runnerConfig.method}</code>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Workspace</span>
                <Badge variant={tool.runnerConfig.requiresWorkspace ? 'default' : 'outline'}>
                  {tool.runnerConfig.requiresWorkspace ? 'required' : 'not required'}
                </Badge>
              </div>
              <p className="text-muted-foreground pt-2">
                To stop publishing this tool, unregister the runner from <a href="/runners" className="underline">Runners</a>.
              </p>
            </CardContent>
          </Card>
        ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              {tool.executionMethod === 'custom' ? 'Custom Code' :
               tool.executionMethod ? `${tool.executionMethod.toUpperCase()} Configuration` :
               'Underlying Operation'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {tool.executionMethod === 'custom' ? (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Execution Method</span>
                  <Badge>Custom JavaScript</Badge>
                </div>
                <div className="mt-2">
                  <span className="text-xs text-muted-foreground">Code:</span>
                  <div className="mt-1">
                    <CodeBlock
                      value={(() => {
                        const raw = tool.code || tool.configuration?.code || 'No code'
                        return raw
                          .replace(/;\s*/g, ';\n')
                          .replace(/\{\s*/g, '{\n  ')
                          .replace(/\}\s*/g, '\n}')
                          .replace(/,\s*(?=[a-zA-Z])/g, ',\n  ')
                          .trim()
                      })()}
                      language="javascript"
                      maxHeight="300px"
                    />
                  </div>
                </div>
              </>
            ) : tool.executionMethod === 'http' ? (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Execution Method</span>
                  <Badge>HTTP REST</Badge>
                </div>
                {tool.metadata?.httpConfig && (
                  <>
                    <div className="flex items-center gap-2">
                      <Badge>{tool.metadata.httpConfig.method}</Badge>
                      <code className="text-xs">{tool.metadata.httpConfig.url}</code>
                    </div>
                  </>
                )}
              </>
            ) : tool.executionMethod === 'graphql' ? (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Execution Method</span>
                  <Badge>GraphQL</Badge>
                </div>
                {tool.metadata?.graphqlConfig && (
                  <div className="text-xs">
                    <span className="text-muted-foreground">Endpoint:</span>
                    <code className="ml-2">{tool.metadata.graphqlConfig.endpoint}</code>
                  </div>
                )}
              </>
            ) : tool.operation ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge className="font-mono">{tool.operation.method}</Badge>
                  <code className="text-sm font-mono">{tool.operation.endpoint}</code>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">API Source</span>
                  <span>{tool.operation.api?.name}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Base URL</span>
                  <code className="text-xs">{tool.operation.api?.baseUrl}</code>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full mt-2"
                  onClick={() => navigate(`/apis/${tool.operation.api.id}`)}
                >
                  View in API Details
                </Button>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No operation configured</p>
            )}
          </CardContent>
        </Card>
        )}
          </div>
        </TabsContent>

        {/* Test Tool Tab */}
        <TabsContent value="test">
          <Card>
            <CardHeader>
              <CardTitle>Test Tool</CardTitle>
              <CardDescription>
                Execute this tool with parameters
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {requiresWorkspace && (
                <div className="space-y-2 border rounded-md p-4 bg-cyan-500/5 border-cyan-200 dark:border-cyan-900">
                  <Label className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-cyan-500" />
                    Workspace <span className="text-red-500">*</span>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    This runner method runs inside an active workspace. Pick one or release+create a new workspace from the runner page.
                  </p>
                  {workspacesQuery.isLoading ? (
                    <p className="text-sm text-muted-foreground">Loading workspaces…</p>
                  ) : workspacesQuery.data && workspacesQuery.data.length > 0 ? (
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      value={selectedWorkspaceId}
                      onChange={(e) => setSelectedWorkspaceId(e.target.value)}
                    >
                      <option value="">Select workspace…</option>
                      {workspacesQuery.data.map((w: any) => (
                        <option key={w.id} value={w.id}>
                          {w.cwd} ({w.isolation}, {w.id.slice(0, 8)})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No active workspaces on this runner. <Link to={`/runners/${runnerId}`} className="underline">Open the runner</Link> to create one.
                    </p>
                  )}
                </div>
              )}
              {/* Parameter Form with inline documentation */}
              {(() => {
                const params = tool.parameters?.properties || tool.operation?.parameters?.body || {}
                const hasParams = Object.keys(params).length > 0

                if (!hasParams) {
                  return (
                    <div className="text-center py-6">
                      <p className="text-muted-foreground mb-4">
                        No parameters required for this tool
                      </p>
                    </div>
                  )
                }

                return (
                  <div className="space-y-4">
                    {(Object.entries(params) as [string, Record<string, any>][]).map(([paramName, paramSchema]) => (
                    <div key={paramName}>
                      <Label className="flex items-center gap-2">
                        <span className="font-medium">
                          {paramName}
                          {tool.parameters.required?.includes(paramName) && (
                            <span className="text-red-500 ml-1">*</span>
                          )}
                        </span>
                        <Badge variant="outline" className="text-xs font-normal">
                          {paramSchema.type || 'string'}
                        </Badge>
                      </Label>
                      {paramSchema.description && (
                        <p className="text-xs text-muted-foreground mt-1 mb-2">{paramSchema.description}</p>
                      )}
                      <Input
                        placeholder={paramSchema.example || `Enter ${paramName}`}
                        value={executionParameters[paramName] || ''}
                        onChange={(e) => setExecutionParameters({
                          ...executionParameters,
                          [paramName]: e.target.value
                        })}
                      />
                    </div>
                    ))
                  }
                  </div>
                )
              })()}

              <Button
                onClick={() => executeToolMutation.mutate({
                  parameters: requiresWorkspace && selectedWorkspaceId
                    ? { ...executionParameters, workspaceId: selectedWorkspaceId }
                    : executionParameters,
                })}
                disabled={executeToolMutation.isPending || (requiresWorkspace && !selectedWorkspaceId)}
                className="w-full"
                size="lg"
              >
                {executeToolMutation.isPending ? (
                  <>
                    <LoadingSpinner size="sm" className="mr-2" />
                    Executing...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Execute Tool
                  </>
                )}
              </Button>

              {/* Results */}
              {executionResult && (
                <div className="space-y-3 border-t pt-4">
                  <div className="flex items-center justify-between">
                    <Label>Result</Label>
                    <Badge variant={executionResult.success ? 'default' : 'destructive'}>
                      {executionResult.success ? 'Success' : 'Error'}
                    </Badge>
                  </div>

                  <div className={executionResult.success ? 'bg-green-500/10 border border-green-500/20 rounded p-4' : 'bg-red-500/10 border border-red-500/20 rounded p-4'}>
                    {executionResult.success ? (
                      <div>
                        <p className="text-sm font-medium mb-3">Response Data:</p>
                        <CodeBlock value={JSON.stringify(executionResult.data, null, 2)} language="json" maxHeight="300px" />
                        {executionResult.metadata && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Executed in {executionResult.metadata.executionTime}ms
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-sm text-destructive font-medium">Execution Failed</p>
                        <div className="space-y-3 text-xs">
                          <div className="bg-background/50 p-3 rounded space-y-2">
                            <p className="text-destructive"><strong>Error:</strong> {executionResult.error || executionResult.message || 'Unknown error'}</p>
                            {executionResult.statusCode && (
                              <p><strong>HTTP Status:</strong> {executionResult.statusCode}</p>
                            )}
                            {executionResult.method && executionResult.url && (
                              <p><strong>Endpoint:</strong> {executionResult.method?.toUpperCase()} {executionResult.url}</p>
                            )}
                          </div>

                          {sentParameters && (
                            <div>
                              <strong>Parameters Sent:</strong>
                              <div className="mt-1">
                                <CodeBlock value={JSON.stringify(sentParameters, null, 2)} language="json" maxHeight="200px" />
                              </div>
                            </div>
                          )}

                          {executionResult.fullError && (
                            <div>
                              <strong>Backend Response:</strong>
                              <div className="mt-1">
                                <CodeBlock value={JSON.stringify(executionResult.fullError, null, 2)} language="json" maxHeight="200px" />
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Exports Tab */}
        <TabsContent value="exports">
          <ExportsSection toolId={id!} toolName={tool.name} gateways={tool.gatewayAssociations || []} />
        </TabsContent>

        {/* Gateways Tab */}
        <TabsContent value="gateways">
          <Card>
            <CardHeader>
              <CardTitle>Gateway Assignments</CardTitle>
              <CardDescription>
                This tool is available through the following gateways
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {tool.gatewayAssociations && tool.gatewayAssociations.length > 0 ? (
                  tool.gatewayAssociations.map((assoc: GatewayToolAssociation) => (
                    <div
                      key={assoc.id}
                      className="flex items-center justify-between p-3 border rounded cursor-pointer hover:bg-muted"
                      onClick={() => navigate(`/gateways/${assoc.gateway?.id}`)}
                    >
                      <div>
                        <div className="font-medium">{assoc.gateway?.name || 'Unknown'}</div>
                        <div className="text-xs text-muted-foreground">{assoc.gateway?.endpoint || 'No endpoint'}</div>
                      </div>
                      <Badge variant="outline">{assoc.gateway?.type?.toUpperCase() || 'N/A'}</Badge>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8">
                    <p className="text-muted-foreground mb-4">
                      Not assigned to any gateway yet
                    </p>
                    <Button variant="outline" onClick={() => navigate('/gateways')}>
                      <Zap className="mr-2 h-4 w-4" />
                      Assign to Gateway
                    </Button>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Stats Tab */}
        <TabsContent value="stats">
          <Card>
            <CardHeader>
              <CardTitle>Usage Statistics</CardTitle>
              <CardDescription>
                Tool execution metrics and performance data
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <div className="text-2xl font-bold">{tool.usageCount || 0}</div>
                  <div className="text-sm text-muted-foreground">Total Executions</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{tool.successRate || 0}%</div>
                  <div className="text-sm text-muted-foreground">Success Rate</div>
                </div>
                <div>
                  <div className="text-2xl font-bold">{tool.averageResponseTime || 0}ms</div>
                  <div className="text-sm text-muted-foreground">Avg Response Time</div>
                </div>
              </div>
              {tool.lastUsedAt && (
                <p className="text-xs text-muted-foreground mt-4">
                  Last used: {new Date(tool.lastUsedAt).toLocaleString()}
                </p>
              )}
              {(tool.usageCount || 0) === 0 && (
                <p className="text-center text-muted-foreground py-8">
                  No executions recorded yet. Test this tool to see usage statistics.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface GatewayInfo {
  gateway?: { id: string; name: string; type: string; endpoint: string; organizationId?: string }
}

function ExportsSection({ toolId, toolName, gateways }: { toolId: string; toolName: string; gateways: GatewayInfo[] }) {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const { currentOrganization } = useOrganizationStore()

  const orgId = currentOrganization?.id || ''
  const orgSlug = currentOrganization?.slug || (currentOrganization?.name || 'org').toLowerCase().replace(/\s+/g, '-')

  // Derive which protocols this tool is exposed on
  const exposedProtocols = gateways.map(g => g.gateway?.type).filter(Boolean) as string[]
  const hasMcp = exposedProtocols.includes('mcp')
  const hasA2a = exposedProtocols.includes('a2a')
  const hasUtcp = exposedProtocols.includes('utcp')
  const hasSkills = exposedProtocols.includes('skills')
  const hasAnyGateway = gateways.length > 0

  // Get first gateway of each type for endpoint URLs
  const mcpGateway = gateways.find(g => g.gateway?.type === 'mcp')?.gateway
  const skillsGateway = gateways.find(g => g.gateway?.type === 'skills')?.gateway
  const firstGateway = gateways[0]?.gateway

  const apiBase = import.meta.env.VITE_API_BASE_URL || window.location.origin

  const { data: skillData, isLoading: skillLoading } = useQuery({
    queryKey: ['tool-skill', toolId],
    queryFn: () => toolsApi.getSkill(toolId, orgId),
    enabled: !!orgId,
  })

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch (err) {
      console.warn('Clipboard copy failed:', err)
      setCopiedField(`${field}:error`)
      setTimeout(() => setCopiedField(null), 2500)
    }
  }

  const skill = skillData

  if (!hasAnyGateway) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <p className="text-sm text-muted-foreground">This tool is not assigned to any gateway yet.</p>
          <p className="text-xs text-muted-foreground mt-1">Assign it to a gateway to get integration instructions.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Show each protocol this tool is exposed on */}
      {hasSkills && skillsGateway && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <BookOpen className="h-5 w-5 text-purple-500" />
              <CardTitle className="text-sm">Agent Skills</CardTitle>
              <Badge variant="outline" className="text-[10px]">{skillsGateway.name}</Badge>
            </div>
            <CardDescription className="text-xs">
              Install this tool as a skill in 30+ AI agents
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs font-medium">Install</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 text-xs bg-muted p-2.5 rounded font-mono">
                  npx @almyty/skills install @{orgSlug}{skillsGateway.endpoint}
                </code>
                <Button variant="outline" size="sm" onClick={() => copyToClipboard(`npx @almyty/skills install @${orgSlug}${skillsGateway.endpoint}`, 'skills-install')}>
                  {copiedField === 'skills-install' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            </div>
            <div>
              <Label className="text-xs font-medium">Daemon mode</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 text-xs bg-muted p-2.5 rounded font-mono">npx @almyty/skills daemon</code>
                <Button variant="outline" size="sm" onClick={() => copyToClipboard('npx @almyty/skills daemon', 'daemon')}>
                  {copiedField === 'daemon' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground mt-1">Syncs skills continuously.</p>
            </div>
            {skill?.content && (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">View SKILL.md</summary>
                <div className="mt-2">
                  <CodeBlock value={skill.content} language="text" maxHeight="200px" />
                </div>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      {hasMcp && mcpGateway && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Zap className="h-5 w-5 text-violet-500" />
              <CardTitle className="text-sm">MCP</CardTitle>
              <Badge variant="outline" className="text-[10px]">{mcpGateway.name}</Badge>
            </div>
            <CardDescription className="text-xs">
              Connect via MCP in Claude Code, Cursor, Windsurf, or any MCP client
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-xs font-medium">Endpoint</Label>
              <div className="flex items-center gap-2 mt-1">
                <code className="flex-1 text-xs bg-muted p-2.5 rounded font-mono break-all">
                  {apiBase}/{orgSlug}{mcpGateway.endpoint}
                </code>
                <Button variant="outline" size="sm" onClick={() => copyToClipboard(`${apiBase}/${orgSlug}${mcpGateway.endpoint}`, 'mcp-url')}>
                  {copiedField === 'mcp-url' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            </div>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Client configs</summary>
              <div className="mt-2 space-y-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Claude Code</Label>
                  <div className="mt-1">
                    <CodeBlock value={`"mcpServers": {\n  "${mcpGateway.name.toLowerCase().replace(/\s+/g, '-')}": {\n    "url": "${apiBase}/${orgSlug}${mcpGateway.endpoint}",\n    "headers": { "X-API-Key": "YOUR_KEY" }\n  }\n}`} language="json" maxHeight="120px" />
                  </div>
                </div>
              </div>
            </details>
          </CardContent>
        </Card>
      )}

      {hasUtcp && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Globe className="h-5 w-5 text-emerald-500" />
              <CardTitle className="text-sm">UTCP</CardTitle>
              <Badge variant="outline" className="text-[10px]">{gateways.find(g => g.gateway?.type === 'utcp')?.gateway?.name}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted p-2.5 rounded font-mono break-all">
                {apiBase}/{orgSlug}{gateways.find(g => g.gateway?.type === 'utcp')?.gateway?.endpoint}
              </code>
              <Button variant="outline" size="sm" onClick={() => copyToClipboard(`${apiBase}/${orgSlug}${gateways.find(g => g.gateway?.type === 'utcp')?.gateway?.endpoint}`, 'utcp-url')}>
                {copiedField === 'utcp-url' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {hasA2a && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Bot className="h-5 w-5 text-cyan-500" />
              <CardTitle className="text-sm">A2A</CardTitle>
              <Badge variant="outline" className="text-[10px]">{gateways.find(g => g.gateway?.type === 'a2a')?.gateway?.name}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-muted p-2.5 rounded font-mono break-all">
                {apiBase}/{orgSlug}{gateways.find(g => g.gateway?.type === 'a2a')?.gateway?.endpoint}
              </code>
              <Button variant="outline" size="sm" onClick={() => copyToClipboard(`${apiBase}/${orgSlug}${gateways.find(g => g.gateway?.type === 'a2a')?.gateway?.endpoint}`, 'a2a-url')}>
                {copiedField === 'a2a-url' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
