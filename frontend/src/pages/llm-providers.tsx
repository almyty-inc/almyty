import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import {
  Plus,
  Search,
  Settings,
  Eye,
  Edit,
  Trash2,
  TestTube,
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
  Copy,
  RefreshCw,
  Power,
  PowerOff
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  SheetTrigger,
} from '@/components/ui/sheet'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { DataTable, createSelectColumn, createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import { useNotifications } from '@/store/app'
import { llmProvidersApi } from '@/lib/api'

interface LlmProvider {
  id: string
  name: string
  description?: string
  type: 'openai' | 'anthropic' | 'google' | 'cohere' | 'huggingface' | 'azure' | 'aws_bedrock' | 'custom'
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
  google: '🔍',
  cohere: '🌀',
  huggingface: '🤗',
  azure: '☁️',
  aws_bedrock: '🪨',
  custom: '⚙️'
}

const statusColors = {
  active: 'bg-green-500',
  inactive: 'bg-gray-500',
  error: 'bg-red-500',
  configuring: 'bg-yellow-500'
}

const healthColors = {
  healthy: 'text-green-600',
  degraded: 'text-yellow-600',
  down: 'text-red-600',
  unknown: 'text-gray-600'
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
      model: 'claude-3-opus-20240229',
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
  const { type, apiKey } = data

  // Provider-specific API key validation
  if (type === 'openai') {
    return apiKey.startsWith('sk-') && apiKey.length > 20
  }
  if (type === 'anthropic') {
    return apiKey.startsWith('sk-ant-') && apiKey.length > 20
  }
  if (type === 'azure') {
    return apiKey.length === 32 || apiKey.length === 64
  }
  if (type === 'google') {
    return apiKey.startsWith('AIza') || apiKey.length > 30
  }
  if (type === 'cohere') {
    return apiKey.startsWith('co-') || apiKey.length > 20
  }
  if (type === 'huggingface') {
    return apiKey.startsWith('hf_') || apiKey.length > 20
  }
  if (type === 'aws_bedrock') {
    return apiKey.startsWith('AKIA') || apiKey.length > 20
  }
  // Custom or unknown: require at least 20 chars
  return apiKey.length >= 20
}, {
  message: 'Invalid API key format for the selected provider',
  path: ['apiKey']
})

type CreateProviderFormData = z.infer<typeof createProviderSchema>

