import React, { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Send,
  RotateCcw,
  Bot,
  User,
  ChevronDown,
  Wrench,
  Plus,
  MessageSquare,
  X,
  Sparkles,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { llmProvidersApi, toolsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'

interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: any[]
  toolCallId?: string
  timestamp?: string
}

interface ChatSession {
  id: string
  providerId: string
  providerName: string
  messages: ChatMessage[]
  createdAt: string
  title: string
}

export function ChatPage() {
  useEffect(() => {
    document.title = 'Chat | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const notifications = useNotifications()

  // Provider state
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isSending, setIsSending] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)

  // Tool selection state
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([])
  const [isToolPickerOpen, setIsToolPickerOpen] = useState(false)

  // Session history state
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeSidebarSession, setActiveSidebarSession] = useState<string | null>(null)

  // Fetch providers
  const { data: providersRaw, isLoading: loadingProviders } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const response = await llmProvidersApi.getAll()
      const d = response.data
      const result = d?.providers || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
  })
  const providers = Array.isArray(providersRaw) ? providersRaw : []

  // Fetch tools
  const { data: toolsRaw, isLoading: loadingTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const response = await toolsApi.getAll(currentOrganization?.id)
      const d = response.data
      const result = d?.tools || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })
  const tools = Array.isArray(toolsRaw) ? toolsRaw : []

  // Auto-select first active provider
  useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      const activeProvider = providers.find((p: any) => p.status === 'active') || providers[0]
      setSelectedProviderId(activeProvider.id)
    }
  }, [providers, selectedProviderId])

  // Scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isSending])

  const selectedProvider = providers.find((p: any) => p.id === selectedProviderId)
  const activeProviders = providers.filter((p: any) => p.status === 'active')

  const handleNewChat = () => {
    // Save current session to history if it has messages
    if (messages.length > 0 && selectedProvider) {
      const title = messages[0]?.content?.slice(0, 50) || 'New chat'
      setSessions(prev => [{
        id: sessionId || Date.now().toString(),
        providerId: selectedProvider.id,
        providerName: selectedProvider.name,
        messages: [...messages],
        createdAt: new Date().toISOString(),
        title,
      }, ...prev])
    }

    setMessages([])
    setSessionId(null)
    setInput('')
    setActiveSidebarSession(null)
  }

  const handleRestoreSession = (session: ChatSession) => {
    // Save current chat first
    if (messages.length > 0 && selectedProvider && activeSidebarSession !== session.id) {
      const title = messages[0]?.content?.slice(0, 50) || 'New chat'
      setSessions(prev => {
        const existing = prev.find(s => s.id === (sessionId || activeSidebarSession))
        if (existing) {
          return prev.map(s => s.id === existing.id ? { ...s, messages: [...messages] } : s)
        }
        return [{
          id: sessionId || Date.now().toString(),
          providerId: selectedProvider.id,
          providerName: selectedProvider.name,
          messages: [...messages],
          createdAt: new Date().toISOString(),
          title,
        }, ...prev]
      })
    }

    setMessages(session.messages)
    setSessionId(session.id)
    setSelectedProviderId(session.providerId)
    setActiveSidebarSession(session.id)
  }

  const handleSend = async () => {
    if (!input.trim() || isSending || !selectedProvider) return

    const userMessage = input.trim()
    setInput('')

    const newMessages: ChatMessage[] = [...messages, {
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString(),
    }]
    setMessages(newMessages)
    setIsSending(true)

    try {
      const response = await llmProvidersApi.chat(selectedProvider.id, {
        messages: newMessages.map(m => ({ role: m.role, content: m.content })),
        sessionId: sessionId || undefined,
        ...(selectedToolIds.length > 0 && { toolIds: selectedToolIds }),
      })

      const data = response.data
      const assistantMsg = data?.message

      if (assistantMsg) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: assistantMsg.content || '',
          toolCalls: assistantMsg.toolCalls,
          timestamp: new Date().toISOString(),
        }])
      }

      if (data?.sessionId) {
        setSessionId(data.sessionId)
      }
    } catch (err: any) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Error: ${err.response?.data?.message || err.message || 'Failed to get response'}`,
        timestamp: new Date().toISOString(),
      }])
    } finally {
      setIsSending(false)
    }
  }

  const toggleTool = (toolId: string) => {
    setSelectedToolIds(prev =>
      prev.includes(toolId) ? prev.filter(id => id !== toolId) : [...prev, toolId]
    )
  }

  if (loadingProviders) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  // Empty state — no providers configured
  if (providers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-200px)]">
        <Bot className="h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">No AI Models Configured</h2>
        <p className="text-muted-foreground text-center max-w-md mb-4">
          To start chatting, configure at least one AI model provider (OpenAI, Anthropic, etc.) in the AI Models page.
        </p>
        <Button onClick={() => window.location.href = '/llm-providers'}>
          Configure AI Models
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-[calc(100vh-140px)] -mx-4 sm:-mx-6 lg:-mx-8 -my-6">
      {/* Session Sidebar */}
      <div className="w-64 border-r bg-muted/50 flex flex-col shrink-0">
        <div className="p-3 border-b">
          <Button onClick={handleNewChat} className="w-full gap-2" size="sm">
            <Plus className="h-4 w-4" />
            New Chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sessions.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-8 px-2">
              Your chat sessions will appear here
            </div>
          ) : (
            sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => handleRestoreSession(session)}
                className={`w-full text-left p-2 rounded-md text-sm hover:bg-accent transition-colors ${
                  activeSidebarSession === session.id ? 'bg-accent font-medium' : ''
                }`}
              >
                <div className="truncate">{session.title}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {session.providerName} · {new Date(session.createdAt).toLocaleDateString()}
                </div>
              </button>
            ))
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <div className="border-b px-4 py-2 flex items-center justify-between bg-background">
          <div className="flex items-center gap-3">
            {/* Provider Selector */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Sparkles className="h-4 w-4" />
                  {selectedProvider?.name || 'Select Provider'}
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Active Providers</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {activeProviders.map((provider: any) => (
                  <DropdownMenuItem
                    key={provider.id}
                    onClick={() => setSelectedProviderId(provider.id)}
                  >
                    <div className="flex items-center justify-between w-full">
                      <span>{provider.name}</span>
                      {provider.id === selectedProviderId && (
                        <Badge variant="secondary" className="text-xs ml-2">Active</Badge>
                      )}
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {selectedProvider && (
              <span className="text-xs text-muted-foreground">
                {selectedProvider.type} · {selectedProvider.configuration?.model || 'default model'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Tool Selector */}
            <Dialog open={isToolPickerOpen} onOpenChange={setIsToolPickerOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Wrench className="h-4 w-4" />
                  Tools
                  {selectedToolIds.length > 0 && (
                    <Badge variant="secondary" className="text-xs">
                      {selectedToolIds.length}
                    </Badge>
                  )}
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Attach Tools</DialogTitle>
                </DialogHeader>
                <p className="text-sm text-muted-foreground mb-3">
                  Select tools the AI can use during the conversation.
                </p>
                <div className="max-h-[400px] overflow-y-auto space-y-1">
                  {loadingTools ? (
                    <div className="text-center py-4"><LoadingSpinner /></div>
                  ) : tools.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">No tools available</p>
                  ) : (
                    tools.map((tool: any) => (
                      <label
                        key={tool.id}
                        className="flex items-center gap-3 p-2 rounded-md hover:bg-accent cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedToolIds.includes(tool.id)}
                          onChange={() => toggleTool(tool.id)}
                          className="rounded"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{tool.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {tool.description || 'No description'}
                          </div>
                        </div>
                        <Badge variant="outline" className="text-xs shrink-0">
                          {tool.type}
                        </Badge>
                      </label>
                    ))
                  )}
                </div>
                {selectedToolIds.length > 0 && (
                  <div className="flex justify-between items-center pt-2 border-t">
                    <span className="text-xs text-muted-foreground">
                      {selectedToolIds.length} tool{selectedToolIds.length !== 1 ? 's' : ''} selected
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedToolIds([])}
                    >
                      Clear all
                    </Button>
                  </div>
                )}
              </DialogContent>
            </Dialog>

            <Button variant="ghost" size="sm" onClick={handleNewChat} className="gap-1">
              <RotateCcw className="h-3 w-3" />
              New Chat
            </Button>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Bot className="h-12 w-12 text-muted-foreground mb-3" />
              <h3 className="text-lg font-medium mb-1">Start a conversation</h3>
              <p className="text-sm text-muted-foreground max-w-md">
                Chat with {selectedProvider?.name || 'your AI provider'}.
                {selectedToolIds.length > 0
                  ? ` ${selectedToolIds.length} tool${selectedToolIds.length !== 1 ? 's' : ''} attached for agentic use.`
                  : ' Attach tools to enable agentic capabilities.'}
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {msg.role !== 'user' && (
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0">
                  <Bot className="h-4 w-4 text-white" />
                </div>
              )}
              <div className={`max-w-[70%] rounded-lg px-4 py-3 ${
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : msg.role === 'tool'
                  ? 'bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800'
                  : 'bg-muted'
              }`}>
                {msg.role === 'tool' && (
                  <div className="text-xs font-medium text-amber-600 dark:text-amber-400 mb-1 flex items-center gap-1">
                    <Wrench className="h-3 w-3" />
                    Tool: {msg.toolCallId || 'call'}
                  </div>
                )}
                {msg.content && (
                  <div className="whitespace-pre-wrap text-sm">{msg.content}</div>
                )}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {msg.toolCalls.map((tc: any, j: number) => (
                      <Card key={j} className="p-2 bg-background/50">
                        <div className="text-xs font-medium flex items-center gap-1">
                          <Wrench className="h-3 w-3 text-amber-500" />
                          {tc.function?.name || tc.name || 'tool_call'}
                        </div>
                        <pre className="text-xs mt-1 overflow-x-auto text-muted-foreground">
                          {JSON.stringify(tc.function?.arguments || tc.arguments || tc, null, 2).slice(0, 500)}
                        </pre>
                      </Card>
                    ))}
                  </div>
                )}
              </div>
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                  <User className="h-4 w-4 text-muted-foreground" />
                </div>
              )}
            </div>
          ))}

          {isSending && (
            <div className="flex gap-3 justify-start">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0">
                <Bot className="h-4 w-4 text-white" />
              </div>
              <div className="bg-muted rounded-lg px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoadingSpinner size="sm" />
                  Thinking...
                </div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input Area */}
        <div className="border-t p-4 bg-background">
          {selectedToolIds.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {selectedToolIds.map(toolId => {
                const tool = tools.find((t: any) => t.id === toolId)
                return tool ? (
                  <Badge key={toolId} variant="secondary" className="text-xs gap-1">
                    <Wrench className="h-3 w-3" />
                    {tool.name}
                    <button onClick={() => toggleTool(toolId)} className="ml-1 hover:text-destructive">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ) : null
              })}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              handleSend()
            }}
            className="flex gap-2"
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={selectedProvider ? `Message ${selectedProvider.name}...` : 'Select a provider to start chatting...'}
              disabled={!selectedProvider || isSending}
              className="min-h-[44px] max-h-[200px] resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <Button
              type="submit"
              disabled={!input.trim() || isSending || !selectedProvider}
              className="self-end"
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
          <div className="text-xs text-muted-foreground mt-1">
            Enter to send · Shift+Enter for newline
            {selectedProvider && ` · ${selectedProvider.type} · ${selectedProvider.configuration?.model || 'default'}`}
          </div>
        </div>
      </div>
    </div>
  )
}
