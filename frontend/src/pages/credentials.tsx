import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation, useSearchParams } from 'react-router-dom'
import { Key, Shield, Plus, MoreHorizontal, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
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
import { DataTable, createActionsColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { QueryError } from '@/components/ui/query-error'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PageHeader } from '@/components/layout/page-header'
import { useConfirm } from '@/components/ui/confirm-dialog'
// formatDate is the shared one from lib/utils: a local copy here returned
// relative time ("3h ago") while every other page showed "Jan 5, 2026".
import { cn, formatDate } from '@/lib/utils'
import { credentialsApi, accessKeysApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { TeamFilter, useTeamLookup, VisibilityBadge, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import { getApiErrorMessage } from '@/lib/api-error'
import type { VaultCredential, AccessKey } from '@/types'
import { SECRET_TYPES } from '@/components/credentials/schema'

export function CredentialsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const tab = location.pathname.includes('/access-keys') ? 'access-keys' : 'secrets'
  const setTab = (t: string) => navigate(t === 'secrets' ? '/credentials' : '/credentials/access-keys')

  // Adding a credential is a page of its own now; ?new=1 from older
  // links lands there.
  const [searchParams] = useSearchParams()
  useEffect(() => {
    if (searchParams.get('new') === '1') navigate('/credentials/new', { replace: true })
  }, [searchParams, navigate])

  useEffect(() => { document.title = 'Credentials | almyty'; return () => { document.title = 'almyty' } }, [])

  return (
    <div className="space-y-6">
      <PageHeader
        title="Credentials"
        description="Manage vault credentials and access keys for your APIs and agents"
        actions={
          tab === 'secrets' ? (
            <Button onClick={() => navigate('/credentials/new')}>
              <Plus className="h-4 w-4 mr-2" /> Add credential
            </Button>
          ) : (
            <Button onClick={() => navigate('/credentials/access-keys/new')}>
              <Plus className="h-4 w-4 mr-2" /> Generate key
            </Button>
          )
        }
      />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="secrets" className="gap-1.5"><Shield className="h-4 w-4" />Vault</TabsTrigger>
          <TabsTrigger value="access-keys" className="gap-1.5"><Key className="h-4 w-4" />Access keys</TabsTrigger>
        </TabsList>
      </Tabs>
      <div>
        {tab === 'secrets' && <SecretsTab />}
        {tab === 'access-keys' && <AccessKeysTab />}
      </div>
    </div>
  )
}

function SecretsTab() {
  const qc = useQueryClient(), notify = useNotifications()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)
  const [credentialToDelete, setCredentialToDelete] = useState<VaultCredential | null>(null)

  const { data: credentialsRaw, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['credentials'], queryFn: () => credentialsApi.getAll(),
  })
  const credentials: VaultCredential[] = Array.isArray(credentialsRaw) ? credentialsRaw : (credentialsRaw as any)?.credentials || []
  const visibleCredentials = filterByTeamVisibility(credentials as any[], teamFilter)
  const deleteMut = useMutation({
    mutationFn: (id: string) => credentialsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credentials'] }); setCredentialToDelete(null); notify.success('Credential deleted', 'The secret has been removed from the vault.') },
    // A failed delete used to be silent: the dialog closed and the row
    // stayed, which reads as a UI glitch rather than a rejected request.
    onError: (err) => { setCredentialToDelete(null); notify.error('Failed to delete credential', getApiErrorMessage(err, 'Please try again.')) },
  })

  const columns = [
    { accessorKey: 'name', header: 'Name', cell: ({ row }: any) => (
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center"><Shield className="h-4 w-4 text-primary" /></div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">{row.original.name}</span>
            <VisibilityBadge
              visibility={row.original.visibility}
              teamId={row.original.teamId}
              teamLookup={teamLookup}
            />
          </div>
          {row.original.description && <div className="text-xs text-muted-foreground truncate max-w-[200px]">{row.original.description}</div>}
        </div>
      </div>
    )},
    { accessorKey: 'type', header: 'Type', cell: ({ row }: any) => (
      <Badge variant="secondary">{SECRET_TYPES.find(t => t.value === row.original.type)?.label || row.original.type}</Badge>
    )},
    { accessorKey: 'usedBy', header: 'Used By', cell: ({ row }: any) => {
      const usedBy = row.original.usedBy || []
      if (!usedBy.length) return <span className="text-muted-foreground text-sm">--</span>
      return (
        <div className="flex gap-1 flex-wrap">
          {usedBy.slice(0, 3).map((u: any, i: number) => <Badge key={i} variant="outline" className="text-xs">{u.name || u.type}</Badge>)}
          {usedBy.length > 3 && <Badge variant="outline" className="text-xs">+{usedBy.length - 3}</Badge>}
        </div>
      )
    }},
    { accessorKey: 'isActive', header: 'Status', cell: ({ row }: any) => {
      const c = row.original, isExpired = c.expiresAt && new Date(c.expiresAt) < new Date()
      if (isExpired) return <Badge variant="destructive">Expired</Badge>
      return c.isActive ? <Badge variant="success">Active</Badge> : <Badge variant="secondary">Inactive</Badge>
    }},
    createActionsColumn<VaultCredential>({ cell: ({ row }: any) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button variant="ghost" className="h-8 w-8 p-0" aria-label="Open actions menu"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* View + Edit had no onClick handlers and silently no-op'd;
              drop them until a real detail/edit dialog exists. Delete
              is the only actionable item right now. */}
          <DropdownMenuItem className="text-destructive" onClick={() => setCredentialToDelete(row.original)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )}),
  ]

  return (
    <>
      {isError ? (
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load credentials" />
      ) : !isLoading && credentials.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Shield}
          title="No credentials yet"
          description="The vault holds API keys, tokens and passwords your APIs and agents use. Values are encrypted and never shown again."
          action={
            <Button onClick={() => navigate('/credentials/new')}>
              <Plus className="h-4 w-4 mr-2" /> Add credential
            </Button>
          }
        />
      ) : (
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center justify-end">
            <TeamFilter
              organizationId={currentOrganization?.id}
              value={teamFilter}
              onChange={setTeamFilter}
            />
          </div>
          <DataTable columns={columns} data={visibleCredentials} loading={isLoading} searchKey="name" searchPlaceholder="Search credentials..." />
        </CardContent>
      </Card>
      )}
      {/*
        Deleting a vault secret is irreversible and the row menu is one
        click away from Copy, so it goes through a confirm that names the
        credential rather than firing the mutation straight from the menu.
      */}
      <AlertDialog
        open={credentialToDelete !== null}
        onOpenChange={(open) => { if (!open) setCredentialToDelete(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete credential?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete "{credentialToDelete?.name}" from the vault.
              Anything using it will stop authenticating. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (credentialToDelete) {
                  deleteMut.mutate(credentialToDelete.id)
                }
              }}
              variant="destructive"
            >
              Delete credential
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AccessKeysTab() {
  const qc = useQueryClient(), notify = useNotifications()
  const navigate = useNavigate()

  const { data: keysRaw, isLoading, isError, error, refetch } = useQuery({ queryKey: ['access-keys'], queryFn: () => accessKeysApi.getAll() })
  const keys: AccessKey[] = Array.isArray(keysRaw) ? keysRaw : (keysRaw as any)?.keys || (keysRaw as any)?.accessKeys || []

  const revokeMut = useMutation({
    mutationFn: (id: string) => accessKeysApi.revoke(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['access-keys'] }); notify.success('Access key revoked', 'The key can no longer be used.') },
    onError: (err) => notify.error('Failed to revoke access key', getApiErrorMessage(err, 'Please try again.')),
  })
  const { confirm, dialog: confirmDialog } = useConfirm()
  const handleRevoke = async (key: AccessKey) => {
    const ok = await confirm({
      title: 'Revoke this access key?',
      description: `"${key.name}" stops working immediately. Anything still using it will be refused. This cannot be undone.`,
      confirmLabel: 'Revoke key',
      destructive: true,
    })
    if (ok) revokeMut.mutate(key.id)
  }

  const columns = [
    { accessorKey: 'keyPrefix', header: 'Key', cell: ({ row }: any) => <code className="text-xs bg-muted px-2 py-1 rounded">{row.original.keyPrefix}...</code> },
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'resource', header: 'Resource', cell: ({ row }: any) => {
      const k = row.original
      if (k.gateway) return <Badge variant="outline">{k.gateway.name}</Badge>
      if (k.agent) return <Badge variant="secondary">{k.agent.name}</Badge>
      return <span className="text-muted-foreground text-sm">--</span>
    }},
    { accessorKey: 'scopes', header: 'Scopes', cell: ({ row }: any) => (
      <div className="flex gap-1 flex-wrap">{(row.original.scopes || []).map((s: string) => <Badge key={s} variant="outline" className="text-xs">{s}</Badge>)}</div>
    )},
    { accessorKey: 'lastUsedAt', header: 'Last Used', cell: ({ row }: any) => <span className="text-sm text-muted-foreground">{row.original.lastUsedAt ? formatDate(row.original.lastUsedAt) : 'Never'}</span> },
    { accessorKey: 'createdAt', header: 'Created', cell: ({ row }: any) => <span className="text-sm text-muted-foreground">{formatDate(row.original.createdAt)}</span> },
    createActionsColumn<AccessKey>({ cell: ({ row }: any) => (
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => void handleRevoke(row.original)}>
        <Trash2 className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">Revoke</span>
      </Button>
    )}),
  ]

  return (
    <>
      {isError ? (
        <QueryError error={error} onRetry={() => refetch()} title="Couldn't load access keys" />
      ) : !isLoading && keys.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Key}
          title="No access keys yet"
          description="An access key lets a script or another service call one of your gateways or agents."
          action={
            <Button onClick={() => navigate('/credentials/access-keys/new')}>
              <Plus className="h-4 w-4 mr-2" /> Generate key
            </Button>
          }
        />
      ) : (
      <Card>
        <CardContent className="pt-6">
          <DataTable columns={columns} data={keys} loading={isLoading} searchKey="name" searchPlaceholder="Search access keys..." />
        </CardContent>
      </Card>
      )}
      {confirmDialog}
    </>
  )
}