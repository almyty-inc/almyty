/* rbac-settings — Advanced RBAC admin surface (EE, gated by `advanced_rbac`).
 *
 * Custom org roles with explicit permission sets, user assignments, an
 * effective-permission read view, and ABAC policies. The backend
 * `EntitlementGuard` (402) is the real boundary; this surface is wrapped in an
 * `EntitlementGate mode="lock"` so an org without the entitlement sees the
 * Business-tier upgrade prompt instead of a 402. Mirrors sso-settings.tsx.
 */
import { useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ColumnDef } from '@tanstack/react-table'
import { KeyRound, Plus, Shield, Trash2, UserPlus } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { DataTable } from '@/components/ui/data-table'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
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
import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  rbacApi,
  organizationsApi,
  type AbacPolicy,
  type CustomRole,
} from '@/lib/api'

const RBAC_FEATURE = 'advanced_rbac'

interface OrgMember {
  id: string
  firstName?: string
  lastName?: string
  email?: string
  role?: string
}

function memberLabel(m: OrgMember): string {
  const name = [m.firstName, m.lastName].filter(Boolean).join(' ').trim()
  return name ? `${name} (${m.email ?? ''})` : m.email ?? m.id
}

/**
 * Public entry point mounted from the Settings "Roles" tab. Locks the whole
 * surface behind the `advanced_rbac` entitlement — an ungranted org sees the
 * Business-tier upgrade prompt and no `/rbac/*` request is ever fired.
 */
export function RbacSettings() {
  return (
    <EntitlementGate
      feature={RBAC_FEATURE}
      mode="lock"
      fallback={
        <UpgradePrompt
          feature={RBAC_FEATURE}
          title="Advanced RBAC"
          description="Define custom roles with granular permission sets, assign them to members, and layer attribute-based access policies on top of the built-in roles."
        />
      }
    >
      <RbacManager />
    </EntitlementGate>
  )
}

function RbacManager() {
  const { currentOrganization } = useOrganizationStore()
  const orgId = currentOrganization?.id

  const rolesQuery = useQuery({
    queryKey: ['rbac', 'roles'],
    queryFn: () => rbacApi.listRoles(),
  })
  const policiesQuery = useQuery({
    queryKey: ['rbac', 'policies'],
    queryFn: () => rbacApi.listPolicies(),
  })
  const membersQuery = useQuery({
    queryKey: ['organization-members', orgId],
    queryFn: () => organizationsApi.getMembers(orgId!),
    enabled: !!orgId,
  })

  const members: OrgMember[] = Array.isArray(membersQuery.data)
    ? (membersQuery.data as OrgMember[])
    : []

  return (
    <div className="space-y-6">
      <RolesCard roles={rolesQuery.data ?? []} loading={rolesQuery.isLoading} members={members} />
      <EffectivePermissionsCard members={members} />
      <PoliciesCard policies={policiesQuery.data ?? []} loading={policiesQuery.isLoading} />
    </div>
  )
}

/* ── Roles ────────────────────────────────────────────────────────────── */

const roleSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(64, 'Max 64 characters'),
  description: z.string().max(2000).optional(),
  permissions: z.string().optional(),
})
type RoleFormData = z.infer<typeof roleSchema>

/** Split a comma/whitespace/newline separated string into a permission list. */
function parsePermissions(raw: string | undefined): string[] {
  if (!raw) return []
  return [...new Set(raw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean))]
}

