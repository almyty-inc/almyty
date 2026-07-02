import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { Settings, Building, Users, User, Shield, ShieldCheck, CreditCard, Gift } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { MembersAndTeamsTab } from '@/components/MembersAndTeamsTab'
import { SecurityTab } from '@/components/SecurityTab'
import { SsoSettings } from '@/components/settings/sso-settings'
import { ReferralsTab } from '@/components/settings/referrals-tab'
import { BillingTab } from '@/components/BillingTab'
import { authApi, organizationsApi } from '@/lib/api'

const SETTINGS_TABS = ['organization', 'members', 'billing', 'referrals', 'profile', 'security', 'sso'] as const
type SettingsTab = typeof SETTINGS_TABS[number]

function getSettingsTab(pathname: string): SettingsTab {
  for (const t of SETTINGS_TABS) {
    if (t !== 'organization' && pathname.includes(`/${t}`)) return t
  }
  return 'organization'
}

export function SettingsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const settingsTab = getSettingsTab(location.pathname)
  const setSettingsTab = (t: string) => navigate(t === 'organization' ? '/settings' : `/settings/${t}`)

  useEffect(() => {
    document.title = 'Settings | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">Settings</h1>
        <p className="text-muted-foreground">
          Manage your organization and account settings
        </p>
      </div>

      <div className="flex items-center gap-1 border-b">
        {([
          { key: 'organization' as SettingsTab, label: 'Organization', icon: Building },
          { key: 'members' as SettingsTab, label: 'Members & Teams', icon: Users },
          { key: 'billing' as SettingsTab, label: 'Billing', icon: CreditCard },
          { key: 'referrals' as SettingsTab, label: 'Referrals', icon: Gift },
          { key: 'profile' as SettingsTab, label: 'Profile', icon: User },
          { key: 'security' as SettingsTab, label: 'Security', icon: Shield },
          { key: 'sso' as SettingsTab, label: 'SSO', icon: ShieldCheck },
        ]).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setSettingsTab(key)}
            className={cn(
              'flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px',
              settingsTab === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      <div>
        {settingsTab === 'organization' && <OrganizationTab organization={currentOrganization} />}
        {settingsTab === 'members' && <MembersAndTeamsTab organizationId={currentOrganization?.id} />}
        {settingsTab === 'billing' && <BillingTab organizationId={currentOrganization?.id} />}
        {settingsTab === 'referrals' && <ReferralsTab />}
        {settingsTab === 'profile' && <ProfileTab />}
        {settingsTab === 'security' && <SecurityTab />}
        {settingsTab === 'sso' && <SsoSettings />}
      </div>
    </div>
  )
}

function OrganizationTab({ organization }: { organization: any }) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const [isEditing, setIsEditing] = useState(false)
  const [orgName, setOrgName] = useState('')
  const [orgDescription, setOrgDescription] = useState('')

  // Agent defaults state
  const [defaultPersonality, setDefaultPersonality] = useState('')
  const [defaultRules, setDefaultRules] = useState('')
  const [defaultMaxCost, setDefaultMaxCost] = useState<number | ''>('')
  const [defaultMaxSteps, setDefaultMaxSteps] = useState<number | ''>('')

  // Fetch full organization details (store may not include createdAt from auth response)
  const { data: orgDetails } = useQuery({
    queryKey: ['organization-details', organization?.id],
    queryFn: () => organizationsApi.getById(organization.id),
    enabled: !!organization?.id,
  })

  // orgDetails IS the org object now (API returns clean data)
  const fullOrg = orgDetails || organization

  // Initialize form values when organization data loads
  React.useEffect(() => {
    if (organization) {
      setOrgName(organization.name || '')
      setOrgDescription(organization.description || '')
    }
  }, [organization])

  // Initialize agent defaults when org details load
  React.useEffect(() => {
    if (fullOrg?.agentDefaults) {
      setDefaultPersonality(fullOrg.agentDefaults.personality || '')
      setDefaultRules(fullOrg.agentDefaults.rules || '')
      setDefaultMaxCost(fullOrg.agentDefaults.maxCostPerRun ?? '')
      setDefaultMaxSteps(fullOrg.agentDefaults.maxStepsPerRun ?? '')
    }
  }, [fullOrg?.agentDefaults])

  const updateOrgMutation = useMutation({
    mutationFn: (data: { name: string; description?: string }) =>
      organizationsApi.update(organization.id, data),
    onSuccess: async () => {
      success('Organization updated', 'Organization details have been updated.')
      setIsEditing(false)
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      await queryClient.invalidateQueries({ queryKey: ['organization-details'] })
    },
    onError: (err: any) => {
      error('Failed to update organization', err.response?.data?.message || 'Please try again.')
    },
  })

  const updateAgentDefaultsMutation = useMutation({
    mutationFn: (agentDefaults: any) =>
      organizationsApi.update(organization.id, { agentDefaults }),
    onSuccess: async () => {
      success('Agent defaults saved', 'Default agent configuration has been updated.')
      await queryClient.invalidateQueries({ queryKey: ['organization-details'] })
    },
    onError: (err: any) => {
      error('Failed to save agent defaults', err.response?.data?.message || 'Please try again.')
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

  const handleSaveAgentDefaults = () => {
    updateAgentDefaultsMutation.mutate({
      personality: defaultPersonality.trim() || undefined,
      rules: defaultRules.trim() || undefined,
      maxCostPerRun: defaultMaxCost !== '' ? Number(defaultMaxCost) : undefined,
      maxStepsPerRun: defaultMaxSteps !== '' ? Number(defaultMaxSteps) : undefined,
    })
  }

  return (
    <div className="space-y-6">
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
              {(fullOrg.createdAt || fullOrg.created_at) ? new Date(fullOrg.createdAt || fullOrg.created_at).toLocaleDateString() : <span className="inline-block w-20 h-4 bg-muted animate-pulse rounded" />}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Agent Defaults</CardTitle>
            <CardDescription>Default configuration applied to all agents in this organization</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="default-personality" className="text-sm font-medium text-muted-foreground">Default Personality</Label>
            <Textarea
              id="default-personality"
              value={defaultPersonality}
              onChange={(e) => setDefaultPersonality(e.target.value)}
              placeholder="e.g. Be professional and concise. Always respond in the user's language."
              rows={3}
            />
            <p className="text-xs text-muted-foreground">Prepended to every agent's personality prompt.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="default-rules" className="text-sm font-medium text-muted-foreground">Default Rules</Label>
            <Textarea
              id="default-rules"
              value={defaultRules}
              onChange={(e) => setDefaultRules(e.target.value)}
              placeholder="e.g. Never share internal data. Always cite sources. Escalate if unsure."
              rows={3}
            />
            <p className="text-xs text-muted-foreground">Organization-wide rules injected into every agent's system prompt.</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="default-max-cost" className="text-sm font-medium text-muted-foreground">Max Cost per Run ($)</Label>
              <Input
                id="default-max-cost"
                type="number"
                min={0}
                step={0.01}
                value={defaultMaxCost}
                onChange={(e) => setDefaultMaxCost(e.target.value ? parseFloat(e.target.value) : '')}
                placeholder="No limit"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="default-max-steps" className="text-sm font-medium text-muted-foreground">Max Steps per Run</Label>
              <Input
                id="default-max-steps"
                type="number"
                min={1}
                max={500}
                value={defaultMaxSteps}
                onChange={(e) => setDefaultMaxSteps(e.target.value ? parseInt(e.target.value) : '')}
                placeholder="50"
              />
            </div>
          </div>

          <Button onClick={handleSaveAgentDefaults} disabled={updateAgentDefaultsMutation.isPending}>
            {updateAgentDefaultsMutation.isPending ? 'Saving...' : 'Save Agent Defaults'}
          </Button>
        </CardContent>
      </Card>
    </div>
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
    queryFn: () => authApi.getProfile(),
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