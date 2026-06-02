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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

import { organizationsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

interface MembersAndTeamsTabProps {
  organizationId?: string
}

export function MembersAndTeamsTab({ organizationId }: MembersAndTeamsTabProps) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const [createTeamDialogOpen, setCreateTeamDialogOpen] = useState(false)
  const [inviteMemberDialogOpen, setInviteMemberDialogOpen] = useState(false)
  const [addToTeamDialogOpen, setAddToTeamDialogOpen] = useState(false)
  const [editTeamDialogOpen, setEditTeamDialogOpen] = useState(false)
  const [selectedTeam, setSelectedTeam] = useState<any>(null)
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

  const members = Array.isArray(membersData) ? membersData : membersData?.data || membersData || []
  const teams = Array.isArray(teamsData) ? teamsData : teamsData?.data || teamsData || []

  // Create team mutation
  const createTeamMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      organizationsApi.createTeam(organizationId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Team created', 'Team has been created successfully.')
      setCreateTeamDialogOpen(false)
      setNewTeamName('')
      setNewTeamDescription('')
    },
    onError: (err: any) => {
      error('Failed to create team', err.response?.data?.message || 'Please try again.')
    },
  })

  // Invite member mutation
  const inviteMemberMutation = useMutation({
    mutationFn: (data: { email: string; role: string }) =>
      organizationsApi.addMember(organizationId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-members', organizationId] })
      success('Member invited', 'Invitation has been sent.')
      setInviteMemberDialogOpen(false)
      setNewMemberEmail('')
      setNewMemberRole('member')
    },
    onError: (err: any) => {
      error('Failed to invite member', err.response?.data?.message || 'Please try again.')
    },
  })

  // Add member to team mutation
  const addToTeamMutation = useMutation({
    mutationFn: (data: { teamId: string; userId: string; role?: string }) =>
      organizationsApi.addTeamMember(organizationId!, data.teamId, { userId: data.userId, role: data.role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization-teams', organizationId] })
      success('Member added to team', 'Member has been added to the team successfully.')
      setAddToTeamDialogOpen(false)
      setSelectedMemberToAdd('')
      setSelectedMemberRole('member')
    },
    onError: (err: any) => {
      error('Failed to add member to team', err.response?.data?.message || 'Please try again.')
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
      setEditTeamDialogOpen(false)
    },
    onError: (err: any) => {
      error('Failed to update team', err.response?.data?.message || 'Please try again.')
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
      error('Failed to update role', err.response?.data?.message || 'Please try again.')
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
      error('Failed to delete team', err.response?.data?.message || 'Please try again.')
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
      error('Failed to remove member', err.response?.data?.message || 'Please try again.')
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
      error('Team name required', 'Please enter a team name.')
      return
    }
    
    createTeamMutation.mutate({
      name: newTeamName.trim(),
      description: newTeamDescription.trim() || undefined,
    })
  }

  const handleInviteMember = () => {
    if (!newMemberEmail.trim()) {
      error('Email required', 'Please enter an email address.')
      return
    }
    
    inviteMemberMutation.mutate({
      email: newMemberEmail.trim(),
      role: newMemberRole,
    })
  }

  const handleAddToTeam = () => {
    if (!selectedMemberToAdd || !selectedTeam) {
      error('Selection required', 'Please select a member and team.')
      return
    }

    addToTeamMutation.mutate({
      teamId: selectedTeam.id,
      userId: selectedMemberToAdd,
      role: selectedMemberRole,
    })
  }

  const openAddToTeamDialog = (team: any) => {
    setSelectedTeam(team)
    setAddToTeamDialogOpen(true)
  }

  const openEditTeamDialog = (team: any) => {
    setSelectedTeam(team)
    setEditTeamName(team.name)
    setEditTeamDescription(team.description || '')
    setEditTeamDialogOpen(true)
  }

  const handleEditTeam = () => {
    if (!editTeamName.trim() || !selectedTeam) {
      error('Team name required', 'Please enter a team name.')
      return
    }

    editTeamMutation.mutate({
      teamId: selectedTeam.id,
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
              <CardTitle>Organization Members</CardTitle>
              <CardDescription>
                Manage who has access to this organization
              </CardDescription>
            </div>
            <Button onClick={() => setInviteMemberDialogOpen(true)}>
              <UserPlus className="h-4 w-4 mr-2" />
              Invite Member
            </Button>
            <Dialog open={inviteMemberDialogOpen} onOpenChange={(next) => { setInviteMemberDialogOpen(next); if (!next) { inviteMemberMutation.reset(); setNewMemberEmail(""); } }}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Invite Member</DialogTitle>
                  <DialogDescription>
                    Send an invitation to join this organization
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="email">Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="user@example.com"
                      value={newMemberEmail}
                      onChange={(e) => setNewMemberEmail(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="role">Role</Label>
                    <Select value={newMemberRole} onValueChange={setNewMemberRole}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="member">Member</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setInviteMemberDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleInviteMember}
                      disabled={inviteMemberMutation.isPending}
                    >
                      {inviteMemberMutation.isPending ? 'Sending...' : 'Send Invitation'}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
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
                        <Button variant="ghost" size="sm">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
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
            <Button onClick={() => setCreateTeamDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create Team
            </Button>
            <Dialog open={createTeamDialogOpen} onOpenChange={setCreateTeamDialogOpen}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create Team</DialogTitle>
                  <DialogDescription>
                    Create a new team to organize your members
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <Label htmlFor="team-name">Team Name</Label>
                    <Input
                      id="team-name"
                      placeholder="e.g. Development Team"
                      value={newTeamName}
                      onChange={(e) => setNewTeamName(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="team-description">Description (optional)</Label>
                    <Textarea
                      id="team-description"
                      placeholder="What does this team work on?"
                      value={newTeamDescription}
                      onChange={(e) => setNewTeamDescription(e.target.value)}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setCreateTeamDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button 
                      onClick={handleCreateTeam}
                      disabled={createTeamMutation.isPending}
                    >
                      {createTeamMutation.isPending ? 'Creating...' : 'Create Team'}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </CardHeader>
          <CardContent>
            {teamsLoading ? (
              <LoadingSpinner />
            ) : teams.length === 0 ? (
              <div className="text-center py-8">
                <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-medium mb-2">No teams yet</h3>
                <p className="text-muted-foreground mb-4">
                  Create teams to organize your organization members
                </p>
                <Button onClick={() => setCreateTeamDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create First Team
                </Button>
              </div>
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
                          onClick={() => openAddToTeamDialog(team)}
                          title="Add member"
                        >
                          <UserPlus className="h-3 w-3" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="sm"
                          onClick={() => openEditTeamDialog(team)}
                          title="Edit team"
                        >
                          <Settings className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={team.isDefault || deleteTeamMutation.isPending}
                          title={team.isDefault ? 'Default team cannot be deleted' : 'Delete team'}
                          onClick={() => {
                            if (team.isDefault) return
                            if (confirm(`Delete team "${team.name}"? This cannot be undone.`)) {
                              deleteTeamMutation.mutate(team.id)
                            }
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                    
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
                                  disabled={removeFromTeamMutation.isPending}
                                  title="Remove from team"
                                  onClick={() => {
                                    if (confirm(`Remove ${member.user?.firstName || 'this member'} from "${team.name}"?`)) {
                                      removeFromTeamMutation.mutate({ teamId: team.id, userId: member.userId })
                                    }
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

    {/* Add Member to Team Dialog */}
    <Dialog open={addToTeamDialogOpen} onOpenChange={setAddToTeamDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Member to {selectedTeam?.name}</DialogTitle>
          <DialogDescription>
            Select an organization member to add to this team
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Select Member</Label>
            <Select value={selectedMemberToAdd} onValueChange={setSelectedMemberToAdd}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a member" />
              </SelectTrigger>
              <SelectContent>
                {members.filter((member: any) => 
                  !selectedTeam?.members?.some((tm: any) => tm.userId === member.userId)
                ).map((member: any) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.firstName} {member.lastName} ({member.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Role in Team</Label>
            <Select value={selectedMemberRole} onValueChange={setSelectedMemberRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">Member</SelectItem>
                <SelectItem value="lead">Lead</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAddToTeamDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleAddToTeam}
              disabled={addToTeamMutation.isPending || !selectedMemberToAdd}
            >
              {addToTeamMutation.isPending ? 'Adding...' : 'Add Member'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Edit Team Dialog */}
    <Dialog open={editTeamDialogOpen} onOpenChange={setEditTeamDialogOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Team</DialogTitle>
          <DialogDescription>
            Update team settings and information
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="edit-team-name">Team Name</Label>
            <Input
              id="edit-team-name"
              value={editTeamName}
              onChange={(e) => setEditTeamName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="edit-team-description">Description</Label>
            <Textarea
              id="edit-team-description"
              value={editTeamDescription}
              onChange={(e) => setEditTeamDescription(e.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEditTeamDialogOpen(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleEditTeam}
              disabled={editTeamMutation.isPending}
            >
              {editTeamMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
    </>
  )
}