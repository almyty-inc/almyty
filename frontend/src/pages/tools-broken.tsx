import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus,
  Search,
  Filter,
  Download,
  Upload,
  Play,
  Pause,
  Square,
  RotateCcw,
  Settings,
  Eye,
  Edit,
  Trash2,
  Copy,
  ExternalLink,
  Activity,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Zap,
  Code,
  Database,
  Globe,
  ShieldCheck,
  Timer,
  TrendingUp,
  BarChart3,
  LineChart,
  PieChart,
  Target,
  Users,
  Server,
  Cpu,
  Memory,
  HardDrive,
  Network,
  Bug,
  TestTube,
  Gauge
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
import { useOrganizationStore } from '@/store/organization'

interface Tool {
  id: string
  name: string
  description: string
  type: 'REST' | 'GraphQL' | 'SOAP' | 'gRPC' | 'WebSocket' | 'Custom'
  method: string
  endpoint: string
  schema: any
  parameters: Parameter[]
  status: 'active' | 'inactive' | 'error' | 'testing'
  version: string
  apiId: string
  apiName: string
  gatewayIds: string[]
  usage: {
    total: number
    success: number
    error: number
    avgDuration: number
    lastUsed: string
  }
  performance: {
    responseTime: number
    throughput: number
    errorRate: number
    availability: number
  }
  security: {
    authRequired: boolean
    rateLimited: boolean
    allowedOrigins: string[]
    permissions: string[]
  }
  monitoring: {
    enabled: boolean
    alertsEnabled: boolean
    loggingLevel: 'none' | 'basic' | 'detailed' | 'debug'
  }
  createdAt: string
  updatedAt: string
  createdBy: string
}

interface Parameter {
  name: string
  type: string
  required: boolean
  description?: string
  example?: any
  validation?: any
}

interface ToolExecution {
  id: string
  toolId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  input: any
  output?: any
  error?: string
  duration: number
  startTime: string
  endTime?: string
  userId: string
  gatewayId?: string
}

interface ToolMetrics {
  toolId: string
  totalExecutions: number
  successRate: number
  avgResponseTime: number
  errorRate: number
  throughput: number
  costPerExecution: number
  totalCost: number
  topErrors: Array<{ error: string; count: number }>
  usageByDay: Array<{ date: string; executions: number; errors: number }>
  performanceByHour: Array<{ hour: number; avgResponseTime: number; throughput: number }>
}

