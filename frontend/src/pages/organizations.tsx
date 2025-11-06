import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ColumnDef } from '@tanstack/react-table'
import { Plus, Users, Settings, CreditCard, Shield, MoreVertical, Eye, Edit, Trash2, UserPlus, Crown, Mail } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DataTable, createSelectColumn, createActionsColumn, createSortableColumn } from '@/components/ui/data-table'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Progress } from '@/components/ui/progress'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

import { organizationsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { formatDate, getInitials, formatCurrency } from '@/lib/utils'
import { Organization, OrganizationMembership, OrganizationRole, OrganizationPlan } from '@/types'

const createOrgSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  description: z.string().optional(),
})

const inviteMemberSchema = z.object({
  email: z.string().email('Invalid email address'),
  role: z.nativeEnum(OrganizationRole),
})

type CreateOrgFormData = z.infer<typeof createOrgSchema>
type InviteMemberFormData = z.infer<typeof inviteMemberSchema>

export function OrganizationsPage() {
  const { currentOrganization, organizations, setCurrentOrganization } = useOrganizationStore()
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  
  const [selectedOrg, setSelectedOrg] = React.useState<Organization | null>(null)
  const [selectedOrgId, setSelectedOrgId] = React.useState<string | null>(null)
  const [createDialogOpen, setCreateDialogOpen] = React.useState(false)
  const [inviteDialogOpen, setInviteDialogOpen] = React.useState(false)
  const [orgDetailsOpen, setOrgDetailsOpen] = React.useState(false)

  const { data: organizationsData, isLoading } = useQuery({
    queryKey: ['organizations'],
    queryFn: () => organizationsApi.getAll(),
  })

  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryKey: ['organization-members', selectedOrgId],
    queryFn: () => selectedOrgId ? organizationsApi.getMembers(selectedOrgId) : null,
    enabled: !!selectedOrgId,
  })

  const createOrgMutation = useMutation({
    mutationFn: organizationsApi.create,
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      success('Organization created', 'Your new organization has been created successfully.')
      setCreateDialogOpen(false)
      setCurrentOrganization(response.data)
    },
    onError: (err: any) => {
      error('Failed to create organization', err.response?.data?.message || 'Please try again.')
    },
  })

  const inviteMemberMutation = useMutation({
    mutationFn: ({ orgId, data }: { orgId: string; data: InviteMemberFormData }) =>
      organizationsApi.addMember(orgId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-members'] })
      success('Member invited', 'Invitation sent successfully.')
      setInviteDialogOpen(false)
    },
    onError: (err: any) => {
      error('Failed to invite member', err.response?.data?.message || 'Please try again.')
    },
  })

  const updateMemberRoleMutation = useMutation({
    mutationFn: ({ orgId, userId, role }: { orgId: string; userId: string; role: string }) =>
      organizationsApi.updateMemberRole(orgId, userId, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-members'] })
      success('Member role updated', 'Role has been updated successfully.')
    },
    onError: (err: any) => {
      error('Failed to update role', err.response?.data?.message || 'Please try again.')
    },
  })

  const removeMemberMutation = useMutation({
    mutationFn: ({ orgId, userId }: { orgId: string; userId: string }) =>
      organizationsApi.removeMember(orgId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-members'] })
      success('Member removed', 'Member has been removed from the organization.')
    },
    onError: (err: any) => {
      error('Failed to remove member', err.response?.data?.message || 'Please try again.')
    },
  })

  const deleteOrgMutation = useMutation({
    mutationFn: organizationsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organizations'] })
      success('Organization deleted', 'Organization has been deleted successfully.')
      setOrgDetailsOpen(false)
    },
    onError: (err: any) => {
      error('Failed to delete organization', err.response?.data?.message || 'Please try again.')
    },
  })

  const createForm = useForm<CreateOrgFormData>({
    resolver: zodResolver(createOrgSchema),
  })

  const inviteForm = useForm<InviteMemberFormData>({
    resolver: zodResolver(inviteMemberSchema),
  })

  const handleCreateOrg = (data: CreateOrgFormData) => {
    createOrgMutation.mutate(data)
  }

  const handleInviteMember = (data: InviteMemberFormData) => {
    if (!selectedOrg) return
    inviteMemberMutation.mutate({ orgId: selectedOrg.id, data })
  }

  const handleUpdateMemberRole = (userId: string, role: string) => {
    if (!selectedOrg) return
    updateMemberRoleMutation.mutate({ orgId: selectedOrg.id, userId, role })
  }

  const handleRemoveMember = (userId: string) => {
    if (!selectedOrg) return
    removeMemberMutation.mutate({ orgId: selectedOrg.id, userId })
  }

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
              <div className="font-medium">{org.name}</div>
              <div className="text-sm text-muted-foreground">
                {org.members?.length || 0} members
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
        const plan = row.original.plan
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
      (org) => {
        setSelectedOrg(org)
        setSelectedOrgId(org.id)
        setOrgDetailsOpen(true)
      },
      (org) => deleteOrgMutation.mutate(org.id),
      [
        {
          label: 'View Details',
          onClick: (org) => {
            setSelectedOrg(org)
            setSelectedOrgId(org.id)
            setOrgDetailsOpen(true)
          },
        },
        {
          label: 'Switch To',
          onClick: (org) => setCurrentOrganization(org),
        },
      ]
    ),
  ]

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
            <div className="w-8 h-8 bg-secondary rounded-full flex items-center justify-center">
              <span className="text-sm font-medium">
                {getInitials(userName)}
              </span>
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
        const role = row.original.role
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
        const Icon = icons[role]
        return (
          <Badge variant={colors[role] as any} className="flex items-center gap-1">
            <Icon className="w-3 h-3" />
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
      (member) => handleRemoveMember(member.userId),
      [
        {
          label: 'Change Role',
          onClick: (member) => {
            const newRole = prompt('Enter new role (owner, admin, member, viewer):')
            if (newRole && Object.values(OrganizationRole).includes(newRole as OrganizationRole)) {
              handleUpdateMemberRole(member.userId, newRole)
            }
          },
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

  const orgs = organizationsData?.data || organizations
  const members = membersData?.data || []

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
          <p className="text-muted-foreground">
            Manage your organizations and team members
          </p>
        </div>
        <div className="flex items-center space-x-2">
          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Create Organization
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Organization</DialogTitle>
                <DialogDescription>
                  Create a new organization to manage your team and resources.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={createForm.handleSubmit(handleCreateOrg)} className="space-y-4">
                <div>
                  <Label htmlFor="name">Organization Name</Label>
                  <Input
                    id="name"
                    placeholder="Enter organization name"
                    {...createForm.register('name')}
                  />
                  {createForm.formState.errors.name && (
                    <p className="text-sm text-red-500 mt-1">
                      {createForm.formState.errors.name.message}
                    </p>
                  )}
                </div>
                <div>
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Textarea
                    id="description"
                    placeholder="Enter organization description"
                    {...createForm.register('description')}
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setCreateDialogOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={createOrgMutation.isPending}
                  >
                    {createOrgMutation.isPending ? 'Creating...' : 'Create'}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Organizations Table */}
      <Card>
        <CardHeader>
          <CardTitle>Your Organizations</CardTitle>
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
            onRowClick={(org) => {
              setSelectedOrg(org)
              setSelectedOrgId(org.id)
              setOrgDetailsOpen(true)
            }}
          />
        </CardContent>
      </Card>

      {/* Organization Details Sheet */}
      <Sheet open={orgDetailsOpen} onOpenChange={(open) => {
        setOrgDetailsOpen(open)
        if (!open) {
          setSelectedOrgId(null)
        }
      }}>
        <SheetContent className="w-[600px] sm:w-[800px]">
          <SheetHeader>
            <SheetTitle className="flex items-center space-x-2">
              {selectedOrg && (
                <>
                  <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
                    <span className="text-sm font-medium">
                      {getInitials(selectedOrg.name)}
                    </span>
                  </div>
                  <span>{selectedOrg.name}</span>
                </>
              )}
            </SheetTitle>
            <SheetDescription>
              Manage organization settings, members, and billing
            </SheetDescription>
          </SheetHeader>

          {selectedOrg && (
            <Tabs defaultValue="overview" className="w-full mt-6">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="members">Members</TabsTrigger>
                <TabsTrigger value="billing">Billing</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Members</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">
                        {selectedOrg.members?.length || 0}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Plan</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <Badge variant="default">
                        {selectedOrg.plan ? String(selectedOrg.plan).charAt(0).toUpperCase() + String(selectedOrg.plan).slice(1) : 'Free'}
                      </Badge>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Gateways</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">
                        {selectedOrg.gateways?.length || 0}
                      </div>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm font-medium">Tools</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="text-2xl font-bold">
                        {selectedOrg.tools?.length || 0}
                      </div>
                    </CardContent>
                  </Card>
                </div>

                <Card>
                  <CardHeader>
                    <CardTitle>Usage Limits</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Gateways</span>
                        <span>
                          {selectedOrg.gateways?.length || 0} / {selectedOrg.settings?.maxGateways || 10}
                        </span>
                      </div>
                      <Progress
                        value={((selectedOrg.gateways?.length || 0) / (selectedOrg.settings?.maxGateways || 10)) * 100}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>APIs</span>
                        <span>
                          {selectedOrg.apis?.length || 0} / {selectedOrg.settings?.maxApis || 50}
                        </span>
                      </div>
                      <Progress
                        value={((selectedOrg.apis?.length || 0) / (selectedOrg.settings?.maxApis || 50)) * 100}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Tools</span>
                        <span>
                          {selectedOrg.tools?.length || 0} / {selectedOrg.settings?.maxTools || 100}
                        </span>
                      </div>
                      <Progress
                        value={((selectedOrg.tools?.length || 0) / (selectedOrg.settings?.maxTools || 100)) * 100}
                      />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="members" className="space-y-4">
                <div className="flex justify-between items-center">
                  <h3 className="text-lg font-medium">Team Members</h3>
                  <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
                    <DialogTrigger asChild>
                      <Button size="sm">
                        <UserPlus className="mr-2 h-4 w-4" />
                        Invite Member
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Invite Team Member</DialogTitle>
                        <DialogDescription>
                          Send an invitation to join {selectedOrg.name}
                        </DialogDescription>
                      </DialogHeader>
                      <form onSubmit={inviteForm.handleSubmit(handleInviteMember)} className="space-y-4">
                        <div>
                          <Label htmlFor="email">Email Address</Label>
                          <Input
                            id="email"
                            type="email"
                            placeholder="Enter email address"
                            {...inviteForm.register('email')}
                          />
                          {inviteForm.formState.errors.email && (
                            <p className="text-sm text-red-500 mt-1">
                              {inviteForm.formState.errors.email.message}
                            </p>
                          )}
                        </div>
                        <div>
                          <Label htmlFor="role">Role</Label>
                          <Select
                            onValueChange={(value) => inviteForm.setValue('role', value as OrganizationRole)}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select a role" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={OrganizationRole.VIEWER}>Viewer</SelectItem>
                              <SelectItem value={OrganizationRole.MEMBER}>Member</SelectItem>
                              <SelectItem value={OrganizationRole.ADMIN}>Admin</SelectItem>
                              <SelectItem value={OrganizationRole.OWNER}>Owner</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex justify-end space-x-2">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => setInviteDialogOpen(false)}
                          >
                            Cancel
                          </Button>
                          <Button
                            type="submit"
                            disabled={inviteMemberMutation.isPending}
                          >
                            {inviteMemberMutation.isPending ? 'Sending...' : 'Send Invitation'}
                          </Button>
                        </div>
                      </form>
                    </DialogContent>
                  </Dialog>
                </div>
                
                {membersLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <LoadingSpinner />
                  </div>
                ) : (
                  <DataTable
                    columns={memberColumns}
                    data={members}
                    searchKey="user.name"
                    searchPlaceholder="Search members..."
                  />
                )}
              </TabsContent>

              <TabsContent value="billing" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="flex items-center space-x-2">
                      <CreditCard className="h-5 w-5" />
                      <span>Billing Information</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <Label>Current Plan</Label>
                        <p className="text-lg font-medium capitalize">{selectedOrg.plan ? String(selectedOrg.plan) : 'free'}</p>
                      </div>
                      {selectedOrg.billingInfo && (
                        <div>
                          <Label>Billing Period</Label>
                          <p className="text-sm">
                            {formatDate(selectedOrg.billingInfo.currentPeriodStart)} - {formatDate(selectedOrg.billingInfo.currentPeriodEnd)}
                          </p>
                        </div>
                      )}
                    </div>
                    
                    <div className="pt-4 border-t">
                      <h4 className="font-medium mb-2">Usage This Month</h4>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span>API Calls</span>
                          <span>12,450 / 50,000</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Tool Executions</span>
                          <span>3,280 / 10,000</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Storage Used</span>
                          <span>2.3 GB / 10 GB</span>
                        </div>
                      </div>
                    </div>

                    <div className="pt-4">
                      <Button>Upgrade Plan</Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="settings" className="space-y-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Organization Settings</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <div>
                      <Label htmlFor="orgName">Organization Name</Label>
                      <Input id="orgName" defaultValue={selectedOrg.name} />
                    </div>
                    <div>
                      <Label htmlFor="orgDescription">Description</Label>
                      <Textarea
                        id="orgDescription"
                        defaultValue={selectedOrg.description}
                      />
                    </div>
                    <div className="flex items-center justify-between pt-4 border-t">
                      <div>
                        <h4 className="font-medium">Delete Organization</h4>
                        <p className="text-sm text-muted-foreground">
                          This action cannot be undone. All data will be lost.
                        </p>
                      </div>
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="destructive">Delete Organization</Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete Organization</AlertDialogTitle>
                            <AlertDialogDescription>
                              Are you sure you want to delete {selectedOrg.name}?
                              This action cannot be undone and will permanently delete
                              all organization data including gateways, tools, and settings.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              onClick={() => deleteOrgMutation.mutate(selectedOrg.id)}
                              className="bg-red-600 hover:bg-red-700"
                            >
                              Delete Organization
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
    </div>
  )
}