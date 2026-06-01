import React, { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronRight,
  Activity,
  CheckCircle2,
  XCircle,
  TestTube,
  RefreshCw,
  Power,
  PowerOff,
  Send,
  RotateCcw,
} from 'lucide-react'

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

import { llmProvidersApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { CredentialPicker } from '@/components/credential-picker'

const providerLogos: Record<string, string> = {
  openai: '🤖', anthropic: '🧠', google: '✦', mistral: '🔷', xai: '𝕏',
  deepseek: '🔮', groq: '⚡', together: '🤝', openrouter: '🔀',
  azure_openai: '☁️', aws_bedrock: '🪨', cohere: '🌀', huggingface: '🤗', custom: '⚙️',
}

const statusColors: Record<string, string> = {
  active: 'bg-green-500', inactive: 'bg-muted-foreground', error: 'bg-red-500', configuring: 'bg-yellow-500',
}

export function LlmProviderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const notifications = useNotifications()
  const queryClient = useQueryClient()

  const [credentialId, setCredentialId] = useState('')
  const [apiKey, setApiKey] = useState('')

  // Chat state
  const [chatMessages, setChatMessages] = useState<Array<{
    role: 'user' | 'assistant' | 'tool'; content: string; toolCalls?: any[]; toolCallId?: string
  }>>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const chatEndRef = React.useRef<HTMLDivElement>(null)

  const { data: provider, isLoading } = useQuery({
    queryKey: ['llm-provider', id],
    queryFn: () => llmProvidersApi.getById(id!),
    enabled: !!id,
  })

  useEffect(() => {
    const name = (provider as any)?.name
    document.title = name ? `${name} | almyty` : 'Provider | almyty'
    return () => { document.title = 'almyty' }
  }, [provider])

  const { data: providerMetrics } = useQuery({
    queryKey: ['provider-metrics', id],
    queryFn: async () => {
      try {
        return await llmProvidersApi.getUsage(id!)
      } catch {
        return null
      }
    },
    enabled: !!id,
  })

  const toggleStatusMutation = useMutation({
    mutationFn: async ({ status }: { status: string }) => {
      return llmProvidersApi.update(id!, { status })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-provider', id] })
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      notifications.success('Updated', 'Provider status changed')
    },
    onError: (error: any) => {
      notifications.error('Error', error.response?.data?.message || 'Failed to update provider')
    },
  })

  // Connection health check — fires a minimal "Hello" prompt at the
  // provider with maxTokens=10 so we can verify the API key, model
  // name, and base URL without burning real budget. Backend endpoint
  // is scoped to `{providerId, organizationId}` so a cross-tenant
  // probe gets "Provider not found".
  const testProviderMutation = useMutation({
    mutationFn: () => llmProvidersApi.test(id!),
    onSuccess: (result: any) => {
      // The controller returns { success, data: { isHealthy, responseTime, error?, details? }, message }
      // — apiPost unwraps `data` for us, so `result` here is the inner object.
      if (result?.isHealthy) {
        notifications.success(
          'Connection OK',
          `Provider responded in ${result.responseTime ?? '?'}ms`,
        )
      } else {
        notifications.error(
          'Connection failed',
          result?.error || 'Provider did not report healthy',
        )
      }
      queryClient.invalidateQueries({ queryKey: ['llm-provider', id] })
    },
    onError: (error: any) => {
      notifications.error(
        'Connection failed',
        error?.response?.data?.message || error?.message || 'Test request failed',
      )
    },
  })

  const handleSendChat = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!chatInput.trim() || isSending || !provider) return
    const userMessage = chatInput.trim()
    setChatInput('')
    const newMessages = [...chatMessages, { role: 'user' as const, content: userMessage }]
    setChatMessages(newMessages)
    setIsSending(true)
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    try {
      const data = await llmProvidersApi.chat(provider.id, {
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
        sessionId: chatSessionId || undefined,
      })
      if (data?.message) {
        setChatMessages(prev => [...prev, {
          role: 'assistant', content: data.message.content || '', toolCalls: data.message.toolCalls,
        }])
      }
      if (data?.sessionId) setChatSessionId(data.sessionId)
    } catch (err: any) {
      setChatMessages(prev => [...prev, {
        role: 'assistant', content: `Error: ${err.response?.data?.message || err.message || 'Failed to get response'}`,
      }])
    } finally {
      setIsSending(false)
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  if (!provider) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <p className="text-muted-foreground">Provider not found</p>
          <Button className="mt-4" onClick={() => navigate('/llm-providers')}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to AI Models
          </Button>
        </div>
      </div>
    )
  }

  const successRate = provider.totalRequests > 0
    ? (((provider.successfulRequests || 0) / provider.totalRequests) * 100).toFixed(1)
    : '100.0'

  return (
    <div className="space-y-8">
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link to="/llm-providers" className="hover:text-foreground">AI Models</Link>
        <ChevronRight className="h-3 w-3" />
        <span className="text-foreground">{provider.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <Button variant="outline" size="sm" onClick={() => navigate('/llm-providers')}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 bg-primary/10 rounded-lg flex items-center justify-center text-2xl">
              {providerLogos[provider.type] || '⚙️'}
            </div>
            <div>
              <h1 className="text-4xl font-heading font-extrabold tracking-tight">{provider.name}</h1>
              <p className="text-muted-foreground">{provider.description || `${provider.type} provider`}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center space-x-2">
          <Button variant="outline" size="sm" onClick={() => {
            toggleStatusMutation.mutate({ status: provider.status === 'active' ? 'inactive' : 'active' })
          }}>
            {provider.status === 'active' ? <PowerOff className="h-4 w-4 mr-2" /> : <Power className="h-4 w-4 mr-2" />}
            {provider.status === 'active' ? 'Disable' : 'Enable'}
          </Button>
          <Badge variant={provider.status === 'active' ? 'success' : 'secondary'} className="capitalize">
            {provider.status}
          </Badge>
          <Switch
            checked={provider.status === 'active'}
            onCheckedChange={(checked) => toggleStatusMutation.mutate({ status: checked ? 'active' : 'inactive' })}
          />
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-4 gap-4">
        <Card><CardContent className="pt-6 text-center">
          <div className="text-2xl font-bold">{(provider.totalRequests || 0).toLocaleString()}</div>
          <div className="text-sm text-muted-foreground">Total Requests</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-2xl font-bold">{successRate}%</div>
          <div className="text-sm text-muted-foreground">Success Rate</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-2xl font-bold">${(provider.totalCost || 0).toFixed(2)}</div>
          <div className="text-sm text-muted-foreground">Total Cost</div>
        </CardContent></Card>
        <Card><CardContent className="pt-6 text-center">
          <div className="text-2xl font-bold">{(provider.totalTokensUsed || 0).toLocaleString()}</div>
          <div className="text-sm text-muted-foreground">Tokens Used</div>
        </CardContent></Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="chat">Chat</TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
          <TabsTrigger value="configuration">Configuration</TabsTrigger>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Provider Information</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Type:</span>
                  <Badge variant="outline" className="capitalize">{provider.type}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Status:</span>
                  <Badge className={`${statusColors[provider.status]} text-white`}>{provider.status}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Health:</span>
                  <span className={`text-sm font-medium ${provider.isHealthy ? 'text-green-600' : provider.status === 'error' ? 'text-red-600' : 'text-muted-foreground'}`}>
                    {provider.isHealthy ? 'Healthy' : provider.status === 'error' ? 'Down' : 'Unknown'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Models:</span>
                  <span className="text-sm">{provider.capabilities?.supportedModels?.length || 0} available</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Created:</span>
                  <span className="text-sm">{new Date(provider.createdAt).toLocaleDateString()}</span>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Usage Summary</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Total Requests:</span>
                  <span className="text-sm font-medium">{(provider.totalRequests || 0).toLocaleString()}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Total Cost:</span>
                  <span className="text-sm font-medium">${(provider.totalCost || 0).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Success Rate:</span>
                  <span className="text-sm font-medium">{successRate}%</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-sm text-muted-foreground">Last Used:</span>
                  <span className="text-sm">{provider.lastRequestAt ? new Date(provider.lastRequestAt).toLocaleString() : 'Never'}</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Chat Tab */}
        <TabsContent value="chat" className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {chatSessionId
                ? <span>Session: <code className="font-mono text-xs">{chatSessionId.slice(0, 8)}...</code></span>
                : <span>New conversation</span>}
            </div>
            <Button size="sm" variant="outline" onClick={() => { setChatMessages([]); setChatSessionId(null); setChatInput('') }} className="gap-1">
              <RotateCcw className="h-3 w-3" /> New Chat
            </Button>
          </div>
          <div className="border rounded-lg h-[400px] flex flex-col">
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {chatMessages.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-12">
                  Send a message to start chatting with {provider.name}.
                  <br /><span className="text-xs">Model: {provider.configuration?.model || 'default'}</span>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                    msg.role === 'user' ? 'bg-primary text-primary-foreground'
                      : msg.role === 'tool' ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
                      : 'bg-muted'
                  }`}>
                    {msg.role === 'tool' && <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">Tool: {msg.toolCallId || 'call'}</div>}
                    {msg.content && <div className="whitespace-pre-wrap">{msg.content}</div>}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {msg.toolCalls.map((tc: any, j: number) => (
                          <div key={j} className="text-xs bg-background/50 rounded p-2 border">
                            <div className="font-medium">{tc.function?.name || tc.name || 'tool_call'}</div>
                            <pre className="text-xs mt-1 overflow-x-auto">{JSON.stringify(tc.function?.arguments || tc.arguments || tc, null, 2).slice(0, 300)}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {isSending && <div className="flex justify-start"><div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground">Thinking...</div></div>}
              <div ref={chatEndRef} />
            </div>
            <div className="border-t p-3">
              <form onSubmit={handleSendChat} className="flex gap-2">
                <Textarea
                  value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                  placeholder="Send a message..." className="min-h-[40px] max-h-[120px] resize-none"
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit() } }}
                />
                <Button type="submit" size="sm" disabled={!chatInput.trim() || isSending} className="self-end">
                  <Send className="h-4 w-4" />
                </Button>
              </form>
            </div>
          </div>
          <div className="text-xs text-muted-foreground">
            Provider: {provider.type} | Model: {provider.configuration?.model || 'default'} | Enter to send, Shift+Enter for newline
          </div>
        </TabsContent>

        {/* Models Tab */}
        <TabsContent value="models" className="space-y-4">
          {provider.capabilities?.supportedModels && provider.capabilities.supportedModels.length > 0 ? (
            provider.capabilities.supportedModels.map((modelName: string, index: number) => (
              <Card key={index}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium">{modelName}</h4>
                      <Badge variant="default">Available</Badge>
                    </div>
                    <div className="text-sm text-muted-foreground">{provider.capabilities?.maxTokens?.toLocaleString() || 'N/A'} tokens</div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {provider.capabilities?.supportsFunctionCalling && <Badge variant="outline" className="text-xs">Function Calling</Badge>}
                    {provider.capabilities?.supportsStreaming && <Badge variant="outline" className="text-xs">Streaming</Badge>}
                    {provider.capabilities?.supportsToolUse && <Badge variant="outline" className="text-xs">Tool Use</Badge>}
                    {provider.capabilities?.supportsVision && <Badge variant="outline" className="text-xs">Vision</Badge>}
                  </div>
                </CardContent>
              </Card>
            ))
          ) : (
            <div className="text-sm text-muted-foreground text-center py-8">No model information available</div>
          )}
        </TabsContent>

        {/* Configuration Tab */}
        <TabsContent value="configuration" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">API Configuration</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <CredentialPicker
                label="API Key" value={credentialId}
                onSelect={(cid) => setCredentialId(cid)}
                onNewKey={(key) => setApiKey(key)}
                newKeyValue={apiKey || provider.configuration?.apiKey || ''}
                filterType="api_key"
              />
              <div><Label>Base URL</Label><Input value={provider.configuration?.baseUrl || ''} readOnly /></div>
              {provider.configuration?.region && <div><Label>Region</Label><Input value={provider.configuration.region} readOnly /></div>}
              <div><Label>Default Model</Label><Input value={provider.configuration?.model || ''} readOnly /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><Label>Max Tokens</Label><Input value={provider.configuration?.maxTokens || ''} readOnly /></div>
                <div><Label>Temperature</Label><Input value={provider.configuration?.temperature || ''} readOnly /></div>
              </div>
            </CardContent>
          </Card>
          {provider.configuration?.customHeaders && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Custom Headers</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {Object.entries(provider.configuration.customHeaders).map(([key, value], index) => (
                  <div key={index} className="flex gap-2">
                    <Input value={key} readOnly className="flex-1" />
                    <Input value={value as string} readOnly className="flex-1" />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Usage Tab */}
        <TabsContent value="usage" className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Performance Metrics</CardTitle></CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="text-center">
                    <div className="text-2xl font-bold">{provider.lastRequestAt ? 'Active' : 'Inactive'}</div>
                    <div className="text-sm text-muted-foreground">Status</div>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold">{provider.isHealthy ? '\u2713' : '\u2717'}</div>
                    <div className="text-sm text-muted-foreground">Health</div>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Cost Breakdown</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm"><span>Total Tokens:</span><span>{(provider.totalTokensUsed || 0).toLocaleString()}</span></div>
                <div className="flex justify-between text-sm"><span>Avg Cost/Request:</span><span>${provider.totalRequests > 0 ? ((provider.totalCost || 0) / provider.totalRequests).toFixed(4) : '0.0000'}</span></div>
                <div className="flex justify-between text-sm"><span>Total Cost:</span><span>${(provider.totalCost || 0).toFixed(2)}</span></div>
              </CardContent>
            </Card>
          </div>
          {providerMetrics && (
            <>
              {providerMetrics.usageByModel && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Usage by Model</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {providerMetrics.usageByModel.map((mu: any, i: number) => (
                      <div key={i} className="flex justify-between items-center">
                        <span className="text-sm">{mu.model}</span>
                        <div className="text-right">
                          <div className="text-sm font-medium">${mu.cost.toFixed(2)}</div>
                          <div className="text-xs text-muted-foreground">{mu.requests} reqs</div>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
              {providerMetrics.topErrors && providerMetrics.topErrors.length > 0 && (
                <Card>
                  <CardHeader><CardTitle className="text-sm">Error Analysis</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {providerMetrics.topErrors.map((err: any, i: number) => (
                      <div key={i} className="flex justify-between items-center">
                        <span className="text-sm">{err.error}</span>
                        <div className="text-right">
                          <Badge variant="destructive" className="text-xs">{err.count}</Badge>
                          <div className="text-xs text-muted-foreground">{new Date(err.lastOccurred).toLocaleString()}</div>
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* Monitoring Tab */}
        <TabsContent value="monitoring" className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Health Status</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex items-center gap-2">
                  {provider.isHealthy ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                    : provider.status === 'error' ? <XCircle className="h-4 w-4 text-red-500" />
                    : <Activity className="h-4 w-4 text-muted-foreground" />}
                  <span className="capitalize font-medium">
                    {provider.isHealthy ? 'Healthy' : provider.status === 'error' ? 'Down' : 'Unknown'}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Last check: {provider.lastHealthCheckAt ? new Date(provider.lastHealthCheckAt).toLocaleString() : 'Never'}
                </div>
                <div className="text-sm">Status: {provider.status}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Recent Errors</CardTitle></CardHeader>
              <CardContent>
                {provider.lastError ? (
                  <div className="border-l-2 border-red-200 pl-3">
                    <div className="text-sm font-medium text-red-600">{provider.lastError}</div>
                    <div className="text-xs text-muted-foreground">Last error occurred</div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No recent errors</div>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                Actions
                <Button
                  size="sm"
                  onClick={() => testProviderMutation.mutate()}
                  disabled={testProviderMutation.isPending}
                  className="gap-2"
                >
                  <TestTube className="h-4 w-4" />
                  {testProviderMutation.isPending ? 'Testing…' : 'Test Provider'}
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={() => testProviderMutation.mutate()}
                  disabled={testProviderMutation.isPending}
                >
                  <RefreshCw className={`h-4 w-4 ${testProviderMutation.isPending ? 'animate-spin' : ''}`} />
                  Refresh Health
                </Button>
                <Button size="sm" variant="outline" className="gap-2" onClick={() => {
                  toggleStatusMutation.mutate({ status: provider.status === 'active' ? 'inactive' : 'active' })
                }}>
                  {provider.status === 'active'
                    ? <><PowerOff className="h-4 w-4" /> Disable</>
                    : <><Power className="h-4 w-4" /> Enable</>}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