export function LlmProvidersPage() {
  const [selectedProvider, setSelectedProvider] = useState<LlmProvider | null>(null)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [editProvider, setEditProvider] = useState<LlmProvider | null>(null)
  const [providerToEdit, setProviderToEdit] = useState<LlmProvider | null>(null)
  const [providerToDelete, setProviderToDelete] = useState<LlmProvider | null>(null)
  const [testProvider, setTestProvider] = useState<LlmProvider | null>(null)
  const [isTestDialogOpen, setIsTestDialogOpen] = useState(false)
  const [testInput, setTestInput] = useState('Hello, can you help me test this LLM provider?')
  const [testResult, setTestResult] = useState<any>(null)
  const [testLoading, setTestLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const { data: providers = [], isLoading, error } = useQuery({
    queryKey: ['llm-providers'],
    queryFn: async () => {
      try {
        const response = await llmProvidersApi.getAll()
        // Backend returns: { success: true, data: { providers: [...], total: number } }
        return response.data?.data?.providers || []
      } catch (err) {
        console.error('Failed to fetch LLM providers:', err)
        return []
      }
    }
  })

  const { data: providerMetrics } = useQuery({
    queryKey: ['provider-metrics', selectedProvider?.id],
    queryFn: async () => {
      if (!selectedProvider) return null
      await new Promise(resolve => setTimeout(resolve, 800))
      return {
        providerId: selectedProvider.id,
        costByDay: Array.from({ length: 30 }, (_, i) => ({
          date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          cost: Math.random() * 50,
          tokens: Math.floor(Math.random() * 10000),
          requests: Math.floor(Math.random() * 500)
        })),
        usageByModel: ((selectedProvider as any).models || []).map((model: any) => ({
          model: model.name,
          requests: Math.floor(Math.random() * 1000),
          cost: Math.random() * 100,
          tokens: Math.floor(Math.random() * 50000)
        })),
        responseTimeByHour: Array.from({ length: 24 }, (_, i) => ({
          hour: i,
          avgResponseTime: Math.floor(Math.random() * 1000) + 500,
          p95ResponseTime: Math.floor(Math.random() * 2000) + 1000
        })),
        errorsByType: [
          { type: 'Rate Limit', count: 15, percentage: 45 },
          { type: 'Timeout', count: 12, percentage: 36 },
          { type: 'Auth Error', count: 6, percentage: 19 }
        ],
        topErrors: [
          { error: 'Rate limit exceeded', count: 25, lastOccurred: '2024-01-15T14:30:00Z' },
          { error: 'Request timeout', count: 18, lastOccurred: '2024-01-15T13:15:00Z' },
          { error: 'Invalid API key', count: 12, lastOccurred: '2024-01-15T11:45:00Z' }
        ]
      } as ProviderMetrics
    },
    enabled: !!selectedProvider
  })

  const testProviderMutation = useMutation({
    mutationFn: async ({ providerId, input }: { providerId: string; input: string }) => {
      setTestLoading(true)
      const response = await llmProvidersApi.test(providerId)
      return response.data
    },
    onSuccess: (responseData) => {
      // Backend returns { success: true, data: actualResult } - map to UI format
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
      const response = await llmProvidersApi.update(providerId, { status })
      return response.data
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
        const response = await llmProvidersApi.create({
          name: data.name,
          type: data.type,
          configuration: {
            apiKey: data.apiKey,
            ...(data.organizationId && { organizationId: data.organizationId })
          }
        })
        return response.data?.data || response.data
      } catch (error) {
        console.error('Create provider error:', error)
        throw error
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['llm-providers'] })
      setIsCreateDialogOpen(false)
      createForm.reset()
      notifications.success('Provider added', 'LLM provider configured successfully')
    },
    onError: (error: any) => {
      console.error('Create provider mutation error:', error)
      notifications.error('Error', error.response?.data?.message || 'Failed to add provider')
    }
  })

  const updateProviderMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const response = await llmProvidersApi.update(id, {
        name: data.name,
        configuration: {
          model: data.model,
          maxTokens: data.maxTokens,
          temperature: data.temperature,
        }
      })
      return response.data
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
  const avgSuccessRate = providers.length > 0
    ? providers.reduce((sum: number, provider: any) => {
        const successRate = provider.totalRequests > 0
          ? (provider.successfulRequests / provider.totalRequests) * 100
          : 100
        return sum + successRate
      }, 0) / providers.length
    : 0

  const columns = [
    createSelectColumn<LlmProvider>(),
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
      header: 'Type',
      cell: ({ row }) => (
        <Badge variant="outline" className="capitalize">{row.getValue('type')}</Badge>
      )
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const status = row.getValue('status') as string
        const colors = {
          active: 'bg-green-100 text-green-800',
          inactive: 'bg-gray-100 text-gray-800',
          error: 'bg-red-100 text-red-800',
          configuring: 'bg-yellow-100 text-yellow-800'
        }
        return (
          <Badge className={colors[status as keyof typeof colors]}>
            {status}
          </Badge>
        )
      }
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'isHealthy',
      header: 'Health',
      cell: ({ row }) => {
        const provider = row.original
        const healthStatus: string = provider.isHealthy ? 'healthy' : (provider.status === 'error' ? 'down' : 'unknown')
        return (
          <div className="flex items-center gap-2">
            {healthStatus === 'healthy' ? (
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            ) : healthStatus === 'degraded' ? (
              <AlertTriangle className="h-4 w-4 text-yellow-500" />
            ) : healthStatus === 'down' ? (
              <XCircle className="h-4 w-4 text-red-500" />
            ) : (
              <Activity className="h-4 w-4 text-gray-500" />
            )}
            <span className="text-sm capitalize">{healthStatus}</span>
          </div>
        )
      }
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'totalCost',
      header: 'Usage Cost',
      cell: ({ row }) => {
        const provider = row.original
        return (
          <div className="text-right">
            <div className="font-medium">${(provider.totalCost || 0).toFixed(2)}</div>
            <div className="text-sm text-muted-foreground">
              {(provider.totalRequests || 0).toLocaleString()} reqs
            </div>
          </div>
        )
      }
    }),
    createSortableColumn<LlmProvider>({
      accessorKey: 'lastRequestAt',
      header: 'Performance',
      cell: ({ row }) => {
        const provider = row.original
        const successRate = provider.totalRequests > 0
          ? ((provider.successfulRequests || 0) / provider.totalRequests) * 100
          : 100
        return (
          <div className="text-right">
            <div className="font-medium">{provider.lastRequestAt ? 'Active' : 'Inactive'}</div>
            <div className="text-sm text-muted-foreground">
              {successRate.toFixed(1)}% success
            </div>
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
    createActionsColumn<LlmProvider>({
      cell: ({ row }) => {
        const provider = row.original
        return (
          <div className="flex items-center gap-2">
            {/* Test Connection Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                setTestProvider(provider)
                setIsTestDialogOpen(true)
              }}
              aria-label="Test Connection"
            >
              <TestTube className="h-4 w-4 mr-1" />
              Test
            </Button>

            {/* View Details Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                setSelectedProvider(provider)
              }}
              aria-label="View Details"
            >
              <Eye className="h-4 w-4 mr-1" />
              Details
            </Button>

            {/* Edit Button */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                setProviderToEdit(provider)
                editForm.reset({
                  name: provider.name,
                  model: provider.configuration.model || '',
                  maxTokens: provider.configuration.maxTokens || 4096,
                  temperature: provider.configuration.temperature || 0.7,
                })
                setIsEditDialogOpen(true)
              }}
              aria-label="Edit"
            >
              <Edit className="h-4 w-4 mr-1" />
              Edit
            </Button>

            {/* Delete Button with Confirmation */}
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                setProviderToDelete(provider)
              }}
              aria-label="Delete"
              className="text-red-600 hover:text-red-700"
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>

            {/* Dropdown for additional actions */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <Settings className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => {
                  navigator.clipboard.writeText(provider.configuration.apiKey || '')
                  notifications.success('Copied', 'API key copied to clipboard')
                }}>
                  <Copy className="h-4 w-4 mr-2" />
                  Copy API Key
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => toggleProviderStatusMutation.mutate({
                  providerId: provider.id,
                  status: provider.status === 'active' ? 'inactive' : 'active'
                })}>
                  {provider.status === 'active' ? (
                    <>
                      <PowerOff className="h-4 w-4 mr-2" />
                      Disable
                    </>
                  ) : (
                    <>
                      <Power className="h-4 w-4 mr-2" />
                      Enable
                    </>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      }
    })
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">LLM Providers</h1>
          <p className="text-muted-foreground">
            Configure AI providers for tool-augmented chat. Providers can be used to test tools with real LLM interactions.
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

      {/* Stats Cards - Only show when there are providers */}
      {!(!isLoading && providers.length === 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Providers</CardTitle>
            <Server className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{providers.length}</div>
            <p className="text-xs text-muted-foreground">
              {providers.filter((p: any) => p.status === 'active').length} active
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${totalCost.toFixed(2)}</div>
            <p className="text-xs text-muted-foreground">
              +15.2% from last month
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Requests</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalRequests.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">
              +8.3% from last week
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Success Rate</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{avgSuccessRate.toFixed(1)}%</div>
            <p className="text-xs text-muted-foreground">
              +1.2% from yesterday
            </p>
          </CardContent>
        </Card>
        </div>
      )}

      {/* Filters - Only show when there are providers */}
      {!(!isLoading && providers.length === 0) && (
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
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="cohere">Cohere</SelectItem>
              <SelectItem value="huggingface">HuggingFace</SelectItem>
              <SelectItem value="azure">Azure</SelectItem>
              <SelectItem value="aws_bedrock">AWS Bedrock</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Providers Table or Empty State */}
      {!isLoading && providers.length === 0 ? (
        <Card className="p-12">
          <div className="text-center space-y-4">
            <div className="flex justify-center">
              <Server className="h-16 w-16 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">No Providers Configured</h3>
              <p className="text-muted-foreground mt-2">
                Get started by adding your first LLM provider to enable AI-powered features
              </p>
            </div>
            <Button onClick={() => setIsCreateDialogOpen(true)} className="gap-2">
              <Plus className="h-4 w-4" />
              Add First Provider
            </Button>
          </div>
        </Card>
      ) : (
        <DataTable
          columns={columns}
          data={filteredProviders}
          loading={isLoading}
          onRowClick={(provider) => setSelectedProvider(provider)}
        />
      )}

      {/* Provider Details Sheet */}
      <Sheet open={!!selectedProvider} onOpenChange={() => setSelectedProvider(null)}>
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
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="overview">Overview</TabsTrigger>
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

                {/* Quota Management removed - not in backend entity */}
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
                            {selectedProvider.isHealthy ? '✓' : '✗'}
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
                    <div>
                      <Label>API Key</Label>
                      <Input
                        type="password"
                        value={selectedProvider.configuration.apiKey || ''}
                        readOnly
                      />
                    </div>
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
                          <Activity className="h-4 w-4 text-gray-500" />
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
                        onClick={() => setIsTestDialogOpen(true)}
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
            </Tabs>
          )}
        </SheetContent>
      </Sheet>

      {/* Create Provider Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Add Provider</DialogTitle>
            <DialogDescription>
              Select a provider type and configure your LLM integration
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={createForm.handleSubmit((data) => createProviderMutation.mutate(data))} className="space-y-4">
            {/* Provider Name */}
            <div>
              <Label htmlFor="providerName">Provider Name</Label>
              <Input
                id="providerName"
                {...createForm.register('name')}
                placeholder="e.g., OpenAI Production"
              />
              {createForm.formState.errors.name && (
                <p className="text-sm text-red-600 mt-1">{createForm.formState.errors.name.message}</p>
              )}
            </div>

            {/* Provider Type */}
            <div>
              <Label htmlFor="providerType">Provider Type</Label>
              <Controller
                name="type"
                control={createForm.control}
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger id="providerType" aria-label="Provider Type">
                      <SelectValue placeholder="Select provider type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai" data-testid="provider-type-openai">OpenAI</SelectItem>
                      <SelectItem value="anthropic" data-testid="provider-type-anthropic">Anthropic Claude</SelectItem>
                      <SelectItem value="azure" data-testid="provider-type-azure">Azure</SelectItem>
                      <SelectItem value="google" data-testid="provider-type-google">Google</SelectItem>
                      <SelectItem value="cohere" data-testid="provider-type-cohere">Cohere</SelectItem>
                      <SelectItem value="huggingface" data-testid="provider-type-huggingface">HuggingFace</SelectItem>
                      <SelectItem value="aws_bedrock" data-testid="provider-type-aws-bedrock">AWS Bedrock</SelectItem>
                      <SelectItem value="custom" data-testid="provider-type-custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
              {createForm.formState.errors.type && (
                <p className="text-sm text-red-600 mt-1">{createForm.formState.errors.type.message}</p>
              )}
            </div>

            {/* API Key */}
            <div>
              <Label htmlFor="apiKey">API Key</Label>
              <Input
                id="apiKey"
                type="password"
                {...createForm.register('apiKey')}
                placeholder="Enter your API key"
              />
              {createForm.formState.errors.apiKey && (
                <p className="text-sm text-red-600 mt-1">{createForm.formState.errors.apiKey.message}</p>
              )}
            </div>

            {/* Organization ID - Only for OpenAI */}
            {createForm.watch('type') === 'openai' && (
              <div>
                <Label htmlFor="organizationId">Organization ID (Optional)</Label>
                <Input
                  id="organizationId"
                  {...createForm.register('organizationId')}
                  placeholder="org-..."
                />
                {createForm.formState.errors.organizationId && (
                  <p className="text-sm text-red-600 mt-1">{createForm.formState.errors.organizationId.message}</p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createProviderMutation.isPending}>
                {createProviderMutation.isPending ? 'Adding...' : 'Add Provider'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Provider Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Provider</DialogTitle>
            <DialogDescription>
              Update provider configuration and model settings
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={editForm.handleSubmit((data) => {
            if (providerToEdit) {
              updateProviderMutation.mutate({ id: providerToEdit.id, data })
            }
          })} className="space-y-4">
            {/* Provider Name */}
            <div>
              <Label htmlFor="editProviderName">Provider Name</Label>
              <Input
                id="editProviderName"
                {...editForm.register('name')}
                placeholder="e.g., OpenAI Production"
              />
            </div>

            {/* Default Model Selection */}
            <div>
              <Label htmlFor="editDefaultModel">Default Model</Label>
              <Controller
                name="model"
                control={editForm.control}
                render={({ field }) => (
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger id="editDefaultModel" aria-label="Default Model">
                      <SelectValue placeholder="Select default model" />
                    </SelectTrigger>
                    <SelectContent>
                      {providerToEdit?.type === 'openai' && (
                        <>
                          <SelectItem value="gpt-4">GPT-4</SelectItem>
                          <SelectItem value="gpt-4-turbo">GPT-4 Turbo</SelectItem>
                          <SelectItem value="gpt-3.5-turbo">GPT-3.5 Turbo</SelectItem>
                        </>
                      )}
                      {providerToEdit?.type === 'anthropic' && (
                        <>
                          <SelectItem value="claude-3-opus-20240229">Claude 3 Opus</SelectItem>
                          <SelectItem value="claude-3-sonnet-20240229">Claude 3 Sonnet</SelectItem>
                          <SelectItem value="claude-3-haiku-20240307">Claude 3 Haiku</SelectItem>
                        </>
                      )}
                      {providerToEdit?.type === 'google' && (
                        <>
                          <SelectItem value="gemini-pro">Gemini Pro</SelectItem>
                          <SelectItem value="gemini-pro-vision">Gemini Pro Vision</SelectItem>
                        </>
                      )}
                      {/* Add more provider types as needed */}
                      <SelectItem value="custom">Custom Model</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            {/* Model Parameters */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="editMaxTokens">Max Tokens</Label>
                <Input
                  id="editMaxTokens"
                  type="number"
                  {...editForm.register('maxTokens', { valueAsNumber: true })}
                  placeholder="4096"
                />
              </div>
              <div>
                <Label htmlFor="editTemperature">Temperature</Label>
                <Input
                  id="editTemperature"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  {...editForm.register('temperature', { valueAsNumber: true })}
                  placeholder="0.7"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateProviderMutation.isPending}>
                {updateProviderMutation.isPending ? 'Updating...' : 'Update Provider'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation AlertDialog */}
      <AlertDialog open={!!providerToDelete} onOpenChange={() => setProviderToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Provider</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{providerToDelete?.name}"? This action cannot be undone.
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
      <Dialog open={isTestDialogOpen} onOpenChange={setIsTestDialogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Test Provider: {testProvider?.name}</DialogTitle>
            <DialogDescription>
              Send a test request to validate provider configuration and connectivity
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-4">
              <div>
                <Label>Test Input</Label>
                <Textarea
                  placeholder="Enter test prompt..."
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  className="h-64"
                />
              </div>
              <Button 
                onClick={handleTestProvider}
                disabled={testLoading}
                className="w-full gap-2"
              >
                {testLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                    Testing...
                  </>
                ) : (
                  <>
                    <TestTube className="h-4 w-4" />
                    Test Provider
                  </>
                )}
              </Button>
            </div>
            
            <div className="space-y-4">
              <Label>Test Result</Label>
              <div className="h-64 border rounded-md p-4 bg-muted font-mono text-sm overflow-auto">
                {testResult ? (
                  testResult.error ? (
                    <div className="text-red-600">
                      <div className="font-semibold">Error:</div>
                      <div>{testResult.error}</div>
                      <div className="text-xs mt-2">{testResult.timestamp}</div>
                    </div>
                  ) : (
                    <div>
                      <div className="text-green-600 font-semibold mb-2">Success!</div>
                      <div className="mb-2">
                        <strong>Response:</strong>
                        <div className="mt-1">{testResult.output.response}</div>
                      </div>
                      <div className="text-xs text-gray-600 space-y-1">
                        <div>Tokens: {testResult.output.usage.inputTokens} in, {testResult.output.usage.outputTokens} out</div>
                        <div>Cost: ${testResult.output.cost}</div>
                        <div>Response Time: {testResult.output.responseTime}ms</div>
                        <div>Timestamp: {testResult.timestamp}</div>
                      </div>
                    </div>
                  )
                ) : (
                  <span className="text-muted-foreground">No test result yet</span>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}