import React, { useState } from 'react'
import {
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
import { UseMutationResult } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'

import { llmProvidersApi } from '@/lib/api'
import { CredentialPicker } from '@/components/credential-picker'

interface LlmProvider {
  id: string
  name: string
  description?: string
  type: string
  status: 'active' | 'inactive' | 'error' | 'configuring'
  organizationId: string
  configuration: {
    apiKey?: string
    baseUrl?: string
    region?: string
    model?: string
    maxTokens?: number
    temperature?: number
    customHeaders?: Record<string, string>
  }
  capabilities?: {
    supportedModels: string[]
    maxTokens: number
    supportsFunctionCalling: boolean
    supportsStreaming: boolean
    supportsBatching: boolean
    supportsVision: boolean
    supportsAudio: boolean
    supportsToolUse: boolean
    supportedToolFormats: string[]
  }
  metadata?: any
  totalRequests: number
  successfulRequests: number
  totalTokensUsed: number
  totalCost: number
  lastRequestAt?: string
  lastHealthCheckAt?: string
  isHealthy: boolean
  lastError?: string
  createdAt: string
  updatedAt: string
}

interface ProviderMetrics {
  providerId: string
  costByDay: Array<{ date: string; cost: number; tokens: number; requests: number }>
  usageByModel: Array<{ model: string; requests: number; cost: number; tokens: number }>
  responseTimeByHour: Array<{ hour: number; avgResponseTime: number; p95ResponseTime: number }>
  errorsByType: Array<{ type: string; count: number; percentage: number }>
  topErrors: Array<{ error: string; count: number; lastOccurred: string }>
}

const providerLogos: Record<string, string> = {
  openai: '🤖',
  anthropic: '🧠',
  google: '✦',
  mistral: '🔷',
  xai: '𝕏',
  deepseek: '🔮',
  groq: '⚡',
  together: '🤝',
  openrouter: '🔀',
  azure_openai: '☁️',
  aws_bedrock: '🪨',
  cohere: '🌀',
  huggingface: '🤗',
  custom: '⚙️'
}

const statusColors: Record<string, string> = {
  active: 'bg-green-500',
  inactive: 'bg-muted-foreground',
  error: 'bg-red-500',
  configuring: 'bg-yellow-500'
}

const healthColors = {
  healthy: 'text-green-600',
  degraded: 'text-yellow-600',
  down: 'text-red-600',
  unknown: 'text-muted-foreground'
}

interface ProviderDetailsSheetProps {
  selectedProvider: LlmProvider | null
  onClose: () => void
  providerMetrics: ProviderMetrics | null | undefined
  toggleProviderStatusMutation: UseMutationResult<any, any, any, any>
  onOpenTestDialog: () => void
}

export function ProviderDetailsSheet({
  selectedProvider,
  onClose,
  providerMetrics,
  toggleProviderStatusMutation,
  onOpenTestDialog,
}: ProviderDetailsSheetProps) {
  // Credential state for API key
  const [providerCredentialId, setProviderCredentialId] = useState('')
  const [providerApiKey, setProviderApiKey] = useState('')

  // Chat state
  const [chatMessages, setChatMessages] = useState<Array<{
    role: 'user' | 'assistant' | 'tool'
    content: string
    toolCalls?: any[]
    toolCallId?: string
  }>>([])
  const [chatInput, setChatInput] = useState('')
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const chatEndRef = React.useRef<HTMLDivElement>(null)

  return (
    <Sheet open={!!selectedProvider} onOpenChange={() => onClose()}>
      <SheetContent className="w-full max-w-4xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-3">
            {selectedProvider && (
              <>
                <span className="text-xl">{providerLogos[selectedProvider.type]}</span>
                <div className={`w-3 h-3 rounded-full ${statusColors[selectedProvider.status]}`} />
                {selectedProvider.name}
              </>
            )}
          </SheetTitle>
          <SheetDescription>
            {selectedProvider?.description || 'No description provided'}
          </SheetDescription>
        </SheetHeader>

        {selectedProvider && (
          <Tabs defaultValue="overview" className="mt-6">
            <TabsList className="grid w-full grid-cols-6">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="models">Models</TabsTrigger>
              <TabsTrigger value="usage">Usage</TabsTrigger>
              <TabsTrigger value="configuration">Config</TabsTrigger>
              <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Provider Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Type:</span>
                      <Badge variant="outline" className="capitalize">{selectedProvider.type}</Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Status:</span>
                      <Badge className={`${statusColors[selectedProvider.status]} text-white`}>
                        {selectedProvider.status}
                      </Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Health:</span>
                      <span className={`text-sm font-medium ${
                        selectedProvider.isHealthy
                          ? healthColors.healthy
                          : (selectedProvider.status === 'error' ? healthColors.down : healthColors.unknown)
                      }`}>
                        {selectedProvider.isHealthy ? 'Healthy' : (selectedProvider.status === 'error' ? 'Down' : 'Unknown')}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Models:</span>
                      <span className="text-sm">{selectedProvider.capabilities?.supportedModels?.length || 0} available</span>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Usage Summary</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Total Requests:</span>
                      <span className="text-sm font-medium">{(selectedProvider.totalRequests || 0).toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Total Cost:</span>
                      <span className="text-sm font-medium">${(selectedProvider.totalCost || 0).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Success Rate:</span>
                      <span className="text-sm font-medium">
                        {selectedProvider.totalRequests > 0
                          ? (((selectedProvider.successfulRequests || 0) / selectedProvider.totalRequests) * 100).toFixed(1)
                          : '100.0'}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-muted-foreground">Last Used:</span>
                      <span className="text-sm">
                        {selectedProvider.lastRequestAt
                          ? new Date(selectedProvider.lastRequestAt).toLocaleString()
                          : 'Never'}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="models" className="space-y-4">
              <div className="space-y-3">
                {selectedProvider.capabilities?.supportedModels && selectedProvider.capabilities.supportedModels.length > 0 ? (
                  selectedProvider.capabilities.supportedModels.map((modelName, index) => (
                    <Card key={index}>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <h4 className="font-medium">{modelName}</h4>
                            <Badge variant="default">Available</Badge>
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {(selectedProvider.capabilities as any)?.maxTokens?.toLocaleString() || 'N/A'} tokens
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <div className="text-sm font-medium">Capabilities</div>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {(selectedProvider.capabilities as any)?.supportsFunctionCalling && (
                                <Badge variant="outline" className="text-xs">Function Calling</Badge>
                              )}
                              {(selectedProvider.capabilities as any)?.supportsStreaming && (
                                <Badge variant="outline" className="text-xs">Streaming</Badge>
                              )}
                              {(selectedProvider.capabilities as any)?.supportsToolUse && (
                                <Badge variant="outline" className="text-xs">Tool Use</Badge>
                              )}
                              {(selectedProvider.capabilities as any)?.supportsVision && (
                                <Badge variant="outline" className="text-xs">Vision</Badge>
                              )}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <div className="text-sm text-muted-foreground text-center py-8">
                    No model information available
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="usage" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Performance Metrics</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="text-center">
                        <div className="text-2xl font-bold">
                          {selectedProvider.lastRequestAt ? 'Active' : 'Inactive'}
                        </div>
                        <div className="text-sm text-muted-foreground">Status</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold">
                          {selectedProvider.isHealthy ? '\u2713' : '\u2717'}
                        </div>
                        <div className="text-sm text-muted-foreground">Health</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Cost Breakdown</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Total Tokens:</span>
                        <span>{(selectedProvider.totalTokensUsed || 0).toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Avg Cost/Request:</span>
                        <span>
                          ${selectedProvider.totalRequests > 0
                            ? ((selectedProvider.totalCost || 0) / selectedProvider.totalRequests).toFixed(4)
                            : '0.0000'}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span>Total Cost:</span>
                        <span>${(selectedProvider.totalCost || 0).toFixed(2)}</span>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {providerMetrics && (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Usage by Model</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {providerMetrics.usageByModel.map((modelUsage, index) => (
                          <div key={index} className="flex justify-between items-center">
                            <span className="text-sm">{modelUsage.model}</span>
                            <div className="text-right">
                              <div className="text-sm font-medium">${modelUsage.cost.toFixed(2)}</div>
                              <div className="text-xs text-muted-foreground">
                                {modelUsage.requests} reqs
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>

                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Error Analysis</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        {providerMetrics.topErrors.map((error, index) => (
                          <div key={index} className="flex justify-between items-center">
                            <span className="text-sm">{error.error}</span>
                            <div className="text-right">
                              <Badge variant="destructive" className="text-xs">{error.count}</Badge>
                              <div className="text-xs text-muted-foreground">
                                {new Date(error.lastOccurred).toLocaleString()}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </>
              )}
            </TabsContent>

            <TabsContent value="configuration" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">API Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <CredentialPicker
                    label="API Key"
                    value={providerCredentialId}
                    onSelect={(id) => setProviderCredentialId(id)}
                    onNewKey={(key) => setProviderApiKey(key)}
                    newKeyValue={providerApiKey || selectedProvider.configuration.apiKey || ''}
                    filterType="api_key"
                  />
                  <div>
                    <Label>Base URL</Label>
                    <Input
                      value={selectedProvider.configuration.baseUrl || ''}
                      readOnly
                    />
                  </div>
                  {selectedProvider.configuration.region && (
                    <div>
                      <Label>Region</Label>
                      <Input
                        value={selectedProvider.configuration.region}
                        readOnly
                      />
                    </div>
                  )}
                  <div>
                    <Label>Default Model</Label>
                    <Input
                      value={selectedProvider.configuration.model || ''}
                      readOnly
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <Label>Max Tokens</Label>
                      <Input
                        value={selectedProvider.configuration.maxTokens || ''}
                        readOnly
                      />
                    </div>
                    <div>
                      <Label>Temperature</Label>
                      <Input
                        value={selectedProvider.configuration.temperature || ''}
                        readOnly
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {selectedProvider.configuration.customHeaders && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Custom Headers</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {Object.entries(selectedProvider.configuration.customHeaders).map(([key, value], index) => (
                        <div key={index} className="flex gap-2">
                          <Input value={key} readOnly className="flex-1" />
                          <Input value={value} readOnly className="flex-1" />
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="monitoring" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Health Status</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center gap-2">
                      {selectedProvider.isHealthy ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : selectedProvider.status === 'error' ? (
                        <XCircle className="h-4 w-4 text-red-500" />
                      ) : (
                        <Activity className="h-4 w-4 text-muted-foreground" />
                      )}
                      <span className="capitalize font-medium">
                        {selectedProvider.isHealthy ? 'Healthy' : (selectedProvider.status === 'error' ? 'Down' : 'Unknown')}
                      </span>
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Last check: {selectedProvider.lastHealthCheckAt
                        ? new Date(selectedProvider.lastHealthCheckAt).toLocaleString()
                        : 'Never'}
                    </div>
                    <div className="text-sm">
                      Status: {selectedProvider.status}
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Recent Errors</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selectedProvider.lastError ? (
                      <div className="border-l-2 border-red-200 pl-3">
                        <div className="text-sm font-medium text-red-600">{selectedProvider.lastError}</div>
                        <div className="text-xs text-muted-foreground">
                          Last error occurred
                        </div>
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
                      onClick={onOpenTestDialog}
                      className="gap-2"
                    >
                      <TestTube className="h-4 w-4" />
                      Test Provider
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        // Refresh health check
                      }}
                      className="gap-2"
                    >
                      <RefreshCw className="h-4 w-4" />
                      Refresh Health
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleProviderStatusMutation.mutate({
                        providerId: selectedProvider.id,
                        status: selectedProvider.status === 'active' ? 'inactive' : 'active'
                      })}
                      className="gap-2"
                    >
                      {selectedProvider.status === 'active' ? (
                        <>
                          <PowerOff className="h-4 w-4" />
                          Disable
                        </>
                      ) : (
                        <>
                          <Power className="h-4 w-4" />
                          Enable
                        </>
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* Chat Tab */}
            <TabsContent value="chat" className="space-y-4">
              {/* Session info */}
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  {chatSessionId ? (
                    <span>Session: <code className="font-mono text-xs">{chatSessionId.slice(0, 8)}...</code></span>
                  ) : (
                    <span>New conversation</span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setChatMessages([])
                    setChatSessionId(null)
                    setChatInput('')
                  }}
                  className="gap-1"
                >
                  <RotateCcw className="h-3 w-3" />
                  New Chat
                </Button>
              </div>

              {/* Messages area */}
              <div className="border rounded-lg h-[400px] flex flex-col">
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {chatMessages.length === 0 && (
                    <div className="text-sm text-muted-foreground text-center py-12">
                      Send a message to start chatting with {selectedProvider.name}.
                      <br />
                      <span className="text-xs">Model: {selectedProvider.configuration?.model || 'default'}</span>
                    </div>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : msg.role === 'tool'
                          ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
                          : 'bg-muted'
                      }`}>
                        {msg.role === 'tool' && (
                          <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">
                            Tool: {msg.toolCallId || 'call'}
                          </div>
                        )}
                        {msg.content && (
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                        )}
                        {msg.toolCalls && msg.toolCalls.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {msg.toolCalls.map((tc: any, j: number) => (
                              <div key={j} className="text-xs bg-background/50 rounded p-2 border">
                                <div className="font-medium">{tc.function?.name || tc.name || 'tool_call'}</div>
                                <pre className="text-xs mt-1 overflow-x-auto">
                                  {JSON.stringify(tc.function?.arguments || tc.arguments || tc, null, 2).slice(0, 300)}
                                </pre>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                  {isSending && (
                    <div className="flex justify-start">
                      <div className="bg-muted rounded-lg px-3 py-2 text-sm text-muted-foreground">
                        Thinking...
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input area */}
                <div className="border-t p-3">
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault()
                      if (!chatInput.trim() || isSending || !selectedProvider) return

                      const userMessage = chatInput.trim()
                      setChatInput('')

                      // Add user message
                      const newMessages = [...chatMessages, { role: 'user' as const, content: userMessage }]
                      setChatMessages(newMessages)
                      setIsSending(true)

                      // Scroll to bottom
                      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)

                      try {
                        const response = await llmProvidersApi.chat(selectedProvider.id, {
                          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
                          sessionId: chatSessionId || undefined,
                        })

                        const data = response
                        const assistantMsg = data?.message

                        if (assistantMsg) {
                          setChatMessages(prev => [...prev, {
                            role: 'assistant',
                            content: assistantMsg.content || '',
                            toolCalls: assistantMsg.toolCalls,
                          }])
                        }

                        if (data?.sessionId) {
                          setChatSessionId(data.sessionId)
                        }
                      } catch (err: any) {
                        setChatMessages(prev => [...prev, {
                          role: 'assistant',
                          content: `Error: ${err.response?.data?.message || err.message || 'Failed to get response'}`,
                        }])
                      } finally {
                        setIsSending(false)
                        setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
                      }
                    }}
                    className="flex gap-2"
                  >
                    <Textarea
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      placeholder="Send a message..."
                      className="min-h-[40px] max-h-[120px] resize-none"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          e.currentTarget.form?.requestSubmit()
                        }
                      }}
                    />
                    <Button type="submit" size="sm" disabled={!chatInput.trim() || isSending} className="self-end">
                      <Send className="h-4 w-4" />
                    </Button>
                  </form>
                </div>
              </div>

              {/* Usage info */}
              <div className="text-xs text-muted-foreground">
                Provider: {selectedProvider.type} | Model: {selectedProvider.configuration?.model || 'default'} | Enter to send, Shift+Enter for newline
              </div>
            </TabsContent>
          </Tabs>
        )}
      </SheetContent>
    </Sheet>
  )
}
