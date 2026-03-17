import React, { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Code, Play, Zap, Settings, Download, Terminal, FileCode, BookOpen, Copy, Check } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

import { toolsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'

export function ToolDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const notifications = useNotifications()
  const queryClient = useQueryClient()
  const { currentOrganization } = useOrganizationStore()

  const [executionParameters, setExecutionParameters] = useState<Record<string, any>>({})
  const [executionResult, setExecutionResult] = useState<any>(null)

  const { data: toolData, isLoading } = useQuery({
    queryKey: ['tool', id],
    queryFn: async () => {
      if (!currentOrganization?.id) throw new Error('No organization selected')
      return await toolsApi.getById(id!, currentOrganization.id)
    },
    enabled: !!id && !!currentOrganization,
  })

  const [sentParameters, setSentParameters] = React.useState<any>(null)

  const executeToolMutation = useMutation({
    mutationFn: ({ parameters }: { parameters: Record<string, any> }) => {
      if (!currentOrganization?.id) throw new Error('No organization selected')
      setSentParameters(parameters)
      return toolsApi.execute(id!, { parameters }, currentOrganization.id)
    },
    onSuccess: (response: any) => {
      setExecutionResult(response.data)
      if (response.data.success) {
        notifications.success('Success', 'Tool executed successfully')
      } else {
        notifications.error('Execution Failed', response.data.error || 'Tool execution failed')
      }
    },
    onError: (error: any) => {
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
      toolsApi.update(id!, { status }),
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

  if (!toolData?.data) {
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

  const tool = toolData.data?.data || toolData.data

  return (
    <div className="space-y-8">
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
              <h1 className="text-3xl font-bold tracking-tight">{tool.name}</h1>
              <p className="text-muted-foreground">{tool.description || 'AI-generated tool from API operation'}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/tools/${id}/edit`)}>
            <Settings className="h-4 w-4 mr-2" />
            Edit Tool
          </Button>
          <Badge variant={tool.status === 'active' ? 'default' : 'secondary'}>
            {tool.status}
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
                  {Object.entries(tool.parameters.properties).map(([key, schema]: [string, any]) => (
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
                  <pre className="p-4 text-sm font-mono bg-muted/50 rounded-md overflow-auto whitespace-pre-wrap break-words max-h-[300px] mt-1">
                    {tool.code || tool.configuration?.code || 'No code'}
                  </pre>
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
              {/* Parameter Form with inline documentation */}
              {(() => {
                const params = tool.parameters?.properties || tool.operation?.parameters?.body || {}
                const hasParams = Object.keys(params).length > 0

                if (!hasParams) {
                  return (
                    <div className="text-center py-6">
                      <p className="text-muted-foreground mb-4">
                        {tool.operation?.method === 'POST' || tool.operation?.method === 'PUT' || tool.operation?.method === 'PATCH'
                          ? 'Parameter schema not available. Tool was generated without parameter details.'
                          : 'No parameters required for this tool'}
                      </p>
                      {(tool.operation?.method === 'POST' || tool.operation?.method === 'PUT' || tool.operation?.method === 'PATCH') && tool.operation?.api?.id && (
                        <Button
                          variant="outline"
                          onClick={() => navigate(`/apis/${tool.operation.api.id}`)}
                        >
                          Re-import Schema to Fix
                        </Button>
                      )}
                    </div>
                  )
                }

                return (
                  <div className="space-y-4">
                    {Object.entries(params).map(([paramName, paramSchema]: [string, any]) => (
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
                onClick={() => executeToolMutation.mutate({ parameters: executionParameters })}
                disabled={executeToolMutation.isPending}
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

                  <div className={executionResult.success ? 'bg-green-50 border border-green-200 rounded p-4' : 'bg-red-50 border border-red-200 rounded p-4'}>
                    {executionResult.success ? (
                      <div>
                        <p className="text-sm font-medium mb-3">Response Data:</p>
                        <pre className="text-xs overflow-x-auto bg-background/50 p-3 rounded">
                          {JSON.stringify(executionResult.data, null, 2)}
                        </pre>
                        {executionResult.metadata && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Executed in {executionResult.metadata.executionTime}ms
                          </p>
                        )}
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <p className="text-sm text-red-900 font-medium">Execution Failed</p>
                        <div className="space-y-3 text-xs">
                          <div className="bg-background/50 p-3 rounded space-y-2">
                            <p className="text-red-700"><strong>Error:</strong> {executionResult.error || executionResult.message || 'Unknown error'}</p>
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
                              <pre className="mt-1 bg-background/50 p-2 rounded overflow-x-auto">
                                {JSON.stringify(sentParameters, null, 2)}
                              </pre>
                            </div>
                          )}

                          {executionResult.fullError && (
                            <div>
                              <strong>Backend Response:</strong>
                              <pre className="mt-1 bg-background/50 p-2 rounded overflow-x-auto">
                                {JSON.stringify(executionResult.fullError, null, 2)}
                              </pre>
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
          <ExportsSection toolId={id!} toolName={tool.name} />
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
                  tool.gatewayAssociations.map((assoc: any) => (
                    <div
                      key={assoc.id}
                      className="flex items-center justify-between p-3 border rounded cursor-pointer hover:bg-muted/50"
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

function ExportsSection({ toolId, toolName }: { toolId: string; toolName: string }) {
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [cliFormat, setCliFormat] = useState<'bash' | 'node'>('bash')
  const { currentOrganization } = useOrganizationStore()

  const orgId = currentOrganization?.id || ''

  const { data: skillData, isLoading: skillLoading } = useQuery({
    queryKey: ['tool-skill', toolId],
    queryFn: () => toolsApi.getSkill(toolId, orgId),
    enabled: !!orgId,
  })

  const { data: cliData, isLoading: cliLoading } = useQuery({
    queryKey: ['tool-cli', toolId, cliFormat],
    queryFn: () => toolsApi.getCli(toolId, orgId, cliFormat),
    enabled: !!orgId,
  })

  const { data: sdkData, isLoading: sdkLoading } = useQuery({
    queryKey: ['tool-sdk', toolId],
    queryFn: () => toolsApi.getSdk(toolId, orgId),
    enabled: !!orgId,
  })

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text)
    setCopiedField(field)
    setTimeout(() => setCopiedField(null), 2000)
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

  const skill = skillData?.data?.data || skillData?.data
  const cli = cliData?.data?.data || cliData?.data
  const sdk = sdkData?.data?.data || sdkData?.data

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {/* Skill Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-purple-500" />
            <CardTitle className="text-sm">Skill File</CardTitle>
          </div>
          <CardDescription className="text-xs">
            YAML + Markdown that teaches LLMs how to use this tool
          </CardDescription>
        </CardHeader>
        <CardContent>
          {skillLoading ? (
            <LoadingSpinner size="sm" />
          ) : skill?.content ? (
            <div className="space-y-3">
              <pre className="text-xs bg-muted p-3 rounded max-h-48 overflow-auto font-mono whitespace-pre-wrap">
                {skill.content.slice(0, 500)}{skill.content.length > 500 ? '...' : ''}
              </pre>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => copyToClipboard(skill.content, 'skill')}
                >
                  {copiedField === 'skill' ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => downloadFile(skill.content, `${skill.name || toolName}.skill.md`)}
                >
                  <Download className="h-3 w-3 mr-1" />
                  Download
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Not available</p>
          )}
        </CardContent>
      </Card>

      {/* CLI Card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Terminal className="h-5 w-5 text-green-500" />
            <CardTitle className="text-sm">CLI Script</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Executable command-line wrapper for this tool
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-1 mb-3">
            <Button
              variant={cliFormat === 'bash' ? 'default' : 'outline'}
              size="sm"
              className="text-xs h-7"
              onClick={() => setCliFormat('bash')}
            >
              Bash
            </Button>
            <Button
              variant={cliFormat === 'node' ? 'default' : 'outline'}
              size="sm"
              className="text-xs h-7"
              onClick={() => setCliFormat('node')}
            >
              Node.js
            </Button>
          </div>
          {cliLoading ? (
            <LoadingSpinner size="sm" />
          ) : cli?.content ? (
            <div className="space-y-3">
              <pre className="text-xs bg-muted p-3 rounded max-h-48 overflow-auto font-mono whitespace-pre-wrap">
                {cli.content.slice(0, 500)}{cli.content.length > 500 ? '...' : ''}
              </pre>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => copyToClipboard(cli.content, 'cli')}
                >
                  {copiedField === 'cli' ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => downloadFile(cli.content, `${cli.name || toolName}.${cliFormat === 'bash' ? 'sh' : 'mjs'}`)}
                >
                  <Download className="h-3 w-3 mr-1" />
                  Download
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Not available</p>
          )}
        </CardContent>
      </Card>

      {/* SDK Card - only show when content is available */}
      {sdk?.content && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <FileCode className="h-5 w-5 text-blue-500" />
              <CardTitle className="text-sm">TypeScript Client</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Generated TypeScript code for calling this tool
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <pre className="text-xs bg-muted p-3 rounded max-h-48 overflow-auto font-mono whitespace-pre-wrap">
                {sdk.content.slice(0, 500)}{sdk.content.length > 500 ? '...' : ''}
              </pre>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => copyToClipboard(sdk.content, 'sdk')}
                >
                  {copiedField === 'sdk' ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
                  Copy
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => downloadFile(sdk.content, `${sdk.name || toolName}.ts`)}
                >
                  <Download className="h-3 w-3 mr-1" />
                  Download
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* MCP Setup Card */}
      <Card className="md:col-span-2 lg:col-span-3">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-orange-500" />
            <CardTitle className="text-sm">npx Integration</CardTitle>
          </div>
          <CardDescription className="text-xs">
            Use this tool directly in Claude Code, Cursor, Windsurf, Copilot, and other MCP-compatible clients
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">Install & run</Label>
            <div className="flex items-center gap-2 mt-1">
              <code className="flex-1 text-xs bg-muted p-2 rounded font-mono">
                npx @apifai/mcp-server
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard('npx @apifai/mcp-server', 'npx')}
              >
                {copiedField === 'npx' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Claude Code config (~/.claude/settings.json)</Label>
            <div className="flex items-center gap-2 mt-1">
              <pre className="flex-1 text-xs bg-muted p-2 rounded font-mono overflow-auto">
{`"mcpServers": {
  "apifai": { "command": "npx", "args": ["@apifai/mcp-server"] }
}`}
              </pre>
              <Button
                variant="outline"
                size="sm"
                onClick={() => copyToClipboard(
                  `"mcpServers": {\n  "apifai": { "command": "npx", "args": ["@apifai/mcp-server"] }\n}`,
                  'claude-config'
                )}
              >
                {copiedField === 'claude-config' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
