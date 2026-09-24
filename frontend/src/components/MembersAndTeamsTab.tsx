import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Users, Plus, UserPlus, Trash2, Settings } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Field, InlineFormActions } from '@/components/layout/form-page'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { EmptyState } from '@/components/ui/empty-state'
import { useConfirm } from '@/components/ui/confirm-dialog'

import { organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'

interface MembersAndTeamsTabProps {
  organizationId?: string
}

export function MembersAndTeamsTab({ organizationId }: MembersAndTeamsTabProps) {
  const { success, error, warning } = useNotifications()
  const queryClient = useQueryClient()
  // Every create/configure flow here is an inline form in the card it
  // belongs to: invite in Members, create in Teams, add-member and edit on
  // the team itself.
  const [creatingTeam, setCreatingTeam] = useState(false)
  const [inviting, setInviting] = useState(false)
  // Confirmed before it happens: removing someone cuts their access
  // immediately and there is no undo.
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [addToTeamId, setAddToTeamId] = useState<string | null>(null)
  const [editTeamId, setEditTeamId] = useState<string | null>(null)
  const [formErrors, setFormErrors] = useState<Record<string, string>>({})
  const [selectedMemberToAdd, setSelectedMemberToAdd] = useState('')
  const [selectedMemberRole, setSelectedMemberRole] = useState('member')
  const [newTeamName, setNewTeamName] = useState('')
  const [newTeamDescription, setNewTeamDescription] = useState('')
  const [editTeamName, setEditTeamName] = useState('')
  const [editTeamDescription, setEditTeamDescription] = useState('')
  const [newMemberEmail, setNewMemberEmail] = useState('')
  const [newMemberRole, setNewMemberRole] = useState('member')

  // Fetch organization members
  const { data: membersData, isLoading: membersLoading } = useQuery({
    queryKey: ['organization-members', organizationId],
    queryFn: () => organizationsApi.getMembers(organizationId!),
    enabled: !!organizationId,
  })

  // Fetch organization teams
  const { data: teamsData, isLoading: teamsLoading } = useQuery({
    queryKey: ['organization-teams', organizationId],
    queryFn: () => organizationsApi.getTeams(organizationId!),
    enabled: !!organizationId,
  })

  // Fetch pending invites
  const { data: pendingInvitesData } = useQuery({
    queryKey: ['organization-pending-invites', organizationId],
    queryFn: () => organizationsApi.getPendingInvites(organizationId!),
    enabled: !!organizationId,
  })

  // organizationsApi.{getMembers,getTeams} go through apiGet →
  // extractData, so these values are already the flat arrays.
  const members = Array.isArray(membersData) ? membersData : []
  const teams = Array.isArray(teamsData) ? teamsData : []
  const pendingInvites = Array.isArray(pendingInvitesData) ? pendingInvitesData : []

  // Create team mutation
  const createTeamMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      organizationsApi.createTeam(organizationId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Team created', 'Team has been created successfully.')
      setCreatingTeam(false)
      setNewTeamName('')
      setNewTeamDescription('')
    },
    onError: (err: any) => {
      error('Failed to create team', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Invite member mutation
  // The delete button on each member row had no onClick at all, while
  // organizationsApi.removeMember existed and was already used on the
  // /organizations page -- which is not in the sidebar, so Settings is
  // where anyone would actually look.
  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => organizationsApi.removeMember(organizationId!, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', organizationId] })
      success('Member removed', 'They no longer have access to this organization.')
    },
    onError: (err: any) => {
      error('Could not remove member', getApiErrorMessage(err, 'The member was not removed.'))
    },
  })

  const inviteMemberMutation = useMutation({
    mutationFn: (data: { email: string; role: string }) =>
      organizationsApi.addMember(organizationId!, data),
    // The mail service returns false rather than throwing when the
    // provider rejects the send, and this reported "Invitation has been
    // sent" over it -- with a pending-invite row appearing, so the admin
    // had no reason to suspect the teammate would never hear from them.
    onSuccess: (result: any) => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', organizationId] })
      queryClient.invalidateQueries({ queryKey: ['organization-pending-invites', organizationId] })
      if (result?.inviteSent === false) {
        warning(
          'Invite created, email not delivered',
          'They are invited, but the email could not be sent. Share the invite link with them directly.',
        )
      } else {
        success('Member invited', 'Invitation has been sent.')
      }
      setInviting(false)
      setNewMemberEmail('')
      setNewMemberRole('member')
    },
    onError: (err: any) => {
      error('Failed to invite member', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Revoke pending invite mutation
  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) =>
      organizationsApi.revokePendingInvite(organizationId!, inviteId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-pending-invites', organizationId] })
      queryClient.invalidateQueries({ queryKey: ['organization-members', organizationId] })
      success('Invite revoked', 'The pending invite has been revoked.')
    },
    onError: (err: any) => {
      error('Failed to revoke invite', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Add member to team mutation
  const addToTeamMutation = useMutation({
    mutationFn: (data: { teamId: string; userId: string; role?: string }) =>
      organizationsApi.addTeamMember(organizationId!, data.teamId, { userId: data.userId, role: data.role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Member added to team', 'Member has been added to the team successfully.')
      setAddToTeamId(null)
      setSelectedMemberToAdd('')
      setSelectedMemberRole('member')
    },
    onError: (err: any) => {
      error('Failed to add member to team', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Edit team mutation
  const editTeamMutation = useMutation({
    mutationFn: (data: { teamId: string; name: string; description?: string }) =>
      organizationsApi.updateTeam(organizationId!, data.teamId, { 
        name: data.name, 
        description: data.description 
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Team updated', 'Team has been updated successfully.')
      setEditTeamId(null)
    },
    onError: (err: any) => {
      error('Failed to update team', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Update team member role mutation
  const updateRoleMutation = useMutation({
    mutationFn: (data: { teamId: string; userId: string; role: string }) =>
      organizationsApi.updateTeamMemberRole(organizationId!, data.teamId, data.userId, { role: data.role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Role updated', 'Team member role has been updated successfully.')
    },
    onError: (err: any) => {
      error('Failed to update role', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Delete team mutation. Backend refuses if isDefault=true (400);
  // we also disable the button in that case but defend in depth.
  const deleteTeamMutation = useMutation({
    mutationFn: (teamId: string) =>
      organizationsApi.deleteTeam(organizationId!, teamId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Team deleted', 'Team has been deleted successfully.')
    },
    onError: (err: any) => {
      error('Failed to delete team', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  // Remove a single user from a team.
  const removeFromTeamMutation = useMutation({
    mutationFn: (data: { teamId: string; userId: string }) =>
      organizationsApi.removeTeamMember(organizationId!, data.teamId, data.userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Member removed', 'Member has been removed from the team.')
    },
    onError: (err: any) => {
      error('Failed to remove member', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  if (!organizationId) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <p className="text-muted-foreground">No organization selected</p>
        </CardContent>
      </Card>
    )
  }

  const handleCreateTeam = () => {
    if (!newTeamName.trim()) {
      setFormErrors({ newTeamName: 'Enter a team name.' })
      return
    }
    setFormErrors({})
    createTeamMutation.mutate({
      name: newTeamName.trim(),
      description: newTeamDescription.trim() || undefined,
    })
  }

  const handleInviteMember = () => {
    if (!newMemberEmail.trim()) {
      setFormErrors({ newMemberEmail: 'Enter an email address.' })
      return
    }
    setFormErrors({})
    inviteMemberMutation.mutate({
      email: newMemberEmail.trim(),
      role: newMemberRole,
    })
  }

  const handleAddToTeam = (team: any) => {
    if (!selectedMemberToAdd) {
      setFormErrors({ memberToAdd: 'Choose a member to add.' })
      return
    }
    setFormErrors({})
    addToTeamMutation.mutate({
      teamId: team.id,
      userId: selectedMemberToAdd,
      role: selectedMemberRole,
    })
  }

  // One inline team form open at a time.
  const openAddToTeamDialog = (team: any) => {
    setEditTeamId(null)
    setSelectedMemberToAdd('')
    setSelectedMemberRole('member')
    setFormErrors({})
    setAddToTeamId(team.id)
  }

  const openEditTeamDialog = (team: any) => {
    setAddToTeamId(null)
    setEditTeamName(team.name)
    setEditTeamDescription(team.description || '')
    setFormErrors({})
    setEditTeamId(team.id)
  }

  const handleEditTeam = () => {
    if (!editTeamName.trim() || !editTeamId) {
      setFormErrors({ editTeamName: 'Enter a team name.' })
      return
    }
    setFormErrors({})
    editTeamMutation.mutate({
      teamId: editTeamId,
      name: editTeamName.trim(),
      description: editTeamDescription.trim() || undefined,
    })
  }

  return (
    <>
    <Tabs defaultValue="members" className="space-y-4">
      <TabsList>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="teams">Teams</TabsTrigger>
      </TabsList>

      <TabsContent value="members" className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Organization members</CardTitle>
              <CardDescription>
                Manage who has access to this organization
              </CardDescription>
            </div>
            {!inviting && (
              <Button onClick={() => setInviting(true)}>
                <UserPlus className="h-4 w-4 mr-2" />
                Invite member
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {inviting && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleInviteMember() }}
                className="space-y-4 rounded-lg border bg-muted/30 p-4"
                aria-label="Invite member"
                noValidate
              >
                <div>
                  <h4 className="text-sm font-semibold">Invite member</h4>
                  <p className="text-xs text-muted-foreground">Send an invitation to join this organization.</p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field id="email" label="Email address" required error={formErrors.newMemberEmail}>
                    <Input
                      type="email"
                      placeholder="user@example.com"
                      value={newMemberEmail}
                      onChange={(e) => setNewMemberEmail(e.target.value)}
                      autoFocus
                    />
                  </Field>
                  <Field id="role" label="Role">
                    <Select value={newMemberRole} onValueChange={setNewMemberRole}>
                      <SelectTrigger id="role">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                </div>
                <InlineFormActions
                  onCancel={() => { setInviting(false); inviteMemberMutation.reset(); setNewMemberEmail('') }}
                  submitLabel={inviteMemberMutation.isPending ? 'Sending...' : 'Send invitation'}
                  submitting={inviteMemberMutation.isPending}
                />
              </form>
            )}
            {membersLoading ? (
              <LoadingSpinner />
            ) : (
              <div className="space-y-3">
                {members.map((member: any) => (
                  <div key={member.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center">
                        <span className="text-xs font-medium">
                          {member.firstName?.[0]}{member.lastName?.[0]}
                        </span>
                      </div>
                      <div>
                        <div className="font-medium">{member.firstName} {member.lastName}</div>
                        <div className="text-sm text-muted-foreground">{member.email}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={member.role === 'owner' ? 'default' : 'outline'}>
                        {member.role}
                      </Badge>
                      {member.role !== 'owner' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Remove ${member.firstName} ${member.lastName} from the organization`}
                          data-testid={`remove-member-${member.userId ?? member.id}`}
                          disabled={removeMemberMutation.isPending}
                          onClick={async () => {
                            const ok = await confirm({
                              title: `Remove ${[member.firstName, member.lastName].filter(Boolean).join(' ') || 'this member'}?`,
                              description: 'They lose access to this organization immediately. Anything they created stays, their private resources move to you, and you can invite them again.',
                              confirmLabel: 'Remove member',
                              destructive: true,
                            })
                            if (ok) removeMemberMutation.mutate(member.userId ?? member.id)
                          }}
                        >
                          <Trash2 className="h-3 w-3 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {pendingInvites.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Pending invites</CardTitle>
              <CardDescription>
                Invitations waiting for the recipient to accept
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {pendingInvites.map((invite: any) => (
                  <div key={invite.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <div className="font-medium">{invite.email}</div>
                      <div className="text-sm text-muted-foreground">
                        {invite.isExpired ? 'Expired' : `Expires ${new Date(invite.inviteExpiresAt).toLocaleDateString()}`}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{invite.role}</Badge>
                      {invite.isExpired && <Badge variant="destructive">expired</Badge>}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Revoke invite for ${invite.email}`}
                        onClick={async () => {
                          const ok = await confirm({
                            title: 'Revoke this invite?',
                            description: `The invite link sent to ${invite.email} stops working. You can invite them again.`,
                            confirmLabel: 'Revoke invite',
                            destructive: true,
                          })
                          if (ok) revokeInviteMutation.mutate(invite.id)
                        }}
                        disabled={revokeInviteMutation.isPending}
                        title="Revoke invite"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="teams" className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Teams</CardTitle>
              <CardDescription>
                Organize members into teams for better collaboration
              </CardDescription>
            </div>
            {!creatingTeam && (
              <Button onClick={() => setCreatingTeam(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create team
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            {creatingTeam && (
              <form
                onSubmit={(e) => { e.preventDefault(); handleCreateTeam() }}
                className="space-y-4 rounded-lg border bg-muted/30 p-4"
                aria-label="Create team"
                noValidate
              >
                <h4 className="text-sm font-semibold">Create team</h4>
                <Field id="team-name" label="Team name" required error={formErrors.newTeamName}>
                  <Input
                    placeholder="e.g. Development team"
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    autoFocus
                  />
                </Field>
                <Field id="team-description" label="Description (optional)">
                  <Textarea
                    placeholder="What does this team work on?"
                    value={newTeamDescription}
                    onChange={(e) => setNewTeamDescription(e.target.value)}
                  />
                </Field>
                <InlineFormActions
                  onCancel={() => setCreatingTeam(false)}
                  submitLabel={createTeamMutation.isPending ? 'Creating...' : 'Create team'}
                  submitting={createTeamMutation.isPending}
                />
              </form>
            )}
            {teamsLoading ? (
              <LoadingSpinner />
            ) : teams.length === 0 ? (
              !creatingTeam && (
                <EmptyState
                  icon={Users}
                  title="No teams yet"
                  description="Create teams to organize your organization members"
                  action={
                    <Button onClick={() => setCreatingTeam(true)}>
                      <Plus className="h-4 w-4 mr-2" />
                      Create first team
                    </Button>
                  }
                />
              )
            ) : (
              <div className="space-y-3">
                {teams.map((team: any) => (
                  <div key={team.id} className="border rounded-lg p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h4 className="font-medium">{team.name}</h4>
                          {team.isDefault && (
                            <Badge variant="secondary" className="text-xs">Default</Badge>
                          )}
                        </div>
                        {team.description && (
                          <p className="text-sm text-muted-foreground">{team.description}</p>
                        )}
                        {team.createdAt && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Created {new Date(team.createdAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{team.members?.length || 0} members</Badge>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          aria-label={`Add a member to ${team.name}`}
                          onClick={() => openAddToTeamDialog(team)}
                          title="Add member"
                        >
                          <UserPlus className="h-3 w-3" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          aria-label={`Edit team ${team.name}`}
                          onClick={() => openEditTeamDialog(team)}
                          title="Edit team"
                        >
                          <Settings className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete team ${team.name}`}
                          disabled={team.isDefault || deleteTeamMutation.isPending}
                          title={team.isDefault ? 'Default team cannot be deleted' : 'Delete team'}
                          onClick={async () => {
                            if (team.isDefault) return
                            const ok = await confirm({
                              title: 'Delete this team?',
                              description: `"${team.name}" will be deleted. Its members stay in the organization, and its resources become visible to the whole organization. This cannot be undone.`,
                              confirmLabel: 'Delete team',
                              destructive: true,
                            })
                            if (ok) deleteTeamMutation.mutate(team.id)
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>

                    {editTeamId === team.id && (
                      <form
                        onSubmit={(e) => { e.preventDefault(); handleEditTeam() }}
                        className="mb-3 space-y-4 rounded-lg border bg-muted/30 p-4"
                        aria-label={`Edit team ${team.name}`}
                        noValidate
                      >
                        <h5 className="text-sm font-semibold">Edit team</h5>
                        <Field id={`edit-team-name-${team.id}`} label="Team name" required error={formErrors.editTeamName}>
                          <Input value={editTeamName} onChange={(e) => setEditTeamName(e.target.value)} autoFocus />
                        </Field>
                        <Field id={`edit-team-description-${team.id}`} label="Description">
                          <Textarea value={editTeamDescription} onChange={(e) => setEditTeamDescription(e.target.value)} />
                        </Field>
                        <InlineFormActions
                          onCancel={() => setEditTeamId(null)}
                          submitLabel={editTeamMutation.isPending ? 'Saving...' : 'Save changes'}
                          submitting={editTeamMutation.isPending}
                        />
                      </form>
                    )}

                    {addToTeamId === team.id && (
                      <form
                        onSubmit={(e) => { e.preventDefault(); handleAddToTeam(team) }}
                        className="mb-3 space-y-4 rounded-lg border bg-muted/30 p-4"
                        aria-label={`Add member to ${team.name}`}
                        noValidate
                      >
                        <h5 className="text-sm font-semibold">Add member to {team.name}</h5>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <Field id={`members-select-member-${team.id}`} label="Member" required error={formErrors.memberToAdd}>
                            <Select value={selectedMemberToAdd} onValueChange={setSelectedMemberToAdd}>
                              <SelectTrigger id={`members-select-member-${team.id}`}>
                                <SelectValue placeholder="Choose a member" />
                              </SelectTrigger>
                              <SelectContent>
                                {members.filter((member: any) =>
                                  !team.members?.some((tm: any) => tm.userId === member.userId)
                                ).map((member: any) => (
                                  <SelectItem key={member.userId} value={member.userId}>
                                    {member.firstName} {member.lastName} ({member.email})
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Field>
                          <Field id={`members-role-in-team-${team.id}`} label="Role in team">
                            <Select value={selectedMemberRole} onValueChange={setSelectedMemberRole}>
                              <SelectTrigger id={`members-role-in-team-${team.id}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="member">Member</SelectItem>
                                <SelectItem value="lead">Lead</SelectItem>
                              </SelectContent>
                            </Select>
                          </Field>
                        </div>
                        <InlineFormActions
                          onCancel={() => setAddToTeamId(null)}
                          submitLabel={addToTeamMutation.isPending ? 'Adding...' : 'Add member'}
                          submitting={addToTeamMutation.isPending}
                        />
                      </form>
                    )}
                    
                    {team.members && team.members.length > 0 && (
                      <div className="mt-4 pt-4 border-t space-y-3">
                        <div className="text-sm font-medium">Team Members</div>
                        <div className="space-y-2">
                          {team.members.map((member: any) => (
                            <div key={member.userId} className="flex items-center justify-between p-3 bg-muted rounded-lg">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 bg-muted rounded-full flex items-center justify-center">
                                  <span className="text-xs font-medium">
                                    {member.user?.firstName?.[0]}{member.user?.lastName?.[0]}
                                  </span>
                                </div>
                                <div>
                                  <div className="text-sm font-medium">{member.user?.firstName} {member.user?.lastName}</div>
                                  <div className="text-xs text-muted-foreground">{member.user?.email}</div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Select 
                                  value={member.role} 
                                  onValueChange={(newRole) => {
                                    updateRoleMutation.mutate({
                                      teamId: team.id,
                                      userId: member.userId,
                                      role: newRole
                                    })
                                  }}
                                >
                                  <SelectTrigger className="w-24 h-8">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="member">Member</SelectItem>
                                    <SelectItem value="lead">Lead</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  aria-label={`Remove ${member.user?.firstName || 'member'} from ${team.name}`}
                                  disabled={removeFromTeamMutation.isPending}
                                  title="Remove from team"
                                  onClick={async () => {
                                    const ok = await confirm({
                                      title: 'Remove this member from the team?',
                                      description: `${member.user?.firstName || 'This member'} leaves "${team.name}". They stay in the organization.`,
                                      confirmLabel: 'Remove from team',
                                      destructive: true,
                                    })
                                    if (ok) removeFromTeamMutation.mutate({ teamId: team.id, userId: member.userId })
                                  }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
      {confirmDialog}
    </>
  )
}