function RolesCard({
  roles,
  loading,
  members,
}: {
  roles: CustomRole[]
  loading: boolean
  members: OrgMember[]
}) {
  // Create and edit happen inline above the table; `editing` null + open
  // means "new role".
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CustomRole | null>(null)
  const [deleting, setDeleting] = useState<CustomRole | null>(null)
  const [assigning, setAssigning] = useState<CustomRole | null>(null)

  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const deleteMutation = useMutation({
    mutationFn: (id: string) => rbacApi.deleteRole(id),
    onSuccess: async () => {
      success('Role deleted')
      setDeleting(null)
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
    },
    onError: (err) => error('Failed to delete role', getApiErrorMessage(err)),
  })

  const closeForm = () => {
    setFormOpen(false)
    setEditing(null)
  }

  const columns: ColumnDef<CustomRole>[] = useMemo(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" />
            <span className="font-medium">{row.original.name}</span>
            {!row.original.active && (
              <Badge variant="outline" className="text-muted-foreground">
                inactive
              </Badge>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'description',
        header: 'Description',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {row.original.description || '—'}
          </span>
        ),
      },
      {
        id: 'permissions',
        header: 'Permissions',
        cell: ({ row }) => {
          const perms = row.original.permissions ?? []
          if (perms.length === 0)
            return <span className="text-sm text-muted-foreground">none</span>
          return (
            <div className="flex flex-wrap gap-1">
              {perms.slice(0, 4).map((p) => (
                <Badge key={p} variant="secondary" className="font-mono text-xs">
                  {p}
                </Badge>
              ))}
              {perms.length > 4 && (
                <Badge variant="outline" className="text-xs">
                  +{perms.length - 4}
                </Badge>
              )}
            </div>
          )
        },
      },
      {
        id: 'actions',
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAssigning(row.original)}
              aria-label={`Assign users to ${row.original.name}`}
            >
              <UserPlus className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(row.original)
                setFormOpen(true)
              }}
              aria-label={`Edit ${row.original.name}`}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleting(row.original)}
              aria-label={`Delete ${row.original.name}`}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        ),
      },
    ],
    [],
  )

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-primary" />
            Custom roles
          </CardTitle>
          <CardDescription>
            Org-defined roles carrying an explicit set of{' '}
            <code className="font-mono text-xs">resource:action</code> permissions on top of
            the built-in owner / admin / member / viewer roles.
          </CardDescription>
        </div>
        {!formOpen && (
          <Button
            className="shrink-0"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus className="mr-1.5 h-4 w-4" />
            New role
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {formOpen && <RoleInlineForm key={editing?.id ?? 'new'} editing={editing} onDone={closeForm} />}
        {assigning && (
          <AssignUsersPanel role={assigning} members={members} onClose={() => setAssigning(null)} />
        )}
        <DataTable
          columns={columns}
          data={roles}
          loading={loading}
          searchKey="name"
          searchPlaceholder="Search roles..."
          emptyState={
            <EmptyState
              icon={Shield}
              title="No custom roles yet"
              description="Create a role to grant members a curated slice of permissions."
            />
          }
        />
      </CardContent>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete role “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the role and unassigns it from every member. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/** "New custom role" / "Edit role", inline above the roles table. */
function RoleInlineForm({ editing, onDone }: { editing: CustomRole | null; onDone: () => void }) {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const form = useForm<RoleFormData>({
    resolver: zodResolver(roleSchema),
    defaultValues: {
      name: editing?.name ?? '',
      description: editing?.description ?? '',
      permissions: (editing?.permissions ?? []).join('\n'),
    },
  })

  const saveMutation = useMutation({
    mutationFn: (data: RoleFormData) => {
      const payload = {
        name: data.name.trim(),
        description: data.description?.trim() || undefined,
        permissions: parsePermissions(data.permissions),
      }
      return editing
        ? rbacApi.updateRole(editing.id, payload)
        : rbacApi.createRole(payload)
    },
    onSuccess: async () => {
      success(editing ? 'Role updated' : 'Role created')
      onDone()
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
    },
    onError: (err) => error('Failed to save role', getApiErrorMessage(err)),
  })
  // Cancel and a successful save both close the form, so neither asks.
  const guard = useLeaveGuard(form.formState.isDirty && !saveMutation.isPending)

  return (
    <form
      onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}
      className="space-y-4 rounded-lg border bg-muted/30 p-4"
      aria-label={editing ? `Edit role ${editing.name}` : 'New custom role'}
      noValidate
    >
      <div>
        <h3 className="text-sm font-semibold">{editing ? `Edit role “${editing.name}”` : 'New custom role'}</h3>
        <p className="text-xs text-muted-foreground">
          Grant a curated set of permissions. Use{' '}
          <code className="font-mono">resource:action</code> strings; wildcards like{' '}
          <code className="font-mono">agents:*</code> or <code className="font-mono">*:read</code> are supported.
        </p>
      </div>
      <Field id="rbac-role-name" label="Name" error={form.formState.errors.name?.message}>
        <Input placeholder="release-manager" autoFocus {...form.register('name')} />
      </Field>
      <Field id="rbac-role-description" label="Description">
        <Textarea placeholder="What this role is for" rows={2} {...form.register('description')} />
      </Field>
      <Field id="rbac-role-permissions" label="Permissions" hint="One permission per line (or comma-separated).">
        <Textarea
          placeholder={'agents:read\ntools:manage\naudit:export'}
          rows={4}
          className="font-mono text-sm"
          {...form.register('permissions')}
        />
      </Field>
      <InlineFormActions
        onCancel={onDone}
        submitLabel={editing ? 'Save changes' : 'Create role'}
        submitting={saveMutation.isPending}
      />
      {guard.element}
    </form>
  )
}

/* ── Assignments ──────────────────────────────────────────────────────── */

/** "Assign {role}", an inline panel above the roles table. */
function AssignUsersPanel({
  role,
  members,
  onClose,
}: {
  role: CustomRole
  members: OrgMember[]
  onClose: () => void
}) {
  const [selectedUser, setSelectedUser] = useState('')
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const assignMutation = useMutation({
    mutationFn: (userId: string) => rbacApi.assignUser(role.id, userId),
    onSuccess: async () => {
      success('Role assigned')
      setSelectedUser('')
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
    },
    onError: (err) => error('Failed to assign role', getApiErrorMessage(err)),
  })

  return (
    <section
      className="space-y-3 rounded-lg border bg-muted/30 p-4"
      aria-label={`Assign ${role.name}`}
    >
      <div>
        <h3 className="text-sm font-semibold">Assign “{role.name}”</h3>
        <p className="text-xs text-muted-foreground">
          Grant this role to a member. Members can hold several custom roles at once.
        </p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="rbac-member">Member</Label>
          <Select value={selectedUser} onValueChange={setSelectedUser}>
            <SelectTrigger id="rbac-member" aria-label="Select member">
              <SelectValue placeholder="Select a member" />
            </SelectTrigger>
            <SelectContent>
              {members.length === 0 && (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">
                  No members
                </div>
              )}
              {members.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {memberLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={() => selectedUser && assignMutation.mutate(selectedUser)}
          disabled={!selectedUser || assignMutation.isPending}
        >
          <UserPlus className="mr-1.5 h-4 w-4" />
          Assign
        </Button>
        <Button variant="outline" onClick={onClose}>
          Done
        </Button>
      </div>
    </section>
  )
}

/* ── Effective permissions (read view) ────────────────────────────────── */

function EffectivePermissionsCard({ members }: { members: OrgMember[] }) {
  const [userId, setUserId] = useState('')

  const permsQuery = useQuery({
    queryKey: ['rbac', 'user-permissions', userId],
    queryFn: () => rbacApi.getUserPermissions(userId),
    enabled: !!userId,
  })

  const perms = permsQuery.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-primary" />
          Effective permissions
        </CardTitle>
        <CardDescription>
          The union of every permission a member gains through their assigned custom roles.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-sm space-y-2">
          <Label htmlFor="rbac-member-2">Member</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger id="rbac-member-2" aria-label="Select member for permissions">
              <SelectValue placeholder="Select a member" />
            </SelectTrigger>
            <SelectContent>
              {members.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {memberLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {userId && (
          <div>
            {permsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">Resolving…</p>
            ) : perms.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This member has no custom-role permissions.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {perms.map((p) => (
                  <Badge key={p} variant="secondary" className="font-mono text-xs">
                    {p}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/* ── ABAC policies ────────────────────────────────────────────────────── */

const policySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128, 'Max 128 characters'),
  description: z.string().max(2000).optional(),
  effect: z.enum(['allow', 'deny']),
  action: z.string().max(128).optional(),
  priority: z.number().int().optional(),
})
type PolicyFormData = z.infer<typeof policySchema>

function PoliciesCard({ policies, loading }: { policies: AbacPolicy[]; loading: boolean }) {
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<AbacPolicy | null>(null)

  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const deleteMutation = useMutation({
    mutationFn: (id: string) => rbacApi.deletePolicy(id),
    onSuccess: async () => {
      success('Policy deleted')
      setDeleting(null)
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'policies'] })
    },
    onError: (err) => error('Failed to delete policy', getApiErrorMessage(err)),
  })

  const columns: ColumnDef<AbacPolicy>[] = useMemo(
    () => [
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
      },
      {
        accessorKey: 'effect',
        header: 'Effect',
        cell: ({ row }) => (
          <Badge
            variant="outline"
            className={
              row.original.effect === 'deny'
                ? 'border-destructive/40 text-destructive'
                : 'border-primary/40 text-primary'
            }
          >
            {row.original.effect}
          </Badge>
        ),
      },
      {
        accessorKey: 'action',
        header: 'Action',
        cell: ({ row }) => (
          <code className="font-mono text-xs">{row.original.action}</code>
        ),
      },
      {
        accessorKey: 'priority',
        header: 'Priority',
        cell: ({ row }) => <span className="text-sm">{row.original.priority}</span>,
      },
      {
        id: 'actions',
        header: () => <div className="text-right">Actions</div>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleting(row.original)}
              aria-label={`Delete policy ${row.original.name}`}
            >
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        ),
      },
    ],
    [],
  )

  return (
    <Card>
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            Access policies (ABAC)
          </CardTitle>
          <CardDescription>
            Attribute-based rules layered on top of roles. An applicable{' '}
            <span className="font-medium">deny</span> always wins; higher priority breaks ties.
          </CardDescription>
        </div>
        {!creating && (
          <Button onClick={() => setCreating(true)} className="shrink-0">
            <Plus className="mr-1.5 h-4 w-4" />
            New policy
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {creating && <PolicyInlineForm onDone={() => setCreating(false)} />}
        <DataTable
          columns={columns}
          data={policies}
          loading={loading}
          searchKey="name"
          searchPlaceholder="Search policies..."
          emptyState={
            <EmptyState
              icon={KeyRound}
              title="No policies yet"
              description="Add an ABAC policy to express rules over request attributes."
            />
          }
        />
      </CardContent>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete policy “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

/** "New access policy", inline above the policies table. */
function PolicyInlineForm({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const form = useForm<PolicyFormData>({
    resolver: zodResolver(policySchema),
    defaultValues: { name: '', description: '', effect: 'allow', action: '*', priority: 0 },
  })

  const saveMutation = useMutation({
    mutationFn: (data: PolicyFormData) =>
      rbacApi.createPolicy({
        name: data.name.trim(),
        description: data.description?.trim() || undefined,
        effect: data.effect,
        action: data.action?.trim() || '*',
        priority: Number.isFinite(data.priority) ? (data.priority as number) : 0,
        conditions: [],
      }),
    onSuccess: async () => {
      success('Policy created')
      onDone()
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'policies'] })
    },
    onError: (err) => error('Failed to create policy', getApiErrorMessage(err)),
  })
  // Cancel and a successful create both close the form, so neither asks.
  const guard = useLeaveGuard(form.formState.isDirty && !saveMutation.isPending)

  return (
    <form
      onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}
      className="space-y-4 rounded-lg border bg-muted/30 p-4"
      aria-label="New access policy"
      noValidate
    >
      <div>
        <h3 className="text-sm font-semibold">New access policy</h3>
        <p className="text-xs text-muted-foreground">
          A rule over request attributes. Set the governed action (or{' '}
          <code className="font-mono">*</code> for any) and whether it allows or denies.
        </p>
      </div>
      <Field id="rbac-policy-name" label="Name" error={form.formState.errors.name?.message}>
        <Input placeholder="deny-prod-tool-exec" autoFocus {...form.register('name')} />
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field id="rbac-effect" label="Effect">
          <Select
            value={form.watch('effect')}
            onValueChange={(v) => form.setValue('effect', v as 'allow' | 'deny')}
          >
            <SelectTrigger id="rbac-effect" aria-label="Effect">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="allow">allow</SelectItem>
              <SelectItem value="deny">deny</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="rbac-policy-priority" label="Priority">
          <Input type="number" {...form.register('priority', { valueAsNumber: true })} />
        </Field>
      </div>
      <Field
        id="rbac-policy-action"
        label="Action"
        hint={<>The action this policy governs. Use <code className="font-mono">*</code> for any.</>}
      >
        <Input placeholder="tools:execute" {...form.register('action')} />
      </Field>
      <Field id="rbac-policy-description" label="Description">
        <Textarea placeholder="What this policy enforces" rows={2} {...form.register('description')} />
      </Field>
      <InlineFormActions onCancel={onDone} submitLabel="Create policy" submitting={saveMutation.isPending} />
      {guard.element}
    </form>
  )
}
