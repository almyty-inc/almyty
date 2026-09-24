import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ColumnDef } from '@tanstack/react-table'
import { Link, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DataTable, createSelectColumn, createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import { QueryError } from '@/components/ui/query-error'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { useConfirm } from '@/components/ui/confirm-dialog'

import { organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNewParamRedirect } from '@/hooks/use-new-param-redirect'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { formatDate, getInitials } from '@/lib/utils'
import { PageHeader } from '@/components/layout/page-header'
import { Organization, OrganizationPlan } from '@/types'

/**
 * The organizations list. Creating one is /organizations/new; an
 * organization's overview, members and settings are /organizations/:id.
 */
export function OrganizationsPage() {
  const { setCurrentOrganization, removeOrganization } = useOrganizationStore()
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { confirm, dialog: confirmDialog } = useConfirm()

  // Old `?new=1` links (Settings, the palette, bookmarks) land on the create page.
  useNewParamRedirect('/organizations/new')

  React.useEffect(() => {
    document.title = 'Organizations | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const {
    data: organizationsData,
    isLoading,
    isError: orgsError,
    error: orgsErrorValue,
    refetch: refetchOrgs,
  } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => organizationsApi.getAll(),
  })

  const deleteOrgMutation = useMutation({
    mutationFn: organizationsApi.delete,
    onSuccess: (_result, id: string) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      queryClient.removeQueries({ queryKey: ['organization-details', id] })
      // Without this the deleted org stayed selected, and the axios
      // interceptor kept stamping its id on X-Organization-Id for
      // every request the app made afterwards.
      removeOrganization(id)
      success('Organization deleted', 'Organization has been deleted successfully.')
    },
    onError: (err: any) => {
      error('Failed to delete organization', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  const orgPath = (org: Organization, tab?: string) => `/organizations/${org.id}${tab ? `?tab=${tab}` : ''}`

  const orgColumns: ColumnDef<Organization>[] = [
    createSelectColumn('select'),
    {
      ...createSortableColumn('name', 'Name'),
      cell: ({ row }) => {
        const org = row.original
        return (
          <div className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
              <span className="text-sm font-medium">{getInitials(org.name)}</span>
            </div>
            <div>
              {/* A real link: tabbable, announces itself, opens in a new tab. */}
              <Link
                to={orgPath(org)}
                className="font-medium text-left hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded-sm"
              >
                {org.name}
              </Link>
              <div className="text-sm text-muted-foreground">
                {org.memberCount ?? org.members?.length ?? 0} members
              </div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'plan',
      header: 'Plan',
      cell: ({ row }) => {
        // Plan can be undefined on freshly-created orgs whose
        // /organizations list response trims it; fall back to 'free' so
        // the column renders instead of crashing on .charAt.
        const plan = row.original.plan || 'free'
        const colors = {
          [OrganizationPlan.FREE]: 'secondary',
          [OrganizationPlan.BASIC]: 'outline',
          [OrganizationPlan.PRO]: 'default',
          [OrganizationPlan.ENTERPRISE]: 'destructive',
        }
        return (
          <Badge variant={colors[plan] as any}>
            {plan.charAt(0).toUpperCase() + plan.slice(1)}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'createdAt',
      header: 'Created',
      cell: ({ row }) => formatDate(row.original.createdAt),
    },
    {
      accessorKey: 'isActive',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.isActive ? 'success' : 'secondary'}>
          {row.original.isActive ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    createActionsColumn<Organization>(
      (org) => navigate(orgPath(org, 'settings')),
      async (org) => {
        const ok = await confirm({
          title: 'Delete this organization?',
          description: `"${org.name}" and all of its data, including gateways, tools and settings, will be permanently deleted. This cannot be undone.`,
          confirmLabel: 'Delete organization',
          destructive: true,
        })
        if (ok) deleteOrgMutation.mutate(org.id)
      },
      [
        {
          label: 'View details',
          onClick: (org) => navigate(orgPath(org)),
        },
        {
          label: 'Switch to',
          onClick: (org) => setCurrentOrganization(org),
        },
      ]
    ),
  ]

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <LoadingSpinner size="lg" />
      </div>
    )
  }

  // Every signed-in user belongs to at least one organization, so an
  // empty table here is always a failure rather than a fact.
  if (orgsError) {
    return <QueryError error={orgsErrorValue} onRetry={() => refetchOrgs()} title="Couldn't load your organizations" />
  }

  // organizationsApi.getAll() runs through apiGet → extractData, so
  // organizationsData is already the array.
  const orgs = Array.isArray(organizationsData) ? organizationsData : []

  return (
    <div className="space-y-6">
      <PageHeader
        title="Organizations"
        description="Manage your organizations and team members"
        actions={
          <Button asChild>
            <Link to="/organizations/new">
              <Plus className="mr-2 h-4 w-4" />
              Create organization
            </Link>
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Your organizations</CardTitle>
          <CardDescription>
            Manage and switch between your organizations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={orgColumns}
            data={orgs}
            searchKey="name"
            searchPlaceholder="Search organizations..."
            onRowClick={(org) => navigate(orgPath(org))}
          />
        </CardContent>
      </Card>
      {confirmDialog}
    </div>
  )
}
