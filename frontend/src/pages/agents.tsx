import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  Bot,
  Plus,
  MessageSquare,
  Zap,
  Globe,
  Wrench,
  Brain,
  ExternalLink,
  Copy,
  ChevronRight,
  ChevronLeft,
  Check,
  Sparkles,
  Server,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { llmProvidersApi, toolsApi, gatewaysApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'

const gatewayTypeLabels: Record<string, string> = {
  mcp: 'MCP Protocol',
  utcp: 'UTCP Protocol',
  a2a: 'A2A Protocol',
  skills: 'Skills Export',
}

const gatewayTypeDescriptions: Record<string, string> = {
  mcp: 'JSON-RPC 2.0 for MCP-compatible clients (Claude Desktop, Cursor, etc.)',
  utcp: 'Universal HTTP endpoint for any client',
  a2a: 'Agent-to-agent communication protocol',
  skills: 'Generate SKILL.md files for coding agents',
}

export function AgentsPage() {
  const { currentOrganization } = useOrganizationStore()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const notifications = useNotifications()

  // Wizard state
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState(0)
  const [agentName, setAgentName] = useState('')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([])
  const [selectedGatewayType, setSelectedGatewayType] = useState<string>('mcp')
  const [toolSearch, setToolSearch] = useState('')

  // Fetch data
  const { data: gateways = [], isLoading: loadingGateways } = useQuery({
    queryKey: ['gateways', currentOrganization?.id],
    queryFn: async () => {
      const response = await gatewaysApi.getAll()
      const d = response.data?.data || response.data
      const result = d?.gateways || d
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })

  const { data: providers = [], isLoading: loadingProviders } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      const response = await llmProvidersApi.getAll()
      const d = response.data?.data || response.data
      const result = d?.providers || d
      return Array.isArray(result) ? result : []
    },
  })

  const { data: tools = [], isLoading: loadingTools } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: async () => {
      const response = await toolsApi.getAll(currentOrganization?.id)
      const d = response.data?.data || response.data
      const result = d?.tools || d
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization,
  })

  // Create agent mutation (creates a gateway + assigns tools)
  const createAgentMutation = useMutation({
    mutationFn: async () => {
      // 1. Create gateway
      // Build configuration based on gateway type
      const configByType: Record<string, any> = {
        mcp: { transport: 'http' },
        utcp: { protocol: 'http' },
        a2a: { agentCapabilities: {} },
        skills: { format: 'skill-md' },
      }
      // Generate endpoint slug from agent name
      const endpoint = '/' + agentName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      const gatewayResponse = await gatewaysApi.create({
        name: agentName,
        type: selectedGatewayType,
        endpoint,
        description: `Agent created with ${selectedToolIds.length} tools`,
        configuration: configByType[selectedGatewayType] || { transport: 'http' },
      })
      const gateway = gatewayResponse.data?.data || gatewayResponse.data
      const gatewayId = gateway?.id

      // 2. Assign tools
      if (gatewayId && selectedToolIds.length > 0) {
        await gatewaysApi.bulkAssignTools(gatewayId, selectedToolIds)
      }

      return gateway
    },
    onSuccess: (gateway) => {
      queryClient.invalidateQueries({ queryKey: ['gateways'] })
      notifications.success('Agent Created', `${agentName} is ready to use`)
      resetWizard()
      if (gateway?.id) {
        navigate(`/gateways/${gateway.id}`)
      }
    },
    onError: (error: any) => {
      notifications.error('Error', error.response?.data?.message || 'Failed to create agent')
    },
  })

  const resetWizard = () => {
    setIsCreateOpen(false)
    setWizardStep(0)
    setAgentName('')
    setSelectedProviderId(null)
    setSelectedToolIds([])
    setSelectedGatewayType('mcp')
    setToolSearch('')
  }

  const activeProviders = providers.filter((p: any) => p.status === 'active')
  const selectedProvider = providers.find((p: any) => p.id === selectedProviderId)

  const filteredTools = tools.filter((tool: any) => {
    if (!toolSearch) return true
    return tool.name.toLowerCase().includes(toolSearch.toLowerCase()) ||
           (tool.description || '').toLowerCase().includes(toolSearch.toLowerCase())
  })

  const toggleTool = (toolId: string) => {
    setSelectedToolIds(prev =>
      prev.includes(toolId) ? prev.filter(id => id !== toolId) : [...prev, toolId]
    )
  }

  // Treat gateways as "agents" - each gateway with tools is an agent
  const agents = gateways.map((gw: any) => ({
    ...gw,
    toolCount: gw.toolCount || gw.tools?.length || 0,
  }))

  const isLoading = loadingGateways || loadingProviders || loadingTools

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agents</h1>
          <p className="text-muted-foreground">
            Compose AI agents from your tools and LLM providers
          </p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" />
          Create Agent
        </Button>
      </div>

      {/* Agents Grid */}
      {agents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <Bot className="h-16 w-16 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Agents Yet</h3>
            <p className="text-sm text-muted-foreground text-center max-w-md mb-6">
              Agents combine your tools with an LLM provider and serve them via a protocol endpoint.
              Create your first agent to get started.
            </p>
            <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Create Your First Agent
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {agents.map((agent: any) => (
            <Card
              key={agent.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => navigate(`/gateways/${agent.id}`)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
                      <Bot className="h-5 w-5 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{agent.name}</CardTitle>
                      <CardDescription className="text-xs">
                        {agent.description || 'No description'}
                      </CardDescription>
                    </div>
                  </div>
                  <Badge variant={agent.status === 'active' ? 'default' : 'secondary'}>
                    {agent.status}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1 text-muted-foreground">
                      <Wrench className="h-3.5 w-3.5" />
                      <span>{agent.toolCount} tools</span>
                    </div>
                    <Badge variant="outline" className="text-xs uppercase">
                      {agent.type}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        navigate('/chat')
                      }}
                      className="h-7 px-2"
                    >
                      <MessageSquare className="h-3.5 w-3.5 mr-1" />
                      Chat
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Agent Wizard Dialog */}
      <Dialog open={isCreateOpen} onOpenChange={(open) => {
        if (!open) resetWizard()
        else setIsCreateOpen(true)
      }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Agent</DialogTitle>
            <DialogDescription>
              {wizardStep === 0 && 'Name your agent and select an LLM provider.'}
              {wizardStep === 1 && 'Choose which tools the agent can use.'}
              {wizardStep === 2 && 'Select how the agent will be accessed.'}
            </DialogDescription>
          </DialogHeader>

          {/* Step indicators */}
          <div className="flex items-center gap-2 mb-4">
            {[0, 1, 2].map((step) => (
              <div key={step} className="flex items-center gap-2">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                  step < wizardStep ? 'bg-green-100 text-green-700' :
                  step === wizardStep ? 'bg-primary text-primary-foreground' :
                  'bg-gray-100 text-gray-400'
                }`}>
                  {step < wizardStep ? <Check className="h-4 w-4" /> : step + 1}
                </div>
                {step < 2 && <div className={`w-12 h-0.5 ${step < wizardStep ? 'bg-green-300' : 'bg-gray-200'}`} />}
              </div>
            ))}
          </div>

          {/* Step 0: Name + Provider */}
          {wizardStep === 0 && (
            <div className="space-y-4">
              <div>
                <Label>Agent Name</Label>
                <Input
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  placeholder="My API Agent"
                  className="mt-1"
                />
              </div>

              <div>
                <Label>LLM Provider (optional)</Label>
                <p className="text-xs text-muted-foreground mb-2">
                  Select the AI model that powers this agent.
                </p>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {activeProviders.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-2">
                      No active providers. <a href="/llm-providers" className="text-primary underline">Configure one</a> first.
                    </p>
                  ) : (
                    activeProviders.map((provider: any) => (
                      <label
                        key={provider.id}
                        className={`flex items-center gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                          selectedProviderId === provider.id ? 'border-primary bg-primary/5' : 'hover:bg-gray-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="provider"
                          checked={selectedProviderId === provider.id}
                          onChange={() => setSelectedProviderId(provider.id)}
                          className="shrink-0"
                        />
                        <div className="flex-1">
                          <div className="font-medium text-sm">{provider.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {provider.type} · {provider.configuration?.model || 'default model'}
                          </div>
                        </div>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Select Tools */}
          {wizardStep === 1 && (
            <div className="space-y-3">
              <Input
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
                placeholder="Search tools..."
                className="mb-2"
              />

              <div className="flex justify-between items-center text-sm">
                <span className="text-muted-foreground">
                  {selectedToolIds.length} of {tools.length} selected
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedToolIds(tools.map((t: any) => t.id))}
                  >
                    Select All
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedToolIds([])}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              <div className="max-h-[300px] overflow-y-auto space-y-1 border rounded-md p-2">
                {filteredTools.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {tools.length === 0
                      ? 'No tools available. Import an API to generate tools.'
                      : 'No tools match your search.'}
                  </p>
                ) : (
                  filteredTools.map((tool: any) => (
                    <label
                      key={tool.id}
                      className="flex items-center gap-3 p-2 rounded hover:bg-gray-50 cursor-pointer"
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
                      <Badge variant="outline" className="text-xs shrink-0">{tool.type}</Badge>
                    </label>
                  ))
                )}
              </div>
            </div>
          )}

          {/* Step 2: Access Method */}
          {wizardStep === 2 && (
            <div className="space-y-3">
              {['mcp', 'utcp', 'a2a', 'skills'].map((type) => (
                <label
                  key={type}
                  className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                    selectedGatewayType === type ? 'border-primary bg-primary/5' : 'hover:bg-gray-50'
                  }`}
                >
                  <input
                    type="radio"
                    name="gatewayType"
                    checked={selectedGatewayType === type}
                    onChange={() => setSelectedGatewayType(type)}
                    className="mt-1 shrink-0"
                  />
                  <div>
                    <div className="font-medium text-sm">{gatewayTypeLabels[type]}</div>
                    <div className="text-xs text-muted-foreground">{gatewayTypeDescriptions[type]}</div>
                  </div>
                </label>
              ))}

              {/* Summary */}
              <div className="bg-gray-50 rounded-md p-3 mt-4">
                <div className="text-sm font-medium mb-2">Summary</div>
                <div className="text-xs text-muted-foreground space-y-1">
                  <div><strong>Name:</strong> {agentName || '—'}</div>
                  <div><strong>Provider:</strong> {selectedProvider?.name || 'None'}</div>
                  <div><strong>Tools:</strong> {selectedToolIds.length} selected</div>
                  <div><strong>Access:</strong> {gatewayTypeLabels[selectedGatewayType]}</div>
                </div>
              </div>
            </div>
          )}

          {/* Navigation buttons */}
          <div className="flex justify-between pt-4">
            <Button
              variant="outline"
              onClick={() => wizardStep > 0 ? setWizardStep(wizardStep - 1) : resetWizard()}
              className="gap-1"
            >
              {wizardStep > 0 ? (
                <><ChevronLeft className="h-4 w-4" /> Back</>
              ) : (
                'Cancel'
              )}
            </Button>

            {wizardStep < 2 ? (
              <Button
                onClick={() => setWizardStep(wizardStep + 1)}
                disabled={wizardStep === 0 && !agentName.trim()}
                className="gap-1"
              >
                Next <ChevronRight className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                onClick={() => createAgentMutation.mutate()}
                disabled={!agentName.trim() || createAgentMutation.isPending}
                className="gap-1"
              >
                {createAgentMutation.isPending ? (
                  <>
                    <LoadingSpinner size="sm" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Bot className="h-4 w-4" />
                    Create Agent
                  </>
                )}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
