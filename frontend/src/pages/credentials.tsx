import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { Key, Shield, Plus, MoreHorizontal, Copy, Trash2, CheckCircle2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { DataTable, createActionsColumn } from '@/components/ui/data-table'
import { cn } from '@/lib/utils'
import { credentialsApi, accessKeysApi, gatewaysApi, agentsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { useCopySensitive } from '@/lib/clipboard'
import { useCreateDeepLink } from '@/hooks/use-create-deep-link'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { TeamFilter, useTeamLookup, VisibilityBadge, filterByTeamVisibility, type TeamFilterValue } from '@/components/ui/team-filter'
import type { VaultCredential, AccessKey } from '@/types'

function formatDate(date: string | null | undefined): string {
  if (!date) return 'Never'
  const d = new Date(date), diff = Date.now() - d.getTime()
  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return d.toLocaleDateString()
}

const SECRET_TYPES = [
  { value: 'api_key', label: 'API Key' }, { value: 'bearer_token', label: 'Bearer Token' },
  { value: 'basic_auth', label: 'Basic Auth' }, { value: 'oauth2', label: 'OAuth2' },
  { value: 'jwt', label: 'JWT' }, { value: 'custom', label: 'Custom' },
]
const SCOPE_OPTIONS = ['read', 'write', 'execute', 'admin']

export function CredentialsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const tab = location.pathname.includes('/access-keys') ? 'access-keys' : 'secrets'
  const setTab = (t: string) => navigate(t === 'secrets' ? '/credentials' : '/credentials/access-keys')

  // Dialog state lifted to page level so buttons in header can trigger them
  const [isCreateSecretOpen, setIsCreateSecretOpen] = useState(false)
  const [isGenerateKeyOpen, setIsGenerateKeyOpen] = useState(false)
  // Honour ?new=1 from the command palette Add Credential action.
  // Opens the secret dialog on the Vault tab; the Access Keys tab
  // has its own generate-key entry if we wire it later.
  useCreateDeepLink(setIsCreateSecretOpen)

  useEffect(() => { document.title = 'Credentials | almyty'; return () => { document.title = 'almyty' } }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">Credentials</h1>
          <p className="text-muted-foreground">Manage vault credentials and access keys for your APIs and agents</p>
        </div>
        {tab === 'secrets' ? (
          <Button onClick={() => setIsCreateSecretOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add Credential
          </Button>
        ) : (
          <Button onClick={() => setIsGenerateKeyOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Generate Key
          </Button>
        )}
      </div>
      <div className="flex items-center gap-1 border-b">
        {([{ key: 'secrets', label: 'Vault', icon: Shield }, { key: 'access-keys', label: 'Access Keys', icon: Key }] as const).map(({ key, label, icon: Icon }) => (
          <button key={key} onClick={() => setTab(key)} className={cn(
            'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
            tab === key ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'
          )}><Icon className="h-4 w-4" />{label}</button>
        ))}
      </div>
      <div>
        {tab === 'secrets' && <SecretsTabWithDialog isCreateOpen={isCreateSecretOpen} setIsCreateOpen={setIsCreateSecretOpen} />}
        {tab === 'access-keys' && <AccessKeysTabWithDialog isOpen={isGenerateKeyOpen} setIsOpen={setIsGenerateKeyOpen} />}
      </div>
    </div>
  )
}

function SecretsTabWithDialog({ isCreateOpen, setIsCreateOpen }: { isCreateOpen: boolean; setIsCreateOpen: (v: boolean) => void }) {
  const qc = useQueryClient(), notify = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const [form, setForm] = useState({ name: '', type: 'api_key', description: '', value: '' })
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [teamFilter, setTeamFilter] = useState<TeamFilterValue>('all')
  const { byId: teamLookup } = useTeamLookup(currentOrganization?.id)

  const { data: credentialsRaw, isLoading } = useQuery({
    queryKey: ['credentials'], queryFn: () => credentialsApi.getAll(),
  })
  const credentials: VaultCredential[] = Array.isArray(credentialsRaw) ? credentialsRaw : (credentialsRaw as any)?.credentials || []
  const visibleCredentials = filterByTeamVisibility(credentials as any[], teamFilter)
  const createMut = useMutation({
    mutationFn: (data: any) => credentialsApi.create(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credentials'] }); setIsCreateOpen(false); setForm({ name: '', type: 'api_key', description: '', value: '' }); notify.success('Created', 'Credential created') },
    onError: () => notify.error('Error', 'Failed to create credential'),
  })
  const deleteMut = useMutation({
    mutationFn: (id: string) => credentialsApi.delete(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['credentials'] }); notify.success('Deleted', 'Credential deleted') },
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
        <DropdownMenuTrigger asChild><Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {/* View + Edit had no onClick handlers and silently no-op'd;
              drop them until a real detail/edit dialog exists. Delete
              is the only actionable item right now. */}
          <DropdownMenuItem className="text-destructive" onClick={() => deleteMut.mutate(row.original.id)}><Trash2 className="h-4 w-4 mr-2" /> Delete</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )}),
  ]

  return (
    <>
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
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Credential</DialogTitle>
            <DialogDescription>Store a credential securely in the vault.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div><label className="text-sm font-medium">Name</label>
              <Input placeholder="e.g. Stripe API Key" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
            <div><label className="text-sm font-medium">Type</label>
              <Select value={form.type} onValueChange={v => setForm(f => ({ ...f, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{SECRET_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
              </Select></div>
            {(form.type === 'api_key' || form.type === 'bearer_token' || form.type === 'jwt') && (
              <div><label className="text-sm font-medium">{form.type === 'api_key' ? 'API Key' : form.type === 'bearer_token' ? 'Token' : 'JWT Token'}</label>
                <Input type="password" placeholder="Enter value..." value={form.value} onChange={e => setForm(f => ({ ...f, value: e.target.value }))} /></div>
            )}
            {form.type === 'basic_auth' && (<>
              <div><label className="text-sm font-medium">Username</label><Input placeholder="Username" onChange={() => {}} /></div>
              <div><label className="text-sm font-medium">Password</label><Input type="password" placeholder="Password" onChange={() => {}} /></div>
            </>)}
            {form.type === 'oauth2' && (<>
              <div><label className="text-sm font-medium">Client ID</label><Input placeholder="Client ID" onChange={() => {}} /></div>
              <div><label className="text-sm font-medium">Client Secret</label><Input type="password" placeholder="Client Secret" onChange={() => {}} /></div>
            </>)}
            <div><label className="text-sm font-medium">Description</label>
              <Input placeholder="Optional description" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
            <div className="border-t pt-4">
              <VisibilityField
                organizationId={currentOrganization?.id ?? ''}
                value={visibility}
                onChange={setVisibility}
              />
            </div>
            <Button className="w-full" disabled={!form.name || createMut.isPending} onClick={() => createMut.mutate({ ...form, visibility: visibility.visibility, teamId: visibility.teamId })}>
              {createMut.isPending ? 'Creating...' : 'Create Credential'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function AccessKeysTabWithDialog({ isOpen, setIsOpen }: { isOpen: boolean; setIsOpen: (v: boolean) => void }) {
  const qc = useQueryClient(), notify = useNotifications()
  const copySensitive = useCopySensitive()
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', resourceType: 'gateway' as 'gateway' | 'agent', resourceId: '', scopes: ['read'] as string[] })

  const { data: keysRaw, isLoading } = useQuery({ queryKey: ['access-keys'], queryFn: () => accessKeysApi.getAll() })
  const keys: AccessKey[] = Array.isArray(keysRaw) ? keysRaw : (keysRaw as any)?.keys || (keysRaw as any)?.accessKeys || []
  const { data: gatewaysRaw } = useQuery({ queryKey: ['gateways'], queryFn: () => gatewaysApi.getAll() })
  const gateways: any[] = Array.isArray(gatewaysRaw) ? gatewaysRaw : (gatewaysRaw as any)?.gateways || []
  const { data: agentsRaw } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.getAll() })
  const agents: any[] = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw as any)?.agents || []

  const createMut = useMutation({
    mutationFn: (data: any) => accessKeysApi.create(data),
    onSuccess: (data: any) => { qc.invalidateQueries({ queryKey: ['access-keys'] }); setGeneratedKey(data?.key || data?.accessKey || 'Key generated'); notify.success('Generated', 'Access key created') },
    onError: () => notify.error('Error', 'Failed to generate key'),
  })
  const revokeMut = useMutation({
    mutationFn: (id: string) => accessKeysApi.revoke(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['access-keys'] }); notify.success('Revoked', 'Access key revoked') },
  })

  const toggleScope = (s: string) => setForm(f => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter(x => x !== s) : [...f.scopes, s] }))
  const handleGenerate = () => {
    const p: any = { name: form.name, scopes: form.scopes }
    if (form.resourceType === 'gateway') p.gatewayId = form.resourceId; else p.agentId = form.resourceId
    createMut.mutate(p)
  }

  // Sync external open state - clear generatedKey when opening fresh
  useEffect(() => {
    if (isOpen) setGeneratedKey(null)
  }, [isOpen])

  const handleClose = (v: boolean) => {
    setIsOpen(v)
    if (!v) setGeneratedKey(null)
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
    { accessorKey: 'lastUsedAt', header: 'Last Used', cell: ({ row }: any) => <span className="text-sm text-muted-foreground">{formatDate(row.original.lastUsedAt)}</span> },
    { accessorKey: 'createdAt', header: 'Created', cell: ({ row }: any) => <span className="text-sm text-muted-foreground">{formatDate(row.original.createdAt)}</span> },
    createActionsColumn<AccessKey>({ cell: ({ row }: any) => (
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => revokeMut.mutate(row.original.id)}>
        <Trash2 className="h-4 w-4 sm:mr-1" /> <span className="hidden sm:inline">Revoke</span>
      </Button>
    )}),
  ]

  return (
    <>
      <Card>
        <CardContent className="pt-6">
          <DataTable columns={columns} data={keys} loading={isLoading} searchKey="name" searchPlaceholder="Search access keys..." />
        </CardContent>
      </Card>
      <Dialog open={isOpen} onOpenChange={handleClose}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{generatedKey ? 'Key Generated' : 'Generate Access Key'}</DialogTitle>
            <DialogDescription>{generatedKey ? 'Copy this key now. It will not be shown again.' : 'Create a new access key for a gateway or agent.'}</DialogDescription>
          </DialogHeader>
          {generatedKey ? (
            <div className="space-y-4 pt-2">
              <div className="flex items-center gap-2 bg-muted p-3 rounded-lg">
                <code className="text-sm flex-1 break-all select-all">{generatedKey}</code>
                <Button variant="ghost" size="sm" aria-label="Copy access key" onClick={() => copySensitive(generatedKey, 'Access key')}><Copy className="h-4 w-4" /></Button>
              </div>
              <div className="flex items-center gap-2 text-amber-600 text-sm"><Key className="h-4 w-4" /> Store this key securely. It cannot be retrieved later.</div>
              <Button className="w-full" onClick={() => { handleClose(false) }}>Done</Button>
            </div>
          ) : (
            <div className="space-y-4 pt-2">
              <div><label className="text-sm font-medium">Name</label>
                <Input placeholder="e.g. Production Key" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
              <div><label className="text-sm font-medium">Resource Type</label>
                <Select value={form.resourceType} onValueChange={(v: 'gateway' | 'agent') => setForm(f => ({ ...f, resourceType: v, resourceId: '' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="gateway">Gateway</SelectItem><SelectItem value="agent">Agent</SelectItem></SelectContent>
                </Select></div>
              <div><label className="text-sm font-medium">{form.resourceType === 'gateway' ? 'Gateway' : 'Agent'}</label>
                <Select value={form.resourceId} onValueChange={v => setForm(f => ({ ...f, resourceId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>{(form.resourceType === 'gateway' ? gateways : agents).map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}</SelectContent>
                </Select></div>
              <div><label className="text-sm font-medium">Scopes</label>
                <div className="flex gap-2 flex-wrap mt-1">
                  {SCOPE_OPTIONS.map(scope => (
                    <button key={scope} type="button" onClick={() => toggleScope(scope)} className={cn(
                      'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                      form.scopes.includes(scope) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:border-primary/50'
                    )}>{form.scopes.includes(scope) && <CheckCircle2 className="h-3 w-3 inline mr-1" />}{scope}</button>
                  ))}
                </div></div>
              <Button className="w-full" disabled={!form.name || !form.resourceId || createMut.isPending} onClick={handleGenerate}>
                {createMut.isPending ? 'Generating...' : 'Generate Key'}</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