const mockTools: Tool[] = [
  {
    id: '1',
    name: 'Get User Profile',
    description: 'Retrieve user profile information from the CRM API',
    type: 'REST',
    method: 'GET',
    endpoint: '/api/users/{userId}',
    schema: {},
    parameters: [
      { name: 'userId', type: 'string', required: true, description: 'Unique user identifier', example: 'user_123' }
    ],
    status: 'active',
    version: '1.2.0',
    apiId: 'api_1',
    apiName: 'CRM API',
    gatewayIds: ['gateway_1', 'gateway_2'],
    usage: {
      total: 12543,
      success: 12234,
      error: 309,
      avgDuration: 245,
      lastUsed: '2024-01-15T10:30:00Z'
    },
    performance: {
      responseTime: 245,
      throughput: 150,
      errorRate: 2.46,
      availability: 99.8
    },
    security: {
      authRequired: true,
      rateLimited: true,
      allowedOrigins: ['*'],
      permissions: ['read:users']
    },
    monitoring: {
      enabled: true,
      alertsEnabled: true,
      loggingLevel: 'detailed'
    },
    createdAt: '2024-01-10T08:00:00Z',
    updatedAt: '2024-01-15T10:30:00Z',
    createdBy: 'user_admin'
  },
  {
    id: '2',
    name: 'Create Order',
    description: 'Create a new order in the e-commerce system',
    type: 'REST',
    method: 'POST',
    endpoint: '/api/orders',
    schema: {},
    parameters: [
      { name: 'customerId', type: 'string', required: true, description: 'Customer ID' },
      { name: 'items', type: 'array', required: true, description: 'Order items' },
      { name: 'totalAmount', type: 'number', required: true, description: 'Total order amount' }
    ],
    status: 'active',
    version: '2.1.0',
    apiId: 'api_2',
    apiName: 'E-commerce API',
    gatewayIds: ['gateway_1'],
    usage: {
      total: 8976,
      success: 8854,
      error: 122,
      avgDuration: 412,
      lastUsed: '2024-01-15T11:15:00Z'
    },
    performance: {
      responseTime: 412,
      throughput: 89,
      errorRate: 1.36,
      availability: 99.9
    },
    security: {
      authRequired: true,
      rateLimited: true,
      allowedOrigins: ['https://shop.example.com'],
      permissions: ['write:orders', 'read:customers']
    },
    monitoring: {
      enabled: true,
      alertsEnabled: true,
      loggingLevel: 'basic'
    },
    createdAt: '2024-01-08T14:20:00Z',
    updatedAt: '2024-01-15T11:15:00Z',
    createdBy: 'user_dev'
  },
  {
    id: '3',
    name: 'Get Weather Data',
    description: 'Fetch current weather information for a given location',
    type: 'GraphQL',
    method: 'POST',
    endpoint: '/graphql',
    schema: {},
    parameters: [
      { name: 'location', type: 'string', required: true, description: 'City name or coordinates' },
      { name: 'units', type: 'string', required: false, description: 'Temperature units (celsius/fahrenheit)', example: 'celsius' }
    ],
    status: 'testing',
    version: '1.0.0',
    apiId: 'api_3',
    apiName: 'Weather Service',
    gatewayIds: ['gateway_3'],
    usage: {
      total: 3421,
      success: 3398,
      error: 23,
      avgDuration: 156,
      lastUsed: '2024-01-15T12:45:00Z'
    },
    performance: {
      responseTime: 156,
      throughput: 245,
      errorRate: 0.67,
      availability: 99.95
    },
    security: {
      authRequired: false,
      rateLimited: true,
      allowedOrigins: ['*'],
      permissions: []
    },
    monitoring: {
      enabled: true,
      alertsEnabled: false,
      loggingLevel: 'debug'
    },
    createdAt: '2024-01-12T09:30:00Z',
    updatedAt: '2024-01-15T12:45:00Z',
    createdBy: 'user_tester'
  },
  {
    id: '4',
    name: 'Send Email Notification',
    description: 'Send email notifications through the messaging service',
    type: 'REST',
    method: 'POST',
    endpoint: '/api/notifications/email',
    schema: {},
    parameters: [
      { name: 'recipient', type: 'string', required: true, description: 'Email address' },
      { name: 'subject', type: 'string', required: true, description: 'Email subject' },
      { name: 'body', type: 'string', required: true, description: 'Email body content' },
      { name: 'template', type: 'string', required: false, description: 'Email template ID' }
    ],
    status: 'inactive',
    version: '1.5.2',
    apiId: 'api_4',
    apiName: 'Messaging Service',
    gatewayIds: [],
    usage: {
      total: 15678,
      success: 15234,
      error: 444,
      avgDuration: 892,
      lastUsed: '2024-01-14T16:20:00Z'
    },
    performance: {
      responseTime: 892,
      throughput: 67,
      errorRate: 2.83,
      availability: 99.2
    },
    security: {
      authRequired: true,
      rateLimited: true,
      allowedOrigins: ['https://app.example.com'],
      permissions: ['send:emails']
    },
    monitoring: {
      enabled: false,
      alertsEnabled: false,
      loggingLevel: 'none'
    },
    createdAt: '2024-01-05T11:45:00Z',
    updatedAt: '2024-01-14T16:20:00Z',
    createdBy: 'user_admin'
  },
  {
    id: '5',
    name: 'Calculate Shipping Cost',
    description: 'Calculate shipping costs based on weight, distance, and delivery speed',
    type: 'gRPC',
    method: 'CalculateShipping',
    endpoint: 'shipping.ShippingService/CalculateShipping',
    schema: {},
    parameters: [
      { name: 'weight', type: 'number', required: true, description: 'Package weight in kg' },
      { name: 'origin', type: 'string', required: true, description: 'Origin address' },
      { name: 'destination', type: 'string', required: true, description: 'Destination address' },
      { name: 'speed', type: 'string', required: false, description: 'Delivery speed (standard/express)', example: 'standard' }
    ],
    status: 'error',
    version: '2.0.1',
    apiId: 'api_5',
    apiName: 'Shipping Service',
    gatewayIds: ['gateway_2'],
    usage: {
      total: 5432,
      success: 4987,
      error: 445,
      avgDuration: 189,
      lastUsed: '2024-01-15T14:12:00Z'
    },
    performance: {
      responseTime: 189,
      throughput: 198,
      errorRate: 8.19,
      availability: 98.5
    },
    security: {
      authRequired: true,
      rateLimited: false,
      allowedOrigins: ['https://logistics.example.com'],
      permissions: ['calculate:shipping']
    },
    monitoring: {
      enabled: true,
      alertsEnabled: true,
      loggingLevel: 'detailed'
    },
    createdAt: '2024-01-07T13:15:00Z',
    updatedAt: '2024-01-15T14:12:00Z',
    createdBy: 'user_logistics'
  }
]

