/**
 * /organizations/:id -- one organization: overview, members (invite and
 * role changes inline), settings (rename inline, delete behind a confirm).
 * The tab lives in `?tab=` so a link can open Members or Settings directly.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ColumnDef } from '@tanstack/react-table'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useParams, useSearchParams } from 'react-router-dom'
import { Building, Crown, Eye, Shield, UserPlus, Users } from 'lucide-react'

import { Field, FormPage, FormSection, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { DataTable, createActionsColumn } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { formatDate, getInitials } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { Organization, OrganizationMembership, OrganizationRole } from '@/types'

const ROLE_OPTIONS: Array<{ value: OrganizationRole; label: string }> = [
  { value: OrganizationRole.VIEWER, label: 'Viewer' },
  { value: OrganizationRole.MEMBER, label: 'Member' },
  { value: OrganizationRole.ADMIN, label: 'Admin' },
  { value: OrganizationRole.OWNER, label: 'Owner' },
]

const inviteMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.nativeEnum(OrganizationRole, { message: 'Choose a role' }),
})
type InviteMemberFormData = z.infer<typeof inviteMemberSchema>

const TABS = ['overview', 'members', 'settings'] as const
type OrgTab = (typeof TABS)[number]

export function OrganizationDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab') as OrgTab | null
  const tab: OrgTab = tabParam && (TABS as readonly string[]).includes(tabParam) ? tabParam : 'overview'

  const { data, isLoading } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => organizationsApi.getAll(),
  })
  const orgs: Organization[] = Array.isArray(data) ? data : []
  const org = orgs.find((o) => o.id === id) ?? null
  const back = { to: '/organizations', label: 'Organizations' }

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    )
  }
  if (!org) {
    return (
      <FormPage title="Organization not found" back={back}>
        <EmptyState
          variant="panel"
          icon={Building}
          title="Organization not found"
          description="It may have been deleted, or you are not a member of it."
        />
      </FormPage>
    )
  }

  return (
    <FormPage title={org.name} description="Manage organization settings and members" back={back} width="wide">
      <Tabs
        value={tab}
        onValueChange={(v) => setSearchParams(v === 'overview' ? {} : { tab: v }, { replace: true })}
        className="w-full"
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="members">Members</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="space-y-4">
          <OverviewTab org={org} />
        </TabsContent>
        <TabsContent value="members" className="space-y-4">
          <MembersTab org={org} />
        </TabsContent>
        <TabsContent value="settings" className="space-y-4">
          <SettingsTab org={org} />
        </TabsContent>
      </Tabs>
    </FormPage>
  )
}

function OverviewTab({ org }: { org: Organization }) {
  const stats = [
    { label: 'Members', value: org.memberCount ?? org.members?.length ?? 0 },
    { label: 'Plan', value: org.plan ? String(org.plan).charAt(0).toUpperCase() + String(org.plan).slice(1) : 'Free' },
    { label: 'Gateways', value: org.gateways?.length || 0 },
    { label: 'Tools', value: org.tools?.length || 0 },
  ]
  const limits = [
    { label: 'Gateways', used: org.gateways?.length || 0, max: org.settings?.maxGateways || 10 },
    { label: 'APIs', used: org.apis?.length || 0, max: org.settings?.maxApis || 50 },
    { label: 'Tools', used: org.tools?.length || 0, max: org.settings?.maxTools || 100 },
  ]
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{s.label}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{s.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>
      <FormSection title="Usage limits">
        {limits.map((l) => (
          <div key={l.label} className="space-y-2">
            <div className="flex justify-between text-sm">
              <span>{l.label}</span>
              <span>{l.used} / {l.max}</span>
            </div>
            <Progress value={(l.used / l.max) * 100} />
          </div>
        ))}
      </FormSection>
    </>
  )
}

function MembersTab({ org }: { org: Organization }) {
  const queryClient = useQueryClient()
  const { success, error, warning } = useNotifications()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [inviting, setInviting] = useState(false)
  // Role changes happen in place: the row's role becomes a select.
  const [editingRoleFor, setEditingRoleFor] = useState<string | null>(null)

  const { data: membersData, isLoading } = useQuery({
    queryKey: ['organization-members', org.id],
    queryFn: () => organizationsApi.getMembers(org.id),
  })
  const members: OrganizationMembership[] = Array.isArray(membersData) ? membersData : []

  const updateMemberRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: string }) =>
      organizationsApi.updateMemberRole(org.id, userId, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-members'] })
      success('Member role updated', 'Role has been updated successfully.')
      setEditingRoleFor(null)
    },
    onError: (err: any) => error('Failed to update role', getApiErrorMessage(err, 'Please try again.')),
  })

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => organizationsApi.removeMember(org.id, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-members'] })
      success('Member removed', 'Member has been removed from the organization.')
    },
    onError: (err: any) => error('Failed to remove member', getApiErrorMessage(err, 'Please try again.')),
  })

  const handleRemoveMember = async (member: OrganizationMembership) => {
    const name = member.user?.name || member.email || 'This member'
    const ok = await confirm({
      title: 'Remove this member?',
      description: `${name} will lose access to ${org.name}. Their private resources move to you.`,
      confirmLabel: 'Remove member',
      destructive: true,
    })
    if (ok) removeMemberMutation.mutate(member.userId)
  }

  const memberColumns: ColumnDef<OrganizationMembership>[] = [
    {
      accessorKey: 'user.name',
      header: 'Member',
      cell: ({ row }) => {
        const member = row.original
        const userName = member.user?.name || member.email || 'Unknown User'
        const userEmail = member.user?.email || member.email || ''
        return (
          <div className="flex items-center space-x-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary">
              <span className="text-sm font-medium">{getInitials(userName)}</span>
            </div>
            <div>
              <div className="font-medium">{userName}</div>
              <div className="text-sm text-muted-foreground">{userEmail}</div>
            </div>
          </div>
        )
      },
    },
    {
      accessorKey: 'role',
      header: 'Role',
      cell: ({ row }) => {
        const member = row.original
        // Role can be missing on a stripped membership payload; default to member.
        const role = member.role || OrganizationRole.MEMBER
        if (editingRoleFor === member.userId) {
          const userName = member.user?.name || member.email || 'member'
          return (
            <div className="flex items-center gap-2">
              <Select
                value={role}
                onValueChange={(next) => {
                  if (next !== role) updateMemberRoleMutation.mutate({ userId: member.userId, role: next })
                  else setEditingRoleFor(null)
                }}
                disabled={updateMemberRoleMutation.isPending}
              >
                <SelectTrigger className="h-8 w-32" aria-label={`Role for ${userName}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" variant="ghost" size="sm" onClick={() => setEditingRoleFor(null)}>
                Cancel
              </Button>
            </div>
          )
        }
        const colors = {
          [OrganizationRole.OWNER]: 'destructive',
          [OrganizationRole.ADMIN]: 'default',
          [OrganizationRole.MEMBER]: 'secondary',
          [OrganizationRole.VIEWER]: 'outline',
        }
        const icons = {
          [OrganizationRole.OWNER]: Crown,
          [OrganizationRole.ADMIN]: Shield,
          [OrganizationRole.MEMBER]: Users,
          [OrganizationRole.VIEWER]: Eye,
        }
        const Icon = icons[role] ?? Users
        return (
          <Badge variant={(colors[role] ?? 'secondary') as any} className="flex w-fit items-center gap-1">
            <Icon className="h-3 w-3" />
            {role.charAt(0).toUpperCase() + role.slice(1)}
          </Badge>
        )
      },
    },
    {
      accessorKey: 'joinedAt',
      header: 'Joined',
      cell: ({ row }) => formatDate(row.original.joinedAt),
    },
    createActionsColumn<OrganizationMembership>(
      undefined,
      (member) => { void handleRemoveMember(member) },
      [
        {
          label: 'Change role',
          onClick: (member) => setEditingRoleFor(member.userId),
        },
      ],
    ),
  ]

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-lg font-medium">Team members</h3>
        {!inviting && (
          <Button size="sm" onClick={() => setInviting(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            Invite member
          </Button>
        )}
      </div>
      {inviting && (
        <InviteMemberForm
          org={org}
          onDone={() => setInviting(false)}
          onInvited={(result) => {
            queryClient.invalidateQueries({ queryKey: ['organization-members'] })
            // The mail service returns false rather than throwing, so a
            // refused send must not read as "sent".
            if ((result as any)?.inviteSent === false) {
              warning('Invite created, email not delivered', 'They are invited, but the email could not be sent. Share the invite link with them directly.')
            } else {
              success('Member invited', 'Invitation sent successfully.')
            }
            setInviting(false)
          }}
        />
      )}
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <LoadingSpinner />
        </div>
      ) : (
        <DataTable columns={memberColumns} data={members} searchKey="user.name" searchPlaceholder="Search members..." />
      )}
      {confirmDialog}
    </>
  )
}

function InviteMemberForm({ org, onDone, onInvited }: { org: Organization; onDone: () => void; onInvited: (result: unknown) => void }) {
  const { error } = useNotifications()
  const form = useForm<InviteMemberFormData>({
    resolver: zodResolver(inviteMemberSchema),
    defaultValues: { email: '', role: OrganizationRole.MEMBER },
  })
  const invite = useMutation({
    mutationFn: (data: InviteMemberFormData) => organizationsApi.addMember(org.id, data),
    onSuccess: onInvited,
    onError: (err: any) => error('Failed to invite member', getApiErrorMessage(err, 'Please try again.')),
  })
  // Cancel and a sent invitation both close the form, so neither asks.
  const guard = useLeaveGuard(form.formState.isDirty && !invite.isPending)
  return (
    <form
      onSubmit={form.handleSubmit((d) => invite.mutate(d))}
      className="space-y-4 rounded-lg border bg-muted/30 p-4"
      aria-label="Invite team member"
      noValidate
    >
      <div>
        <h4 className="text-sm font-semibold">Invite team member</h4>
        <p className="text-xs text-muted-foreground">Send an invitation to join {org.name}.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="org-invite-email" label="Email address" required error={form.formState.errors.email?.message}>
          <Input type="email" placeholder="Enter email address" autoFocus {...form.register('email')} />
        </Field>
        <Field id="org-invite-role" label="Role" error={form.formState.errors.role?.message}>
          <Select value={form.watch('role')} onValueChange={(v) => form.setValue('role', v as OrganizationRole)}>
            <SelectTrigger id="org-invite-role"><SelectValue placeholder="Select a role" /></SelectTrigger>
            <SelectContent>
              {ROLE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <InlineFormActions
        onCancel={onDone}
        submitLabel={invite.isPending ? 'Sending...' : 'Send invitation'}
        submitting={invite.isPending}
      />
      {guard.element}
    </form>
  )
}

function SettingsTab({ org }: { org: Organization }) {
  const queryClient = useQueryClient()
  const { upsertOrganization, removeOrganization } = useOrganizationStore()
  const { success, error } = useNotifications()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [name, setName] = useState(org.name)
  const [description, setDescription] = useState(org.description || '')
  const dirty = name !== org.name || description !== (org.description || '')

  const updateOrgMutation = useMutation({
    mutationFn: (data: { name: string; description: string }) => organizationsApi.update(org.id, data),
    onSuccess: (updated: any, data) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      queryClient.invalidateQueries({ queryKey: ['organization-details', org.id] })
      // The store is the other owner of this entity and its
      // currentOrganization is persisted, so a rename that only
      // invalidated a query key survived a reload as the old name.
      upsertOrganization(updated && updated.id ? updated : ({ ...org, ...data } as Organization))
      success('Organization updated', 'Settings saved successfully.')
    },
    onError: (err: any) => error('Failed to update organization', getApiErrorMessage(err, 'Please try again.')),
  })
  // Unsaved settings ask before a navigation throws them away. Reset and a
  // save that lands both bring the fields back in line with the org.
  const guard = useLeaveGuard(dirty && !updateOrgMutation.isPending)

  const deleteOrgMutation = useMutation({
    mutationFn: () => organizationsApi.delete(org.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      queryClient.removeQueries({ queryKey: ['organization-details', org.id] })
      // Without this the deleted org stayed selected, and the axios
      // interceptor kept stamping its id on X-Organization-Id.
      removeOrganization(org.id)
      success('Organization deleted', 'Organization has been deleted successfully.')
      // Gone, so nothing typed into its settings is worth asking about.
      guard.leave('/organizations')
    },
    onError: (err: any) => error('Failed to delete organization', getApiErrorMessage(err, 'Please try again.')),
  })

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete organization?',
      description: `${org.name} and all of its data, including gateways, tools and settings, will be permanently deleted. This cannot be undone.`,
      confirmLabel: 'Delete organization',
      destructive: true,
    })
    if (ok) deleteOrgMutation.mutate()
  }

  return (
    <>
      <FormSection title="Organization settings">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim()) return
            updateOrgMutation.mutate({ name, description })
          }}
          className="space-y-4"
          aria-label="Organization settings"
          noValidate
        >
          <Field id="org-settings-name" label="Organization name" error={!name.trim() ? 'Name is required' : undefined}>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field id="org-settings-description" label="Description">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {dirty && (
            <InlineFormActions
              onCancel={() => {
                setName(org.name)
                setDescription(org.description || '')
              }}
              submitLabel={updateOrgMutation.isPending ? 'Saving...' : 'Save changes'}
              submitting={updateOrgMutation.isPending}
              submitDisabled={!name.trim()}
            />
          )}
        </form>
      </FormSection>
      <FormSection>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Label className="font-medium">Delete organization</Label>
            <p className="text-sm text-muted-foreground">This action cannot be undone. All data will be lost.</p>
          </div>
          <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleteOrgMutation.isPending}>
            Delete organization
          </Button>
        </div>
      </FormSection>
      {confirmDialog}
      {guard.element}
    </>
  )
}
