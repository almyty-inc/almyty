import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Settings } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { MembersAndTeamsTab } from '@/components/MembersAndTeamsTab'
import { SecurityTab } from '@/components/SecurityTab'
import { authApi, organizationsApi } from '@/lib/api'

export function SettingsPage() {
  useEffect(() => {
    document.title = 'Settings | apifai'
    return () => { document.title = 'apifai' }
  }, [])

  const { currentOrganization } = useOrganizationStore()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your organization and account settings
        </p>
      </div>

      <Tabs defaultValue="organization" className="space-y-4">
        <TabsList>
          <TabsTrigger value="organization">Organization</TabsTrigger>
          <TabsTrigger value="members">Members & Teams</TabsTrigger>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
        </TabsList>

        <TabsContent value="organization" className="space-y-4">
          <OrganizationTab organization={currentOrganization} />
        </TabsContent>

        <TabsContent value="members" className="space-y-4">
          <MembersAndTeamsTab organizationId={currentOrganization?.id} />
        </TabsContent>

        <TabsContent value="profile" className="space-y-4">
          <ProfileTab />
        </TabsContent>

        <TabsContent value="security" className="space-y-4">
          <SecurityTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function OrganizationTab({ organization }: { organization: any }) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const [isEditing, setIsEditing] = useState(false)
  const [orgName, setOrgName] = useState('')
  const [orgDescription, setOrgDescription] = useState('')

  // Fetch full organization details (store may not include createdAt from auth response)
  const { data: orgDetails } = useQuery({
    queryKey: ['organization-details', organization?.id],
    queryFn: () => organizationsApi.getById(organization.id),
    enabled: !!organization?.id,
  })

  // orgDetails is the Axios response; .data is the actual org object
  const fullOrg = orgDetails?.data || organization

  // Initialize form values when organization data loads
  React.useEffect(() => {
    if (organization) {
      setOrgName(organization.name || '')
      setOrgDescription(organization.description || '')
    }
  }, [organization])

  const updateOrgMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      organizationsApi.update(organization.id, data),
    onSuccess: async () => {
      success('Organization updated', 'Organization details have been updated.')
      setIsEditing(false)
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
    },
    onError: (err: any) => {
      error('Failed to update organization', err.response?.data?.message || 'Please try again.')
    },
  })

  if (!organization) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <div className="text-muted-foreground">No organization selected</div>
        </CardContent>
      </Card>
    )
  }

  const handleSave = () => {
    if (!orgName.trim()) {
      error('Organization name required', 'Please enter an organization name.')
      return
    }

    updateOrgMutation.mutate({
      name: orgName.trim(),
      description: orgDescription.trim() || undefined,
    })
  }

  const handleCancel = () => {
    setOrgName(organization.name || '')
    setOrgDescription(organization.description || '')
    setIsEditing(false)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Organization Details</CardTitle>
          <CardDescription>Manage your organization settings</CardDescription>
        </div>
        {!isEditing ? (
          <Button variant="outline" onClick={() => setIsEditing(true)}>
            Edit Organization
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCancel}>Cancel</Button>
            <Button onClick={handleSave} disabled={updateOrgMutation.isPending}>
              {updateOrgMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <label htmlFor="org-name" className="text-sm font-medium text-muted-foreground">Organization Name</label>
          {isEditing ? (
            <Input
              id="org-name"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="mt-1"
            />
          ) : (
            <div className="text-lg font-medium mt-1">{organization.name}</div>
          )}
        </div>

        <div>
          <label htmlFor="org-description" className="text-sm font-medium text-muted-foreground">Description</label>
          {isEditing ? (
            <Input
              id="org-description"
              value={orgDescription}
              onChange={(e) => setOrgDescription(e.target.value)}
              placeholder="Organization description (optional)"
              className="mt-1"
            />
          ) : (
            <div className="text-sm mt-1">{organization.description || <span className="text-muted-foreground italic">No description added</span>}</div>
          )}
        </div>
        
        <div>
          <label className="text-sm font-medium text-muted-foreground">Status</label>
          <div className="flex items-center gap-2 mt-1">
            <div className="w-2 h-2 bg-green-500 rounded-full" />
            <span className="text-sm">Active</span>
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-muted-foreground">Created</label>
          <div className="text-sm mt-1">
            {(fullOrg.createdAt || fullOrg.created_at) ? new Date(fullOrg.createdAt || fullOrg.created_at).toLocaleDateString() : 'Unknown'}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ProfileTab() {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const [isEditing, setIsEditing] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [validationErrors, setValidationErrors] = useState<{ firstName?: string; lastName?: string; email?: string }>({})

  const { data: userProfile, isLoading } = useQuery({
    queryKey: ['user-profile'],
    queryFn: () => authApi.getProfile().then(res => res.data),
  })

  // Initialize form values when profile loads
  React.useEffect(() => {
    if (userProfile && !isEditing) {
      setFirstName(userProfile.firstName || '')
      setLastName(userProfile.lastName || '')
      setEmail(userProfile.email || '')
    }
  }, [userProfile, isEditing])

  const updateProfileMutation = useMutation({
    mutationFn: (data: { name: string; email: string }) =>
      authApi.updateProfile(data),
    onSuccess: async () => {
      success('Profile updated', 'Your profile has been updated successfully.')
      setIsEditing(false)
      await queryClient.invalidateQueries({ queryKey: ['user-profile'] })
    },
    onError: (err: any) => {
      error('Failed to update profile', err.response?.data?.message || 'Please try again.')
    },
  })

  if (isLoading) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <div className="text-muted-foreground">Loading profile...</div>
        </CardContent>
      </Card>
    )
  }
  
  if (!userProfile) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <div className="text-muted-foreground">Failed to load profile</div>
        </CardContent>
      </Card>
    )
  }

  const handleSave = () => {
    const errors: { firstName?: string; lastName?: string; email?: string } = {}

    if (!firstName.trim()) {
      errors.firstName = 'First name is required'
    }
    if (!lastName.trim()) {
      errors.lastName = 'Last name is required'
    }
    if (!email.trim()) {
      errors.email = 'Email is required'
    }

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors)
      // Don't show toast - inline validation errors are more user-friendly
      return
    }

    setValidationErrors({})
    updateProfileMutation.mutate({
      name: `${firstName.trim()} ${lastName.trim()}`,
      email: email.trim(),
    })
  }

  const handleCancel = () => {
    setFirstName(userProfile.firstName || '')
    setLastName(userProfile.lastName || '')
    setEmail(userProfile.email || '')
    setValidationErrors({})
    setIsEditing(false)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Profile Information</CardTitle>
          <CardDescription>Your account details and information</CardDescription>
        </div>
        {!isEditing ? (
          <Button variant="outline" onClick={() => setIsEditing(true)}>
            Edit Profile
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCancel}>Cancel</Button>
            <Button onClick={handleSave} disabled={updateProfileMutation.isPending}>
              {updateProfileMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid grid-cols-2 gap-6">
          <div>
            <label htmlFor="first-name" className="text-sm font-medium text-muted-foreground">First Name</label>
            {isEditing ? (
              <>
                <Input
                  id="first-name"
                  value={firstName}
                  onChange={(e) => {
                    setFirstName(e.target.value)
                    if (validationErrors.firstName) {
                      setValidationErrors({ ...validationErrors, firstName: undefined })
                    }
                  }}
                  className="mt-1"
                />
                {validationErrors.firstName && (
                  <p className="text-sm text-red-600 mt-1">{validationErrors.firstName}</p>
                )}
              </>
            ) : (
              <div className="text-lg font-medium mt-1">{userProfile.firstName}</div>
            )}
          </div>
          <div>
            <label htmlFor="last-name" className="text-sm font-medium text-muted-foreground">Last Name</label>
            {isEditing ? (
              <>
                <Input
                  id="last-name"
                  value={lastName}
                  onChange={(e) => {
                    setLastName(e.target.value)
                    if (validationErrors.lastName) {
                      setValidationErrors({ ...validationErrors, lastName: undefined })
                    }
                  }}
                  className="mt-1"
                />
                {validationErrors.lastName && (
                  <p className="text-sm text-red-600 mt-1">{validationErrors.lastName}</p>
                )}
              </>
            ) : (
              <div className="text-lg font-medium mt-1">{userProfile.lastName}</div>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="email" className="text-sm font-medium text-muted-foreground">Email Address</label>
          {isEditing ? (
            <>
              <Input
                id="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  if (validationErrors.email) {
                    setValidationErrors({ ...validationErrors, email: undefined })
                  }
                }}
                type="email"
                className="mt-1"
              />
              {validationErrors.email && (
                <p className="text-sm text-red-600 mt-1">{validationErrors.email}</p>
              )}
            </>
          ) : (
            <div className="text-lg mt-1">{userProfile.email}</div>
          )}
        </div>
        
        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="text-sm font-medium text-muted-foreground">Account Created</label>
            <div className="text-sm mt-1">
              {new Date(userProfile.createdAt).toLocaleDateString()}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground">Account Status</label>
            <div className="flex items-center gap-2 mt-1">
              <div className="w-2 h-2 bg-green-500 rounded-full" />
              <span className="text-sm">Active</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}