import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import {
  Plus,
  Search,
  Activity,
  DollarSign,
  TrendingUp,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  Server,
  BarChart3,
  PieChart,
  LineChart,
  Gauge,
  Shield,
  Key,
  Timer,
  Cpu,
  Brain,
  Bot,
  MessageSquare,
  Database,
  Cloud,
  Globe,
  ExternalLink,
  RefreshCw,
  Send,
  RotateCcw
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { useCreateDeepLink } from '@/hooks/use-create-deep-link'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
// Sheet imports removed — detail view moved to /llm-providers/:id
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DataTable, createSelectColumn, createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import { useNotifications } from '@/store/app'
import { llmProvidersApi } from '@/lib/api'
import { CreateProviderDialog } from '@/components/llm-providers/create-provider-dialog'
import { EditProviderDialog } from '@/components/llm-providers/edit-provider-dialog'
import { TestProviderDialog } from '@/components/llm-providers/test-provider-dialog'
// ProviderDetailsSheet removed — now using /llm-providers/:id detail page

interface LlmProvider {
  id: string
  name: string
  description?: string
  type: 'openai' | 'anthropic' | 'google' | 'mistral' | 'xai' | 'deepseek' | 'groq' | 'together' | 'openrouter' | 'azure_openai' | 'aws_bedrock' | 'cohere' | 'huggingface' | 'custom'
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

interface Model {
  id: string
  name: string
  description: string
  maxTokens: number
  pricing: {
    input: number  // per 1K tokens
    output: number // per 1K tokens
  }
  capabilities: string[]
  status: 'available' | 'deprecated' | 'beta'
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

const statusColors = {
  active: 'bg-emerald-500',
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

// Mock providers array removed - doesn't match backend flat structure
// Backend uses flat fields: totalRequests, successfulRequests, totalCost, isHealthy, lastError, etc.
// Not nested fields like usage.totalRequests, health.status, quotas.*, etc.
/* const mockProviders: LlmProvider[] = [
  {
    id: '1',
    name: 'openai_main',
    type: 'openai',
    displayName: 'OpenAI GPT',
    description: 'OpenAI GPT models including GPT-4 and GPT-3.5',
    status: 'active',
    configuration: {
      apiKey: 'sk-***********************************',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4',
      maxTokens: 4096,
      temperature: 0.7
    },
    models: [
      {
        id: 'gpt-4',
        name: 'GPT-4',
        description: 'Most capable GPT-4 model',
        maxTokens: 8192,
        pricing: { input: 0.03, output: 0.06 },
        capabilities: ['text', 'reasoning', 'code'],
        status: 'available'
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        description: 'Fast and efficient model',
        maxTokens: 4096,
        pricing: { input: 0.001, output: 0.002 },
        capabilities: ['text', 'code'],
        status: 'available'
      }
    ],
    usage: {
      totalRequests: 45678,
      totalTokens: 12543876,
      totalCost: 1247.89,
      avgResponseTime: 892,
      successRate: 99.2,
      lastUsed: '2024-01-15T14:30:00Z'
    },
    quotas: {
      requestLimit: 10000,
      tokenLimit: 1000000,
      costLimit: 500,
      resetPeriod: 'month',
      currentUsage: {
        requests: 8543,
        tokens: 876543,
        cost: 423.45
      }
    },
    health: {
      status: 'healthy',
      responseTime: 892,
      uptime: 99.8,
      lastCheck: '2024-01-15T15:00:00Z',
      errors: []
    },
    createdAt: '2024-01-01T10:00:00Z',
    updatedAt: '2024-01-15T14:30:00Z',
    createdBy: 'user_admin'
  },
  {
    id: '2',
    name: 'anthropic_claude',
    type: 'anthropic',
    displayName: 'Anthropic Claude',
    description: 'Claude 3 models from Anthropic',
    status: 'active',
    configuration: {
      apiKey: 'sk-ant-***************************',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-20250514',
      maxTokens: 4096,
      temperature: 0.5
    },
    models: [
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        description: 'Most powerful Claude 3 model',
        maxTokens: 200000,
        pricing: { input: 0.015, output: 0.075 },
        capabilities: ['text', 'reasoning', 'analysis', 'code'],
        status: 'available'
      },
      {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        description: 'Balanced performance and speed',
        maxTokens: 200000,
        pricing: { input: 0.003, output: 0.015 },
        capabilities: ['text', 'reasoning', 'code'],
        status: 'available'
      }
    ],
    usage: {
      totalRequests: 23456,
      totalTokens: 8765432,
      totalCost: 892.34,
      avgResponseTime: 1234,
      successRate: 99.7,
      lastUsed: '2024-01-15T15:15:00Z'
    },
    quotas: {
      requestLimit: 5000,
      tokenLimit: 500000,
      costLimit: 1000,
      resetPeriod: 'month',
      currentUsage: {
        requests: 3421,
        tokens: 432109,
        cost: 567.89
      }
    },
    health: {
      status: 'healthy',
      responseTime: 1234,
      uptime: 99.9,
      lastCheck: '2024-01-15T15:00:00Z',
      errors: []
    },
    createdAt: '2024-01-02T09:00:00Z',
    updatedAt: '2024-01-15T15:15:00Z',
    createdBy: 'user_admin'
  },
  {
    id: '3',
    name: 'google_palm',
    type: 'google',
    displayName: 'Google PaLM',
    description: 'Google PaLM and Gemini models',
    status: 'active',
    configuration: {
      apiKey: 'AIza*********************************',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-pro',
      maxTokens: 2048,
      temperature: 0.8
    },
    models: [
      {
        id: 'gemini-pro',
        name: 'Gemini Pro',
        description: 'Google\'s most capable model',
        maxTokens: 30720,
        pricing: { input: 0.00025, output: 0.0005 },
        capabilities: ['text', 'multimodal', 'reasoning'],
        status: 'available'
      },
      {
        id: 'palm-2',
        name: 'PaLM 2',
        description: 'Google\'s large language model',
        maxTokens: 8192,
        pricing: { input: 0.001, output: 0.001 },
        capabilities: ['text', 'code'],
        status: 'deprecated'
      }
    ],
    usage: {
      totalRequests: 12789,
      totalTokens: 3456789,
      totalCost: 234.56,
      avgResponseTime: 678,
      successRate: 98.5,
      lastUsed: '2024-01-15T13:45:00Z'
    },
    quotas: {
      requestLimit: 20000,
      tokenLimit: 2000000,
      costLimit: 300,
      resetPeriod: 'month',
      currentUsage: {
        requests: 9876,
        tokens: 2345678,
        cost: 178.90
      }
    },
    health: {
      status: 'degraded',
      responseTime: 1456,
      uptime: 97.2,
      lastCheck: '2024-01-15T15:00:00Z',
      errors: [
        { timestamp: '2024-01-15T14:30:00Z', message: 'Rate limit exceeded' },
        { timestamp: '2024-01-15T13:15:00Z', message: 'Service temporarily unavailable' }
      ]
    },
    createdAt: '2024-01-03T11:00:00Z',
    updatedAt: '2024-01-15T13:45:00Z',
    createdBy: 'user_dev'
  },
  {
    id: '4',
    name: 'cohere_command',
    type: 'cohere',
    displayName: 'Cohere Command',
    description: 'Cohere Command models for generation and embeddings',
    status: 'active',
    configuration: {
      apiKey: 'co-***************************',
      baseUrl: 'https://api.cohere.ai',
      model: 'command-r',
      maxTokens: 4096,
      temperature: 0.6
    },
    models: [
      {
        id: 'command-r',
        name: 'Command R',
        description: 'Advanced reasoning and tool use',
        maxTokens: 128000,
        pricing: { input: 0.0015, output: 0.002 },
        capabilities: ['text', 'reasoning', 'tools'],
        status: 'available'
      },
      {
        id: 'command-r-plus',
        name: 'Command R+',
        description: 'Enhanced Command model',
        maxTokens: 128000,
        pricing: { input: 0.003, output: 0.015 },
        capabilities: ['text', 'reasoning', 'tools', 'multilingual'],
        status: 'beta'
      }
    ],
    usage: {
      totalRequests: 8765,
      totalTokens: 2345678,
      totalCost: 156.78,
      avgResponseTime: 567,
      successRate: 99.1,
      lastUsed: '2024-01-15T12:20:00Z'
    },
    quotas: {
      requestLimit: 15000,
      tokenLimit: 1500000,
      costLimit: 200,
      resetPeriod: 'month',
      currentUsage: {
        requests: 6543,
        tokens: 1876543,
        cost: 123.45
      }
    },
    health: {
      status: 'healthy',
      responseTime: 567,
      uptime: 99.5,
      lastCheck: '2024-01-15T15:00:00Z',
      errors: []
    },
    createdAt: '2024-01-04T14:00:00Z',
    updatedAt: '2024-01-15T12:20:00Z',
    createdBy: 'user_dev'
  },
  {
    id: '5',
    name: 'huggingface_hub',
    type: 'huggingface',
    displayName: 'HuggingFace Hub',
    description: 'Open source models via HuggingFace',
    status: 'inactive',
    configuration: {
      apiKey: 'hf_***************************',
      baseUrl: 'https://api-inference.huggingface.co',
      model: 'microsoft/DialoGPT-large',
      maxTokens: 1024,
      temperature: 0.9
    },
    models: [
      {
        id: 'microsoft/DialoGPT-large',
        name: 'DialoGPT Large',
        description: 'Conversational AI model',
        maxTokens: 1024,
        pricing: { input: 0.0001, output: 0.0001 },
        capabilities: ['text', 'conversation'],
        status: 'available'
      },
      {
        id: 'bigscience/bloom',
        name: 'BLOOM',
        description: 'Multilingual large language model',
        maxTokens: 2048,
        pricing: { input: 0.0002, output: 0.0002 },
        capabilities: ['text', 'multilingual'],
        status: 'available'
      }
    ],
    usage: {
      totalRequests: 3456,
      totalTokens: 876543,
      totalCost: 45.67,
      avgResponseTime: 2345,
      successRate: 95.8,
      lastUsed: '2024-01-14T16:30:00Z'
    },
    quotas: {
      requestLimit: 50000,
      tokenLimit: 5000000,
      costLimit: 50,
      resetPeriod: 'month',
      currentUsage: {
        requests: 2345,
        tokens: 654321,
        cost: 32.10
      }
    },
    health: {
      status: 'unknown',
      responseTime: 0,
      uptime: 0,
      lastCheck: '2024-01-14T18:00:00Z',
      errors: [
        { timestamp: '2024-01-14T17:30:00Z', message: 'Provider disabled by user' }
      ]
    },
    createdAt: '2024-01-05T16:00:00Z',
    updatedAt: '2024-01-14T16:30:00Z',
    createdBy: 'user_tester'
  },
  {
    id: '6',
    name: 'azure_openai',
    type: 'azure',
    displayName: 'Azure OpenAI',
    description: 'OpenAI models via Microsoft Azure',
    status: 'error',
    configuration: {
      apiKey: '********************************',
      baseUrl: 'https://your-resource.openai.azure.com/',
      region: 'eastus',
      model: 'gpt-4',
      maxTokens: 4096,
      temperature: 0.7
    },
    models: [
      {
        id: 'gpt-4',
        name: 'GPT-4 (Azure)',
        description: 'GPT-4 via Azure OpenAI Service',
        maxTokens: 8192,
        pricing: { input: 0.03, output: 0.06 },
        capabilities: ['text', 'reasoning', 'code'],
        status: 'available'
      },
      {
        id: 'gpt-35-turbo',
        name: 'GPT-3.5 Turbo (Azure)',
        description: 'GPT-3.5 Turbo via Azure OpenAI Service',
        maxTokens: 4096,
        pricing: { input: 0.0015, output: 0.002 },
        capabilities: ['text', 'code'],
        status: 'available'
      }
    ],
    usage: {
      totalRequests: 1234,
      totalTokens: 234567,
      totalCost: 67.89,
      avgResponseTime: 1567,
      successRate: 87.3,
      lastUsed: '2024-01-13T09:15:00Z'
    },
    quotas: {
      requestLimit: 8000,
      tokenLimit: 800000,
      costLimit: 400,
      resetPeriod: 'month',
      currentUsage: {
        requests: 876,
        tokens: 187654,
        cost: 45.67
      }
    },
    health: {
      status: 'down',
      responseTime: 0,
      uptime: 78.5,
      lastCheck: '2024-01-15T15:00:00Z',
      errors: [
        { timestamp: '2024-01-15T14:45:00Z', message: 'Authentication failed' },
        { timestamp: '2024-01-15T14:30:00Z', message: 'Resource not found' },
        { timestamp: '2024-01-15T14:15:00Z', message: 'Invalid deployment name' }
      ]
    },
    createdAt: '2024-01-06T12:00:00Z',
    updatedAt: '2024-01-13T09:15:00Z',
    createdBy: 'user_admin'
  },
  {
    id: '7',
    name: 'aws_bedrock',
    type: 'aws_bedrock',
    displayName: 'AWS Bedrock',
    description: 'Foundation models via AWS Bedrock',
    status: 'configuring',
    configuration: {
      apiKey: 'AKIA********************',
      region: 'us-east-1',
      model: 'anthropic.claude-v2',
      maxTokens: 4096,
      temperature: 0.5
    },
    models: [
      {
        id: 'anthropic.claude-v2',
        name: 'Claude 2 (Bedrock)',
        description: 'Claude 2 via AWS Bedrock',
        maxTokens: 100000,
        pricing: { input: 0.008, output: 0.024 },
        capabilities: ['text', 'reasoning', 'analysis'],
        status: 'available'
      },
      {
        id: 'amazon.titan-text-express-v1',
        name: 'Titan Text Express',
        description: 'Amazon Titan text model',
        maxTokens: 8000,
        pricing: { input: 0.0008, output: 0.0016 },
        capabilities: ['text', 'summarization'],
        status: 'available'
      }
    ],
    usage: {
      totalRequests: 567,
      totalTokens: 123456,
      totalCost: 23.45,
      avgResponseTime: 1890,
      successRate: 92.1,
      lastUsed: '2024-01-15T11:00:00Z'
    },
    quotas: {
      requestLimit: 5000,
      tokenLimit: 500000,
      costLimit: 200,
      resetPeriod: 'month',
      currentUsage: {
        requests: 432,
        tokens: 98765,
        cost: 18.90
      }
    },
    health: {
      status: 'degraded',
      responseTime: 2456,
      uptime: 94.2,
      lastCheck: '2024-01-15T15:00:00Z',
      errors: [
        { timestamp: '2024-01-15T13:20:00Z', message: 'Model loading timeout' }
      ]
    },
    createdAt: '2024-01-07T15:30:00Z',
    updatedAt: '2024-01-15T11:00:00Z',
    createdBy: 'user_dev'
  },
  {
    id: '8',
    name: 'custom_llm',
    type: 'custom',
    displayName: 'Custom LLM Endpoint',
    description: 'Custom self-hosted LLM endpoint',
    status: 'active',
    configuration: {
      baseUrl: 'https://my-llm.example.com/v1',
      apiKey: 'custom_**********************',
      model: 'llama-2-70b-chat',
      maxTokens: 4096,
      temperature: 0.8,
      customHeaders: {
        'X-Custom-Header': 'value'
      }
    },
    models: [
      {
        id: 'llama-2-70b-chat',
        name: 'Llama 2 70B Chat',
        description: 'Self-hosted Llama 2 70B model',
        maxTokens: 4096,
        pricing: { input: 0.001, output: 0.001 },
        capabilities: ['text', 'chat'],
        status: 'available'
      },
      {
        id: 'codellama-34b-instruct',
        name: 'Code Llama 34B',
        description: 'Code generation model',
        maxTokens: 2048,
        pricing: { input: 0.0005, output: 0.0005 },
        capabilities: ['code', 'text'],
        status: 'beta'
      }
    ],
    usage: {
      totalRequests: 2345,
      totalTokens: 567890,
      totalCost: 12.34,
      avgResponseTime: 3456,
      successRate: 96.7,
      lastUsed: '2024-01-15T10:30:00Z'
    },
    quotas: {
      requestLimit: 10000,
      tokenLimit: 1000000,
      costLimit: 50,
      resetPeriod: 'month',
      currentUsage: {
        requests: 1876,
        tokens: 456789,
        cost: 9.87
      }
    },
    health: {
      status: 'healthy',
      responseTime: 3456,
      uptime: 98.7,
      lastCheck: '2024-01-15T15:00:00Z',
      errors: []
    },
    createdAt: '2024-01-08T13:15:00Z',
    updatedAt: '2024-01-15T10:30:00Z',
    createdBy: 'user_custom'
  }
] */

// Zod schema for create provider form with API key validation
const createProviderSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  type: z.string().min(1, 'Provider type is required'),
  apiKey: z.string().min(1, 'API key is required'),
  organizationId: z.string().optional(),
}).refine((data) => {
  // Just check it's not empty — actual validation happens when we test the connection
  return data.apiKey.length >= 8
}, {
  message: 'API key is too short',
  path: ['apiKey']
})

type CreateProviderFormData = z.infer<typeof createProviderSchema>

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
  const [editProvider, setEditProvider] = useState<LlmProvider | null>(null)
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

  // Dynamic model fetching state
  const [availableModels, setAvailableModels] = useState<Array<{ id: string; name: string }>>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const chatEndRef = React.useRef<HTMLDivElement>(null)

  const queryClient = useQueryClient()
  const notifications = useNotifications()

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
    }
  })

  const createProviderMutation = useMutation({
    mutationFn: async (data: CreateProviderFormData) => {
      try {
        return await llmProvidersApi.create({
          name: data.name,
          type: data.type,
          configuration: {
            apiKey: data.apiKey,
            ...(data.organizationId && { organizationId: data.organizationId })
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

  const filteredProviders = providers.filter((provider: any) => {
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
  const providersWithRequests = providers.filter((p: any) => p.totalRequests > 0)
  const avgSuccessRate = providersWithRequests.length > 0
    ? providersWithRequests.reduce((sum: number, provider: any) => {
        return sum + ((provider.successfulRequests || 0) / provider.totalRequests) * 100
      }, 0) / providersWithRequests.length
    : 0

  const columns = [
    createSortableColumn<LlmProvider>({
      accessorKey: 'name',
      header: 'Provider',
      cell: ({ row }) => {
        const provider = row.original
        return (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${statusColors[provider.status]}`} />
              <span className="text-lg">{providerLogos[provider.type]}</span>
            </div>
            <div>
              <div className="font-medium">{provider.name}</div>
              <div className="text-sm text-muted-foreground">{provider.description || 'No description'}</div>
            </div>
          </div>
        )
      }
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'type',
      header: 'Model',
      cell: ({ row }) => {
        const provider = row.original
        return (
          <div>
            <Badge variant="outline" className="capitalize">{provider.type}</Badge>
            {provider.configuration?.model && (
              <div className="text-xs text-muted-foreground mt-1">{provider.configuration.model}</div>
            )}
          </div>
        )
      }
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const provider = row.original
        const status = provider.status
        const colors = {
          active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
          inactive: 'bg-muted text-muted-foreground',
          error: 'bg-red-500/15 text-red-700 dark:text-red-400',
          configuring: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400'
        }
        return (
          <div className="flex items-center gap-2">
            <Badge className={colors[status as keyof typeof colors]}>
              {status}
            </Badge>
            {status === 'error' && provider.lastError && (
              <span className="text-xs text-red-500 truncate max-w-[150px]" title={provider.lastError}>
                {provider.lastError}
              </span>
            )}
          </div>
        )
      }
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'totalRequests',
      header: 'Usage',
      cell: ({ row }) => {
        const provider = row.original
        const requests = provider.totalRequests || 0
        if (requests === 0) {
          return <div className="text-sm text-muted-foreground">No usage yet</div>
        }
        return (
          <div>
            <div className="font-medium">{requests.toLocaleString()} reqs</div>
            <div className="text-sm text-muted-foreground">${(provider.totalCost || 0).toFixed(2)} spent</div>
          </div>
        )
      }
    }),
    // Quota column removed - quotas not in backend entity
    // createSortableColumn<LlmProvider>({
    //   accessorKey: 'quotas.currentUsage.cost',
    //   header: 'Quota Usage',
    //   cell: ({ row }) => {
    //     const quotas = row.original.quotas
    //     const costPercentage = (quotas.currentUsage.cost / quotas.costLimit) * 100
    //     return (
    //       <div className="space-y-1">
    //         <div className="flex justify-between text-sm">
    //           <span>Cost:</span>
    //           <span>{costPercentage.toFixed(0)}%</span>
    //         </div>
    //         <Progress value={costPercentage} className="h-2" />
    //       </div>
    //     )
    //   }
    // }),
    createActionsColumn<LlmProvider>(
      (provider) => navigate(`/llm-providers/${provider.id}`),
      (provider) => setProviderToDelete(provider),
      [
        {
          label: 'View Details',
          onClick: (provider) => navigate(`/llm-providers/${provider.id}`),
        },
        {
          label: 'Test Connection',
          onClick: (provider) => {
            setTestProvider(provider)
            setIsTestDialogOpen(true)
          },
        },
        {
          label: 'Edit',
          onClick: async (provider) => {
            setProviderToEdit(provider)
            editForm.reset({
              name: provider.name,
              model: provider.configuration.model || '',
              maxTokens: provider.configuration.maxTokens || 4096,
              temperature: provider.configuration.temperature || 0.7,
            })
            setIsEditDialogOpen(true)
            setModelsLoading(true)
            setAvailableModels([])
            try {
              const res = await llmProvidersApi.getModels(provider.id)
              setAvailableModels(res || [])
            } catch {
              setAvailableModels([])
            } finally {
              setModelsLoading(false)
            }
          },
        },
        {
          label: 'Copy API Key',
          onClick: (provider) => {
            navigator.clipboard.writeText(provider.configuration.apiKey || '')
            notifications.success('Copied', 'API key copied to clipboard')
          },
        },
        {
          label: 'Toggle Status',
          onClick: (provider) => {
            toggleProviderStatusMutation.mutate({
              providerId: provider.id,
              status: provider.status === 'active' ? 'inactive' : 'active',
            })
          },
        },
      ]
    )
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">AI Models</h1>
          <p className="text-muted-foreground">
            {isLoading ? <span className="inline-block w-48 h-4 bg-muted animate-pulse rounded" /> : `${providers.length} providers (${providers.filter((p: any) => p.status === 'active').length} active) \u00B7 $${totalCost.toFixed(2)} total cost \u00B7 ${totalRequests.toLocaleString()} requests`}
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
              description="Connect OpenAI, Anthropic, Google, Mistral, xAI, Groq, OpenRouter, Azure, AWS Bedrock, or any of 14 supported providers. Agents and LLM tools need at least one model to call."
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

/*
Extracted components:
- Provider Details Sheet -> provider-details-sheet.tsx
- Create Provider Dialog -> create-provider-dialog.tsx
- Edit Provider Dialog -> edit-provider-dialog.tsx
- Test Provider Dialog -> test-provider-dialog.tsx
*/