const statusColors = {
  active: 'bg-green-500',
  inactive: 'bg-gray-500',
  error: 'bg-red-500',
  testing: 'bg-yellow-500'
}

const typeIcons = {
  REST: Globe,
  GraphQL: Database,
  SOAP: Server,
  gRPC: Cpu,
  WebSocket: Network,
  Custom: Code
}

export function ToolsPage() {
  const { currentOrganization } = useOrganizationStore()
  const [selectedTool, setSelectedTool] = useState<Tool | null>(null)
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false)
  const [isExecutionDialogOpen, setIsExecutionDialogOpen] = useState(false)
  const [executionInput, setExecutionInput] = useState('')
  const [executionResult, setExecutionResult] = useState<any>(null)
  const [executionLoading, setExecutionLoading] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const queryClient = useQueryClient()

  const { data: toolsData, isLoading } = useQuery({
    queryKey: ['tools', currentOrganization?.id],
    queryFn: () => toolsApi.getAll(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const { data: toolMetrics } = useQuery({
    queryKey: ['tool-metrics', selectedTool?.id],
    queryFn: async () => {
      if (!selectedTool) return null
      await new Promise(resolve => setTimeout(resolve, 800))
      return {
        toolId: selectedTool.id,
        totalExecutions: selectedTool.usage.total,
        successRate: (selectedTool.usage.success / selectedTool.usage.total) * 100,
        avgResponseTime: selectedTool.performance.responseTime,
        errorRate: selectedTool.performance.errorRate,
        throughput: selectedTool.performance.throughput,
        costPerExecution: 0.025,
        totalCost: selectedTool.usage.total * 0.025,
        topErrors: [
          { error: 'Timeout', count: 15 },
          { error: 'Invalid Parameter', count: 8 },
          { error: 'Authentication Failed', count: 5 }
        ],
        usageByDay: Array.from({ length: 7 }, (_, i) => ({
          date: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          executions: Math.floor(Math.random() * 100) + 50,
          errors: Math.floor(Math.random() * 10)
        })),
        performanceByHour: Array.from({ length: 24 }, (_, i) => ({
          hour: i,
          avgResponseTime: Math.floor(Math.random() * 200) + 100,
          throughput: Math.floor(Math.random() * 50) + 25
        }))
      } as ToolMetrics
    },
    enabled: !!selectedTool
  })

  const executeToolMutation = useMutation({
    mutationFn: async ({ toolId, input }: { toolId: string; input: any }) => {
      setExecutionLoading(true)
      await new Promise(resolve => setTimeout(resolve, 2000))
      
      // Simulate random success/failure
      if (Math.random() > 0.8) {
        throw new Error('Tool execution failed: Connection timeout')
      }
      
      return {
        id: `exec_${Date.now()}`,
        toolId,
        status: 'completed' as const,
        input,
        output: {
          success: true,
          data: { result: 'Mock execution result', timestamp: new Date().toISOString() },
          executionTime: Math.floor(Math.random() * 1000) + 200
        },
        duration: Math.floor(Math.random() * 1000) + 200,
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString()
      }
    },
    onSuccess: (data) => {
      setExecutionResult(data)
      setExecutionLoading(false)
    },
    onError: (error) => {
      setExecutionResult({
        status: 'failed',
        error: error.message,
        output: null
      })
      setExecutionLoading(false)
    }
  })

  const deleteToolMutation = useMutation({
    mutationFn: async (toolId: string) => {
      await new Promise(resolve => setTimeout(resolve, 1000))
      return toolId
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
    }
  })

  const toggleToolStatusMutation = useMutation({
    mutationFn: async ({ toolId, status }: { toolId: string; status: string }) => {
      await new Promise(resolve => setTimeout(resolve, 800))
      return { toolId, status }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
    }
  })

  const tools = toolsData?.data?.data?.tools || []
  const filteredTools = tools.filter(tool => {
    const matchesSearch = tool.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         (tool.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                         (tool.metadata?.sourceApi?.name || '').toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === 'all' || tool.status === statusFilter
    const matchesType = typeFilter === 'all' || tool.type === typeFilter
    return matchesSearch && matchesStatus && matchesType
  })

  const handleExecuteTool = () => {
    if (!selectedTool) return
    
    try {
      const input = JSON.parse(executionInput || '{}')
      executeToolMutation.mutate({ toolId: selectedTool.id, input })
    } catch (error) {
      setExecutionResult({
        status: 'failed',
        error: 'Invalid JSON input',
        output: null
      })
    }
  }

  const columns = [
    createSelectColumn<Tool>('select'),
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => {
        const tool = row.original
        const Icon = typeIcons[tool.type] || Code
        return (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${statusColors[tool.status] || 'bg-gray-400'}`} />
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div>
              <div className="font-medium">{tool.name}</div>
              <div className="text-sm text-muted-foreground">{tool.metadata?.sourceApi?.name}</div>
            </div>
          </div>
        )
      }
    },
    {
      accessorKey: 'type',
      header: 'Type',
      cell: ({ row }) => (
        <Badge variant="outline">{row.getValue('type')}</Badge>
      )
    },
    {
      accessorKey: 'method',
      header: 'Method',
      cell: ({ row }) => {
        const method = row.original.operation?.method || 'GET'
        return <code className="px-2 py-1 rounded bg-muted text-sm">{method}</code>
      }
    },
    createSortableColumn<Tool>({
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const status = row.getValue('status') as string
        const colors = {
          active: 'bg-green-100 text-green-800',
          inactive: 'bg-gray-100 text-gray-800',
          error: 'bg-red-100 text-red-800',
          testing: 'bg-yellow-100 text-yellow-800'
        }
        return (
          <Badge className={colors[status as keyof typeof colors]}>
            {status}
          </Badge>
        )
      }
    }),
    createSortableColumn<Tool>({
      accessorKey: 'usage.total',
      header: 'Usage',
      cell: ({ row }) => {
        const usage = row.original.usage
        return (
          <div className="text-right">
            <div className="font-medium">{usage.total.toLocaleString()}</div>
            <div className="text-sm text-muted-foreground">
              {((usage.success / usage.total) * 100).toFixed(1)}% success
            </div>
          </div>
        )
      }
    }),
    createSortableColumn<Tool>({
      accessorKey: 'performance.responseTime',
      header: 'Performance',
      cell: ({ row }) => {
        const perf = row.original.performance
        return (
          <div className="text-right">
            <div className="font-medium">{perf.responseTime}ms</div>
            <div className="text-sm text-muted-foreground">
              {perf.availability}% uptime
            </div>
          </div>
        )
      }
    }),
    createSortableColumn<Tool>({
      accessorKey: 'updatedAt',
      header: 'Last Updated',
      cell: ({ row }) => {
        const date = new Date(row.getValue('updatedAt'))
        return (
          <div className="text-right">
            <div className="font-medium">{date.toLocaleDateString()}</div>
            <div className="text-sm text-muted-foreground">{date.toLocaleTimeString()}</div>
          </div>
        )
      }
    }),
    createActionsColumn<Tool>({
      cell: ({ row }) => {
        const tool = row.original
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <Settings className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSelectedTool(tool)}>
                <Eye className="h-4 w-4 mr-2" />
                View Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                setSelectedTool(tool)
                setIsExecutionDialogOpen(true)
              }}>
                <Play className="h-4 w-4 mr-2" />
                Execute
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => {
                navigator.clipboard.writeText(JSON.stringify(tool.schema, null, 2))
              }}>
                <Copy className="h-4 w-4 mr-2" />
                Copy Schema
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => toggleToolStatusMutation.mutate({
                toolId: tool.id,
                status: tool.status === 'active' ? 'inactive' : 'active'
              })}>
                {tool.status === 'active' ? (
                  <>
                    <Pause className="h-4 w-4 mr-2" />
                    Disable
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4 mr-2" />
                    Enable
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem className="text-red-600">
                <Trash2 className="h-4 w-4 mr-2" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )
      }
    })
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Tools</h1>
          <p className="text-muted-foreground">
            Execute, monitor, and manage your LLM tools with comprehensive analytics
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => setIsCreateDialogOpen(true)}
            className="gap-2"
          >
            <Plus className="h-4 w-4" />
            Create Tool
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Tools</CardTitle>
            <Target className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{tools.length}</div>
            <p className="text-xs text-muted-foreground">
              {tools.filter(t => t.status === 'active').length} active
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Executions</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {tools.reduce((sum, tool) => sum + tool.usage.total, 0).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">
              +12.5% from last month
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Success Rate</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(tools.reduce((sum, tool) => sum + (tool.usage.success / tool.usage.total), 0) / tools.length * 100).toFixed(1)}%
            </div>
            <p className="text-xs text-muted-foreground">
              +2.1% from last week
            </p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Response Time</CardTitle>
            <Timer className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(tools.reduce((sum, tool) => sum + tool.performance.responseTime, 0) / tools.length).toFixed(0)}ms
            </div>
            <p className="text-xs text-muted-foreground">
              -15ms from yesterday
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tools..."
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
            <SelectItem value="testing">Testing</SelectItem>
          </SelectContent>
        </Select>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="REST">REST</SelectItem>
            <SelectItem value="GraphQL">GraphQL</SelectItem>
            <SelectItem value="SOAP">SOAP</SelectItem>
            <SelectItem value="gRPC">gRPC</SelectItem>
            <SelectItem value="WebSocket">WebSocket</SelectItem>
            <SelectItem value="Custom">Custom</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Tools Table */}
      <DataTable
        columns={columns}
        data={filteredTools}
        loading={isLoading}
        onRowClick={(tool) => setSelectedTool(tool)}
      />

      {/* Tool Details Sheet */}
      <Sheet open={!!selectedTool} onOpenChange={() => setSelectedTool(null)}>
        <SheetContent className="w-full max-w-4xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-3">
              {selectedTool && (
                <>
                  <div className={`w-3 h-3 rounded-full ${statusColors[selectedTool.status]}`} />
                  {selectedTool.name}
                </>
              )}
            </SheetTitle>
            <SheetDescription>
              {selectedTool?.description}
            </SheetDescription>
          </SheetHeader>
          
          {selectedTool && (
            <Tabs defaultValue="overview" className="mt-6">
              <TabsList className="grid w-full grid-cols-5">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="execution">Execution</TabsTrigger>
                <TabsTrigger value="monitoring">Monitoring</TabsTrigger>
                <TabsTrigger value="security">Security</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>
              
              <TabsContent value="overview" className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Basic Information</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Type:</span>
                        <Badge variant="outline">{selectedTool.type}</Badge>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Method:</span>
                        <code className="text-sm">{selectedTool.method}</code>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Version:</span>
                        <span className="text-sm">{selectedTool.version}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">API:</span>
                        <span className="text-sm">{selectedTool.apiName}</span>
                      </div>
                    </CardContent>
                  </Card>
                  
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Usage Statistics</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Total Executions:</span>
                        <span className="text-sm font-medium">{selectedTool.usage.total.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Success Rate:</span>
                        <span className="text-sm font-medium">
                          {((selectedTool.usage.success / selectedTool.usage.total) * 100).toFixed(1)}%
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Avg Duration:</span>
                        <span className="text-sm font-medium">{selectedTool.usage.avgDuration}ms</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-sm text-muted-foreground">Last Used:</span>
                        <span className="text-sm">{new Date(selectedTool.usage.lastUsed).toLocaleString()}</span>
                      </div>
                    </CardContent>
                  </Card>
                </div>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Performance Metrics</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div className="text-center">
                        <div className="text-2xl font-bold">{selectedTool.performance.responseTime}ms</div>
                        <div className="text-sm text-muted-foreground">Response Time</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold">{selectedTool.performance.throughput}</div>
                        <div className="text-sm text-muted-foreground">Throughput/min</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold">{selectedTool.performance.errorRate}%</div>
                        <div className="text-sm text-muted-foreground">Error Rate</div>
                      </div>
                      <div className="text-center">
                        <div className="text-2xl font-bold">{selectedTool.performance.availability}%</div>
                        <div className="text-sm text-muted-foreground">Availability</div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Parameters</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-3">
                      {selectedTool.parameters.map((param, index) => (
                        <div key={index} className="border rounded-lg p-3">
                          <div className="flex items-center justify-between mb-1">
                            <span className="font-medium">{param.name}</span>
                            <div className="flex gap-2">
                              <Badge variant="outline" className="text-xs">{param.type}</Badge>
                              {param.required && <Badge variant="destructive" className="text-xs">Required</Badge>}
                            </div>
                          </div>
                          {param.description && (
                            <p className="text-sm text-muted-foreground mb-1">{param.description}</p>
                          )}
                          {param.example && (
                            <code className="text-xs bg-muted px-2 py-1 rounded">
                              Example: {JSON.stringify(param.example)}
                            </code>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              
              <TabsContent value="execution" className="space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold">Tool Execution</h3>
                  <Button 
                    onClick={() => setIsExecutionDialogOpen(true)}
                    className="gap-2"
                  >
                    <Play className="h-4 w-4" />
                    Execute Tool
                  </Button>
                </div>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Endpoint Information</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Badge>{selectedTool.method}</Badge>
                      <code className="text-sm bg-muted px-2 py-1 rounded flex-1">
                        {selectedTool.endpoint}
                      </code>
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Recent Executions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      {Array.from({ length: 5 }, (_, i) => (
                        <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                          <div className="flex items-center gap-2">
                            {Math.random() > 0.8 ? (
                              <XCircle className="h-4 w-4 text-red-500" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4 text-green-500" />
                            )}
                            <span className="text-sm">
                              Execution #{Math.floor(Math.random() * 1000000)}
                            </span>
                          </div>
                          <div className="text-right">
                            <div className="text-sm font-medium">
                              {Math.floor(Math.random() * 500) + 100}ms
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {new Date(Date.now() - Math.random() * 86400000).toLocaleString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              
              <TabsContent value="monitoring" className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Monitoring Status</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Monitoring Enabled</span>
                        <Switch checked={selectedTool.monitoring.enabled} />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Alerts Enabled</span>
                        <Switch checked={selectedTool.monitoring.alertsEnabled} />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm">Logging Level</span>
                        <Badge variant="outline">{selectedTool.monitoring.loggingLevel}</Badge>
                      </div>
                    </CardContent>
                  </Card>
                  
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Health Status</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${statusColors[selectedTool.status]}`} />
                        <span className="text-sm capitalize">{selectedTool.status}</span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Last health check: 2 minutes ago
                      </div>
                    </CardContent>
                  </Card>
                </div>
                
                {toolMetrics && (
                  <>
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm">Error Analysis</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {toolMetrics.topErrors.map((error, index) => (
                            <div key={index} className="flex items-center justify-between">
                              <span className="text-sm">{error.error}</span>
                              <Badge variant="destructive">{error.count}</Badge>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                    
                    <Card>
                      <CardHeader>
                        <CardTitle className="text-sm">Usage Trends</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-2">
                          {toolMetrics.usageByDay.slice(0, 5).map((day, index) => (
                            <div key={index} className="flex items-center justify-between">
                              <span className="text-sm">{day.date}</span>
                              <div className="flex items-center gap-2">
                                <span className="text-sm">{day.executions}</span>
                                {day.errors > 0 && (
                                  <Badge variant="destructive" className="text-xs">{day.errors} errors</Badge>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  </>
                )}
              </TabsContent>
              
              <TabsContent value="security" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Security Configuration</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Authentication Required</span>
                      <Switch checked={selectedTool.security.authRequired} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm">Rate Limited</span>
                      <Switch checked={selectedTool.security.rateLimited} />
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Allowed Origins</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1">
                      {selectedTool.security.allowedOrigins.map((origin, index) => (
                        <code key={index} className="text-sm bg-muted px-2 py-1 rounded block">
                          {origin}
                        </code>
                      ))}
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Permissions</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {selectedTool.security.permissions.map((permission, index) => (
                        <Badge key={index} variant="outline">{permission}</Badge>
                      ))}
                      {selectedTool.security.permissions.length === 0 && (
                        <span className="text-sm text-muted-foreground">No specific permissions required</span>
                      )}
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
              
              <TabsContent value="settings" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Gateway Assignment</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2">
                      <Label>Assigned Gateways</Label>
                      <div className="flex flex-wrap gap-2">
                        {selectedTool.gatewayIds.map((gatewayId, index) => (
                          <Badge key={index} variant="secondary">
                            Gateway {gatewayId.split('_')[1]}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Tool Configuration</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label>Tool Name</Label>
                      <Input value={selectedTool.name} readOnly />
                    </div>
                    <div>
                      <Label>Description</Label>
                      <Textarea value={selectedTool.description} readOnly />
                    </div>
                    <div>
                      <Label>Version</Label>
                      <Input value={selectedTool.version} readOnly />
                    </div>
                  </CardContent>
                </Card>
                
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">Danger Zone</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium">Delete Tool</div>
                        <div className="text-xs text-muted-foreground">
                          This action cannot be undone
                        </div>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="destructive" size="sm">
                            <Trash2 className="h-4 w-4 mr-2" />
                            Delete
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Tool</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete "{selectedTool.name}"? This action cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => {
                                deleteToolMutation.mutate(selectedTool.id)
                                setSelectedTool(null)
                              }}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          )}
        </SheetContent>
      </Sheet>

      {/* Tool Execution Dialog */}
      <Dialog open={isExecutionDialogOpen} onOpenChange={setIsExecutionDialogOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Execute Tool: {selectedTool?.name}</DialogTitle>
            <DialogDescription>
              Test your tool with custom input parameters
            </DialogDescription>
          </DialogHeader>
          
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-4">
              <div>
                <Label>Input Parameters (JSON)</Label>
                <Textarea
                  placeholder="Enter JSON input parameters..."
                  value={executionInput}
                  onChange={(e) => setExecutionInput(e.target.value)}
                  className="h-64 font-mono"
                />
              </div>
              <Button 
                onClick={handleExecuteTool}
                disabled={executionLoading}
                className="w-full gap-2"
              >
                {executionLoading ? (
                  <>
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-current" />
                    Executing...
                  </>
                ) : (
                  <>
                    <Play className="h-4 w-4" />
                    Execute Tool
                  </>
                )}
              </Button>
            </div>
            
            <div className="space-y-4">
              <Label>Execution Result</Label>
              <div className="h-64 border rounded-md p-4 bg-muted font-mono text-sm overflow-auto">
                {executionResult ? (
                  <pre>{JSON.stringify(executionResult, null, 2)}</pre>
                ) : (
                  <span className="text-muted-foreground">No execution result yet</span>
                )}
              </div>
              {executionResult && (
                <div className="flex items-center gap-2">
                  {executionResult.status === 'completed' ? (
                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                  ) : (
                    <XCircle className="h-4 w-4 text-red-500" />
                  )}
                  <span className="text-sm capitalize">{executionResult.status}</span>
                  {executionResult.duration && (
                    <span className="text-sm text-muted-foreground">
                      ({executionResult.duration}ms)
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}