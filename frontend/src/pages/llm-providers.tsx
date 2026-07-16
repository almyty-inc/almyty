import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Plus, Search, Brain } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useCreateDeepLink } from '@/hooks/use-create-deep-link'
import { useCopySensitive } from '@/lib/clipboard'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DataTable } from '@/components/ui/data-table'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { llmProvidersApi } from '@/lib/api'
import { pluralized } from '@/lib/utils'
import { TeamFilter, useTeamLookup, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import { CreateProviderDialog } from '@/components/llm-providers/create-provider-dialog'
import { EditProviderDialog } from '@/components/llm-providers/edit-provider-dialog'
import { TestProviderDialog } from '@/components/llm-providers/test-provider-dialog'
import {
  createProviderSchema,
  type CreateProviderFormData,
  type LlmProvider,
} from '@/components/llm-providers/schema'
import { buildProviderColumns } from '@/components/llm-providers/columns'

export function LlmProvidersPage() {
  useEffect(() => {
    document.title = 'AI Models | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const navigate = useNavigate()
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  // Honour ?new=1 from the command palette Add Provider action.
  useCreateDeepLink(setIsCreateDialogOpen)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [providerToEdit, setProviderToEdit] = useState<LlmProvider | null>(null)
  const [providerToDelete, setProviderToDelete] = useState<LlmProvider | null>(null)
  const [testProvider, setTestProvider] = useState<LlmProvider | null>(null)
  const [isTestDialogOpen, setIsTestDialogOpen] = useState(false)
  const [testInput, setTestInput] = useState('Hello, can you help me test this connection?')
  const [testResult, setTestResult] = useState<any>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')
  const { currentOrganization } = useOrganizationStore()
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  // Dynamic model fetching state
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)

  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const copySensitive = useCopySensitive()

  const { data: providersRaw, isLoading, isError, error, refetch: refetchProviders } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      try {
        const d = await llmProvidersApi.getAll()
        const result = d?.providers || (Array.isArray(d) ? d : [])
        return Array.isArray(result) ? result : []
      } catch (err) {
        console.error('Failed to fetch AI models:', err)
        return []
      }
    }
  })
  const providers = Array.isArray(providersRaw) ? providersRaw : []

  // Provider metrics now live on the detail page (/llm-providers/:id)

  const testProviderMutation = useMutation({
    mutationFn: async ({ providerId, input }: { providerId: string; input: string }) => {
      setTestLoading(true)
      const response = await llmProvidersApi.test(providerId)
      return response
    },
    onSuccess: (responseData) => {
      // API returns clean data directly
      const result = responseData.data || responseData
      setTestResult({
        output: {
          response: result.response || result.message || 'Connection successful',
          usage: result.usage || { inputTokens: 0, outputTokens: 0 },
          cost: result.cost || 0,
          responseTime: result.responseTime || result.latency || 0
        },
        timestamp: new Date().toISOString()
      })
      setTestLoading(false)
      notifications.success('Test Complete', 'Provider connection successful')
    },
    onError: (error: any) => {
      setTestResult({
        error: error.response?.data?.message || error.message,
        timestamp: new Date().toISOString()
      })
      setTestLoading(false)
      notifications.error('Test Failed', error.response?.data?.message || 'Provider connection failed')
    }
  })

  const deleteProviderMutation = useMutation({
    mutationFn: async (providerId: string) => {
      await llmProvidersApi.delete(providerId)
      return providerId
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      notifications.success('Deleted', 'Provider removed successfully')
    },
    onError: (error: any) => {
      notifications.error('Error', error.response?.data?.message || 'Failed to delete provider')
    }
  })

  const toggleProviderStatusMutation = useMutation({
    mutationFn: async ({ providerId, status }: { providerId: string; status: string }) => {
      return llmProvidersApi.update(providerId, { status })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      notifications.success('Updated', 'Provider status changed')
    },
    onError: (error: any) => {
      notifications.error('Error', error.response?.data?.message || 'Failed to update provider')
    }
  })

  // Form hook for create provider
  const createForm = useForm<CreateProviderFormData>({
    resolver: zodResolver(createProviderSchema),
    defaultValues: {
      name: '',
      type: '',
      apiKey: '',
      apiUrl: '',
      organizationId: '',
    }
  })

  // Form hook for edit provider
  const editForm = useForm<any>({
    defaultValues: {
      name: '',
      model: '',
      maxTokens: 4096,
      temperature: 0.7,
      usageApiKey: '',
    }
  })

  const createProviderMutation = useMutation({
    mutationFn: async (data: CreateProviderFormData) => {
      try {
        return await llmProvidersApi.create({
          name: data.name,
          type: data.type,
          configuration: {
            // Ollama is keyless — only send the key when one was typed
            // (the zod schema enforces presence for all other types).
            ...(data.apiKey && { apiKey: data.apiKey }),
            // Optional server URL (Ollama base URL field).
            ...(data.apiUrl && { apiUrl: data.apiUrl }),
            ...(data.organizationId && { organizationId: data.organizationId }),
            // Admin-scoped usage/cost API key (issue #241) — only sent
            // when the user actually entered one.
            ...(data.usageApiKey && { usageApiKey: data.usageApiKey }),
          }
        })
      } catch (error) {
        console.error('Create provider error:', error)
        throw error
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      setIsCreateDialogOpen(false)
      createForm.reset()
      notifications.success('Provider added', 'AI model provider connected successfully')
    },
    onError: (error: any) => {
      console.error('Create provider mutation error:', error)
      notifications.error('Error', error.response?.data?.message || 'Failed to add provider')
    }
  })

  const updateProviderMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      return llmProvidersApi.update(id, {
        name: data.name,
        configuration: {
          model: data.model,
          maxTokens: data.maxTokens,
          temperature: data.temperature,
          // Only send the admin usage key when a new one was typed —
          // an empty field means "keep the existing (encrypted) key".
          ...(data.usageApiKey && { usageApiKey: data.usageApiKey }),
        }
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      setIsEditDialogOpen(false)
      setProviderToEdit(null)
      notifications.success('Updated', 'Provider configuration updated successfully')
    },
    onError: (error: any) => {
      notifications.error('Error', error.response?.data?.message || 'Failed to update provider')
    }
  })

  const filteredProviders = filterByTeamVisibility(providers as any[], teamFilter).filter((provider: any) => {
    const matchesSearch = provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         (provider.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                         provider.type.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === 'all' || provider.status === statusFilter
    const matchesType = typeFilter === 'all' || provider.type === typeFilter
    return matchesSearch && matchesStatus && matchesType
  })

  const handleTestProvider = () => {
    if (!testProvider) return
    testProviderMutation.mutate({ providerId: testProvider.id, input: testInput })
  }

  const totalCost = providers.reduce((sum: number, provider: any) => sum + (provider.totalCost || 0), 0)
  const totalRequests = providers.reduce((sum: number, provider: any) => sum + (provider.totalRequests || 0), 0)

  const columns = buildProviderColumns({
    navigate,
    setProviderToDelete,
    setTestProvider,
    setIsTestDialogOpen,
    setProviderToEdit,
    editForm,
    setIsEditDialogOpen,
    setModelsLoading,
    setAvailableModels,
    copySensitive,
    toggleProviderStatusMutation,
    teamLookup,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-violet-500 to-cyan-400 bg-clip-text text-transparent">AI Models</h1>
          <p className="text-muted-foreground">
            {isLoading ? <span className="inline-block w-48 h-4 bg-muted animate-pulse rounded" /> : `${pluralized(providers.length, 'provider')} (${providers.filter((p: any) => p.status === 'active').length} active) \u00B7 $${totalCost.toFixed(2)} total cost \u00B7 ${pluralized(totalRequests, 'request')}`}
          </p>
        </div>
        {/* Only show Add Provider button when not in empty state */}
        {!(!isLoading && providers.length === 0) && (
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setIsCreateDialogOpen(true)}
              className="gap-2"
            >
              <Plus className="h-4 w-4" />
              Add Provider
            </Button>
          </div>
        )}
      </div>

      {/* Providers Table or Empty State */}
      {isError ? (
        <QueryError error={error} onRetry={() => refetchProviders()} title="Couldn't load providers" />
      ) : !isLoading && providers.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={Brain}
              title="No models configured"
              description="Connect OpenAI, Anthropic, Google, Mistral, xAI, Groq, OpenRouter, Azure, AWS Bedrock, or any of 14 supported providers. Add Provider links you straight to where each vendor issues API keys, and you can test the key before saving. Agents and LLM tools need at least one model to call."
              action={
                <Button onClick={() => setIsCreateDialogOpen(true)} className="gap-2">
                  <Plus className="h-4 w-4" />
                  Add Provider
                </Button>
              }
              className="py-16"
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-4">
            {/* Filters */}
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search providers..."
                    className="pl-10"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="configuring">Configuring</SelectItem>
                </SelectContent>
              </Select>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="google">Google Gemini</SelectItem>
                  <SelectItem value="mistral">Mistral AI</SelectItem>
                  <SelectItem value="xai">xAI</SelectItem>
                  <SelectItem value="deepseek">DeepSeek</SelectItem>
                  <SelectItem value="groq">Groq</SelectItem>
                  <SelectItem value="together">Together AI</SelectItem>
                  <SelectItem value="openrouter">OpenRouter</SelectItem>
                  <SelectItem value="azure_openai">Azure OpenAI</SelectItem>
                  <SelectItem value="aws_bedrock">AWS Bedrock</SelectItem>
                  <SelectItem value="cohere">Cohere</SelectItem>
                  <SelectItem value="huggingface">HuggingFace</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
              <TeamFilter
                organizationId={currentOrganization?.id}
                value={teamFilter}
                onChange={setTeamFilter}
              />
            </div>
            <DataTable
              columns={columns}
              data={filteredProviders}
              loading={isLoading}
              onRowClick={(provider) => navigate(`/llm-providers/${provider.id}`)}
            />
          </CardContent>
        </Card>
      )}

      {/* Create Provider Dialog */}
      <CreateProviderDialog
        open={isCreateDialogOpen}
        onOpenChange={setIsCreateDialogOpen}
        createForm={createForm}
        createProviderMutation={createProviderMutation}
      />

      {/* Edit Provider Dialog */}
      <EditProviderDialog
        open={isEditDialogOpen}
        onOpenChange={setIsEditDialogOpen}
        editForm={editForm}
        providerToEdit={providerToEdit}
        updateProviderMutation={updateProviderMutation}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
      />

      {/* Delete Confirmation AlertDialog */}
      <AlertDialog open={!!providerToDelete} onOpenChange={() => setProviderToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Provider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{providerToDelete?.name}&quot;? This action cannot be undone.
              All configuration and usage history will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (providerToDelete) {
                  deleteProviderMutation.mutate(providerToDelete.id)
                  setProviderToDelete(null)
                }
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Provider Test Dialog */}
      <TestProviderDialog
        open={isTestDialogOpen}
        onOpenChange={setIsTestDialogOpen}
        testProvider={testProvider}
        testInput={testInput}
        onTestInputChange={setTestInput}
        onTest={handleTestProvider}
        testLoading={testLoading}
        testResult={testResult}
      />
    </div>
  )
}
