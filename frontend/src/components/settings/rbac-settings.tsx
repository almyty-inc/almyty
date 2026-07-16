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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
  const [dialogOpen, setDialogOpen] = useState(false)
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
                setDialogOpen(true)
              }}
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
      <CardHeader className="flex flex-row items-start justify-between gap-4">
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
        <Button
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          New role
        </Button>
      </CardHeader>
      <CardContent>
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

      <RoleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
      />

      {assigning && (
        <AssignUsersDialog
          role={assigning}
          members={members}
          onClose={() => setAssigning(null)}
        />
      )}

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
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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

function RoleDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: CustomRole | null
}) {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const form = useForm<RoleFormData>({
    resolver: zodResolver(roleSchema),
    values: {
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
      onOpenChange(false)
      form.reset()
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
    },
    onError: (err) => error('Failed to save role', getApiErrorMessage(err)),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}>
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit role' : 'New custom role'}</DialogTitle>
            <DialogDescription>
              Grant a curated set of permissions. Use{' '}
              <code className="font-mono text-xs">resource:action</code> strings; wildcards like{' '}
              <code className="font-mono text-xs">agents:*</code> or{' '}
              <code className="font-mono text-xs">*:read</code> are supported.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rbac-role-name">Name</Label>
              <Input
                id="rbac-role-name"
                placeholder="release-manager"
                {...form.register('name')}
              />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="rbac-role-description">Description</Label>
              <Textarea
                id="rbac-role-description"
                placeholder="What this role is for"
                rows={2}
                {...form.register('description')}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="rbac-role-permissions">Permissions</Label>
              <Textarea
                id="rbac-role-permissions"
                placeholder={'agents:read\ntools:manage\naudit:export'}
                rows={4}
                className="font-mono text-sm"
                {...form.register('permissions')}
              />
              <p className="text-xs text-muted-foreground">
                One permission per line (or comma-separated).
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              {editing ? 'Save changes' : 'Create role'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ── Assignments ──────────────────────────────────────────────────────── */

function AssignUsersDialog({
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

  const unassignMutation = useMutation({
    mutationFn: (userId: string) => rbacApi.unassignUser(role.id, userId),
    onSuccess: async () => {
      success('Role unassigned')
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'roles'] })
    },
    onError: (err) => error('Failed to unassign role', getApiErrorMessage(err)),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign “{role.name}”</DialogTitle>
          <DialogDescription>
            Grant this role to a member. Members can hold several custom roles at once.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2 py-2">
          <div className="flex-1 space-y-2">
            <Label>Member</Label>
            <Select value={selectedUser} onValueChange={setSelectedUser}>
              <SelectTrigger aria-label="Select member">
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
        </div>

        <p className="text-xs text-muted-foreground">
          To remove a member from this role, use the unassign action beside their name in the
          member list, or reassign from here.
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
          <Label>Member</Label>
          <Select value={userId} onValueChange={setUserId}>
            <SelectTrigger aria-label="Select member for permissions">
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
  const [dialogOpen, setDialogOpen] = useState(false)
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
      <CardHeader className="flex flex-row items-start justify-between gap-4">
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
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          New policy
        </Button>
      </CardHeader>
      <CardContent>
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

      <PolicyDialog open={dialogOpen} onOpenChange={setDialogOpen} />

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete policy “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
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

function PolicyDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
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
      onOpenChange(false)
      form.reset({ name: '', description: '', effect: 'allow', action: '*', priority: 0 })
      await queryClient.invalidateQueries({ queryKey: ['rbac', 'policies'] })
    },
    onError: (err) => error('Failed to create policy', getApiErrorMessage(err)),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}>
          <DialogHeader>
            <DialogTitle>New access policy</DialogTitle>
            <DialogDescription>
              A rule over request attributes. Set the governed action (or{' '}
              <code className="font-mono text-xs">*</code> for any) and whether it allows or denies.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="rbac-policy-name">Name</Label>
              <Input
                id="rbac-policy-name"
                placeholder="deny-prod-tool-exec"
                {...form.register('name')}
              />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">
                  {form.formState.errors.name.message}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Effect</Label>
                <Select
                  value={form.watch('effect')}
                  onValueChange={(v) => form.setValue('effect', v as 'allow' | 'deny')}
                >
                  <SelectTrigger aria-label="Effect">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow">allow</SelectItem>
                    <SelectItem value="deny">deny</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="rbac-policy-priority">Priority</Label>
                <Input
                  id="rbac-policy-priority"
                  type="number"
                  {...form.register('priority', { valueAsNumber: true })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rbac-policy-action">Action</Label>
              <Input
                id="rbac-policy-action"
                placeholder="tools:execute"
                {...form.register('action')}
              />
              <p className="text-xs text-muted-foreground">
                The action this policy governs. Use <code className="font-mono">*</code> for any.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="rbac-policy-description">Description</Label>
              <Textarea
                id="rbac-policy-description"
                placeholder="What this policy enforces"
                rows={2}
                {...form.register('description')}
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saveMutation.isPending}>
              Create policy
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
