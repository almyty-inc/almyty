import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { getApiErrorMessage } from '@/lib/api-error'
import { Router, Plus, Search, Zap, Building2 } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/layout/page-header'
import { PageIntro } from '@/components/onboarding/page-intro'
import { QueryError } from '@/components/ui/query-error'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DataTable, createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import type { ColumnDef } from '@tanstack/react-table'

import { gatewaysApi } from '@/lib/api'
import { gatewaysQuery } from '@/lib/list-queries'
import { pluralized } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { TeamFilter, useTeamLookup, VisibilityBadge, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import type { Gateway } from '@/types'

/**
 * Gateway types that are really messaging distributions of an app.
 * Managed under Apps, not here.
 */
const CHANNEL_GATEWAY_TYPES: string[] = [
  'slack', 'discord', 'telegram', 'whatsapp', 'whatsapp_cloud', 'sms',
  'microsoft_teams', 'google_chat', 'email', 'signal', 'matrix', 'irc',
  'webhook', 'chat_widget', 'hosted_chat',
]

export function GatewaysPage() {
  useEffect(() => {
    document.title = 'Gateways | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const navigate = useNavigate()
  // Old ?new=1 links (the command palette, bookmarks) land on the create page.
  useNewParamRedirect('/gateways/new')
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [searchQuery, setSearchQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')

  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  const { data: gatewaysData, isLoading, isError, error: gatewaysError, refetch: refetchGateways } = useQuery({
    ...gatewaysQuery(currentOrganization?.id),
    enabled: !!currentOrganization,
  })

  const gateways = gatewaysData?.items ?? []

  // Gateways is the protocol page: MCP, A2A, ACP, UTCP, Skills and the
  // OpenAI-compatible endpoint. Messaging platforms are reached through
  // Apps instead, because there they are a distribution of a product
  // rather than a standalone endpoint. Showing them in both places let
  // someone create a Slack gateway here and a Slack distribution there
  // and end up with two records for one Slack app.
  const protocolOnly = (gateways as Gateway[]).filter(
    (gateway) => !CHANNEL_GATEWAY_TYPES.includes(gateway.type as string),
  )

  const filteredGateways = filterByTeamVisibility(protocolOnly as any[], teamFilter).filter((gateway: Gateway) => {
    const matchesSearch =
      gateway.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (gateway.description || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
      gateway.endpoint.toLowerCase().includes(searchQuery.toLowerCase())

    const matchesType = typeFilter === 'all' || gateway.type === typeFilter
    const matchesStatus = statusFilter === 'all' || gateway.status === statusFilter

    return matchesSearch && matchesType && matchesStatus
  })


  // Delete gateway mutation
  const deleteGatewayMutation = useMutation({
    mutationFn: async (gatewayId: string) => {
      return await gatewaysApi.delete(gatewayId)
    },
    onSuccess: async () => {
      success('Gateway deleted', 'Gateway has been deleted successfully.')
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
    },
    onError: (err: unknown) => {
      errorNotif('Failed to delete gateway', getApiErrorMessage(err, 'Please try again.'))
    }
  })

  // Gateway columns for DataTable
  const gatewayColumns: ColumnDef<Gateway>[] = [
    {
      ...createSortableColumn('name', 'Gateway'),
      cell: ({ row }) => {
        const gateway = row.original
        return (
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <Router className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-base">{gateway.name}</h3>
                <VisibilityBadge
                  visibility={(gateway as any).visibility}
                  teamId={(gateway as any).teamId}
                  teamLookup={teamLookup}
                />
              </div>
              <div className="text-sm text-muted-foreground">{gateway.description || 'API Gateway'}</div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'type',
      header: 'Type',
      cell: ({ row }) => {
        const gateway = row.original
        const type = gateway.type
        return (
          <div className="flex items-center gap-1.5">
            <ProtocolBadge protocol={type || 'mcp'} />
            {gateway.kind === 'agent' && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">Agent</Badge>
            )}
            {gateway.isSystem && (
              <Badge className="text-[10px] px-1.5 py-0 border-transparent bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">System</Badge>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: 'endpoint',
      header: 'Endpoint',
      cell: ({ row }) => (
        <code className="bg-muted px-2 py-1 rounded text-sm">
          {row.original.endpoint}
        </code>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => {
        const status = row.original.status
        return (
          <Badge variant={status === 'active' ? 'success' : 'secondary'}>
            {status === 'active' ? 'Active' : status}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'tools',
      header: 'Tools',
      cell: ({ row }) => {
        const gateway = row.original
        if (gateway.isSystem) {
          return (
            <div className="text-sm">
              <span className="text-muted-foreground">Built-in tools</span>
            </div>
          )
        }
        // The list response carries a COUNT, not the tools themselves.
        const toolCount = gateway.toolCount ?? gateway.tools?.length ?? 0
        return (
          <div className="text-center text-sm">
            <span className="font-medium">{toolCount}</span>{' '}
            <span className="text-muted-foreground">tools</span>
          </div>
        )
      },
    },
    {
      accessorKey: 'totalRequests',
      header: 'Requests',
      cell: ({ row }) => {
        const total = row.original.totalRequests || 0
        const ok = row.original.successfulRequests || 0
        return (
          <div className="text-sm">
            {total > 0
              ? <><span className="font-medium">{total}</span> <span className="text-muted-foreground">({ok} ok)</span></>
              : <span className="text-muted-foreground">0 requests</span>
            }
          </div>
        )
      },
    },
    createActionsColumn<Gateway>(
      // Editing happens on the gateway's own page, inline.
      (gateway) => navigate(`/gateways/${gateway.id}/edit`),
      async (gateway) => {
        if (gateway.isSystem) return
        const ok = await confirm({
          title: 'Delete this gateway?',
          description: <>This will permanently delete "{gateway.name}". This action cannot be undone.</>,
          confirmLabel: 'Delete gateway',
          destructive: true,
        })
        if (ok) deleteGatewayMutation.mutate(gateway.id)
      },
      [
        {
          label: 'View details',
          onClick: (gateway) => navigate(`/gateways/${gateway.id}`),
        },
        {
          label: 'Copy full URL',
          onClick: async (gateway) => {
            const backendUrl = import.meta.env.ALMYTY_API_BASE_URL || window.location.origin
            const simpleSlug = currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
            const gwSlug = gateway.endpoint?.replace(/^\//, '') || ''
            const fullEndpoint = `${backendUrl}/${simpleSlug}/${gwSlug}`
            try {
              await navigator.clipboard.writeText(fullEndpoint)
              success('Copied!', 'Full endpoint URL copied to clipboard')
            } catch {
              errorNotif('Failed to copy', 'Could not copy endpoint to clipboard')
            }
          },
        },
      ]
    ),
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Gateways"
        description={
          isLoading ? (
            <span className="inline-block w-48 h-4 bg-muted animate-pulse rounded" />
          ) : (
            `${pluralized(gateways.length, 'gateway')} · ${gateways.filter((g: Gateway) => g.status === 'active').length} active · ${pluralized(gateways.filter((g: Gateway) => !g.isSystem).reduce((sum: number, g: Gateway) => sum + (g.toolCount ?? g.tools?.length ?? 0), 0), 'tool assignment')}`
          )
        }
        actions={
          <Button onClick={() => navigate('/gateways/new')} disabled={!currentOrganization}>
            <Plus className="h-4 w-4 mr-2" />
            Create gateway
          </Button>
        }
      />
      <PageIntro topic="gateways" />

      {!currentOrganization ? (
        <EmptyState
          variant="panel"
          icon={Building2}
          title="No organization selected"
          description="Select or create an organization to see its gateways."
        />
      ) : isError ? (
        <QueryError error={gatewaysError} onRetry={() => refetchGateways()} title="Couldn't load gateways" />
      ) : (
        <>

      {/* Gateways Table */}
      {!isLoading && gateways.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Zap}
          title="No gateways yet"
          description="A gateway serves a set of tools over MCP, A2A, UTCP, and Agent Skills — one endpoint, every protocol."
          action={
            <Button onClick={() => navigate('/gateways/new')}>
              <Plus className="h-4 w-4 mr-2" />
              Create gateway
            </Button>
          }
        />
      ) : (
        <Card>
          <CardContent className="pt-6 space-y-4">
            {/* Filters */}
            <div className="flex items-center gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search gateways..."
                    className="pl-10"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>
              </div>
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="mcp">MCP</SelectItem>
                  <SelectItem value="a2a">A2A</SelectItem>
                  <SelectItem value="acp">ACP</SelectItem>
                  <SelectItem value="utcp">UTCP</SelectItem>
                  <SelectItem value="skills">Skills</SelectItem>
                  <SelectItem value="openai_chat">OpenAI Chat</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="discord">Discord</SelectItem>
                  <SelectItem value="telegram">Telegram</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="chat_widget">Chat Widget</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
              <TeamFilter
                organizationId={currentOrganization?.id}
                value={teamFilter}
                onChange={setTeamFilter}
              />
            </div>

            <DataTable
              columns={gatewayColumns}
              data={filteredGateways}
              loading={isLoading}
              onRowClick={(gateway) => navigate(`/gateways/${gateway.id}`)}
              hideSelectionCount
              hideColumnsButton
              hidePaginationWhenSinglePage
            />
          </CardContent>
        </Card>
      )}

      </>
      )}

      {confirmDialog}

    </div>
  )
}
