import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation, Link } from 'react-router-dom'
import { Building, Users, User, CreditCard, SlidersHorizontal } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/ui/empty-state'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { formatDate } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { MembersAndTeamsTab } from '@/components/MembersAndTeamsTab'
import { SecurityTab } from '@/components/SecurityTab'
import { SsoSettings } from '@/components/settings/sso-settings'
import { RbacSettings } from '@/components/settings/rbac-settings'
import { ApprovalPoliciesSettings } from '@/components/settings/approval-policies-settings'
import { ComplianceSettings } from '@/components/settings/compliance-settings'
import { AuditStreamsSettings } from '@/components/settings/audit-streams-settings'
import { KmsSettings } from '@/components/settings/kms-settings'
import { ReferralsTab } from '@/components/settings/referrals-tab'
import { DataRetentionCard } from '@/components/settings/data-retention-card'
import { NotificationPreferences } from '@/components/settings/notification-preferences'
import { BillingTab } from '@/components/BillingTab'
import { PlanBadge } from '@/components/plan-indicator'
import { PageHeader } from '@/components/layout/page-header'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { authApi, organizationsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * Settings used to be thirteen tabs in one row. They are five sections
 * now, each holding a few pages, and the pages that most teams never open
 * (approvals, compliance, audit streaming, encryption) sit under
 * Advanced. Every page keeps its own URL, `/settings/<page>`, so links
 * from elsewhere (the plan badge, the audit tab) still land where they
 * did; a section's URL (`/settings/advanced`) opens its first page.
 * Plan-gated pages gate themselves (EntitlementGate), wherever they sit.
 */
export const SETTINGS_SECTIONS = [
  {
    key: 'organization',
    label: 'Organization',
    icon: Building,
    description: 'Your organization\'s name and the defaults new agents start with.',
    pages: [{ key: 'organization', label: 'Details' }],
  },
  {
    key: 'account',
    label: 'Your account',
    icon: User,
    description: 'Your own name, password and what you get notified about.',
    pages: [
      { key: 'profile', label: 'Profile' },
      { key: 'security', label: 'Password and sign-in' },
      { key: 'notifications', label: 'Notifications' },
    ],
  },
  {
    key: 'people',
    label: 'People and access',
    icon: Users,
    description: 'Who is in the organization and what each person may do.',
    pages: [
      { key: 'members', label: 'Members and teams' },
      { key: 'rbac', label: 'Roles' },
      { key: 'sso', label: 'Single sign-on' },
    ],
  },
  {
    key: 'billing',
    label: 'Billing',
    icon: CreditCard,
    description: 'Your plan, what you have used, and invites that earn credit.',
    pages: [
      { key: 'billing', label: 'Plan and usage' },
      { key: 'referrals', label: 'Referrals' },
    ],
  },
  {
    key: 'advanced',
    label: 'Advanced',
    icon: SlidersHorizontal,
    description: 'Controls most teams never need: sign-off before actions, compliance, audit export and your own encryption keys.',
    pages: [
      { key: 'approvals', label: 'Approvals' },
      { key: 'compliance', label: 'Compliance' },
      { key: 'audit-streams', label: 'Audit streaming' },
      { key: 'encryption', label: 'Encryption' },
    ],
  },
] as const

type SettingsSection = typeof SETTINGS_SECTIONS[number]
type SettingsTab = SettingsSection['pages'][number]['key']

/** Every page, by the URL segment it has always had. */
export const SETTINGS_TABS: SettingsTab[] = SETTINGS_SECTIONS.flatMap((s) => s.pages.map((p) => p.key))

/**
 * Which page a URL means: `/settings` is Organization, `/settings/<page>`
 * is that page, `/settings/<section>` is the section's first page, and
 * anything else falls back to Organization.
 */
export function getSettingsTab(pathname: string): SettingsTab {
  const segment = pathname.split('/').filter(Boolean)[1] ?? ''
  const page = SETTINGS_TABS.find((t) => t === segment)
  if (page) return page
  const section = SETTINGS_SECTIONS.find((s) => s.key === segment)
  return section ? section.pages[0].key : 'organization'
}

function sectionOf(tab: SettingsTab): SettingsSection {
  return SETTINGS_SECTIONS.find((s) => s.pages.some((p) => p.key === tab)) ?? SETTINGS_SECTIONS[0]
}

const settingsPath = (tab: SettingsTab) => (tab === 'organization' ? '/settings' : `/settings/${tab}`)

export function SettingsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const settingsTab = getSettingsTab(location.pathname)
  const section = sectionOf(settingsTab)

  // A section URL shows its first page; say so in the address bar too.
  useEffect(() => {
    const segment = location.pathname.split('/').filter(Boolean)[1]
    if (segment && SETTINGS_SECTIONS.some((s) => s.key === segment && s.key !== settingsTab)) {
      navigate(settingsPath(settingsTab), { replace: true })
    }
  }, [location.pathname, settingsTab, navigate])

  useEffect(() => {
    document.title = 'Settings | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Your organization, your account and who can do what"
        actions={
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Plan</span>
            <PlanBadge />
          </div>
        }
      />

      {/* The shared pill tabs, as on Analytics, Tools and Memory: one per
          section. A section with more than one page lists them under it. */}
      <Tabs value={section.key} onValueChange={(key) => {
        const next = SETTINGS_SECTIONS.find((s) => s.key === key)
        if (next) navigate(settingsPath(next.pages[0].key))
      }}>
        <TabsList aria-label="Settings sections" className="h-auto flex-wrap justify-start">
          {SETTINGS_SECTIONS.map(({ key, label, icon: Icon }) => (
            <TabsTrigger key={key} value={key} className="gap-1.5">
              <Icon className="h-4 w-4" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="space-y-3">
        <p className="text-sm text-muted-foreground" data-testid="settings-section-description">{section.description}</p>
        {section.pages.length > 1 && (
          <nav aria-label={`${section.label} pages`} className="flex flex-wrap gap-1">
            {section.pages.map((p) => (
              <Button
                key={p.key}
                asChild
                size="sm"
                variant={p.key === settingsTab ? 'outline' : 'ghost'}
                className={p.key === settingsTab ? 'bg-background font-semibold shadow-sm' : 'text-muted-foreground'}
              >
                <Link to={settingsPath(p.key)} aria-current={p.key === settingsTab ? 'page' : undefined}>{p.label}</Link>
              </Button>
            ))}
          </nav>
        )}
      </div>

      <div>
        {settingsTab === 'organization' && <OrganizationTab organization={currentOrganization} />}
        {settingsTab === 'members' && <MembersAndTeamsTab organizationId={currentOrganization?.id} />}
        {settingsTab === 'billing' && <BillingTab organizationId={currentOrganization?.id} />}
        {settingsTab === 'referrals' && <ReferralsTab />}
        {settingsTab === 'profile' && <ProfileTab />}
        {settingsTab === 'notifications' && <NotificationPreferences />}
        {settingsTab === 'security' && <SecurityTab />}
        {settingsTab === 'sso' && <SsoSettings />}
        {settingsTab === 'rbac' && <RbacSettings />}
        {settingsTab === 'approvals' && <ApprovalPoliciesSettings />}
        {settingsTab === 'compliance' && <ComplianceSettings />}
        {settingsTab === 'audit-streams' && <AuditStreamsSettings />}
        {settingsTab === 'encryption' && <KmsSettings />}
      </div>
    </div>
  )
}

function OrganizationTab({ organization }: { organization: any }) {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const { upsertOrganization } = useOrganizationStore()
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
    onSuccess: async (updated: any, variables) => {
      success('Organization updated', 'Organization details have been updated.')
      setIsEditing(false)
      // The heading below this card, the sidebar switcher and the
      // X-Organization-Id header all read the store, not a query, so
      // invalidating alone left the toast claiming a rename the page
      // still showed the old name for -- across a reload, because the
      // persisted copy wins whenever its id is still a membership.
      upsertOrganization({
        ...organization,
        ...variables,
        ...(updated && updated.id ? updated : {}),
      })
      await queryClient.invalidateQueries({ queryKey: ['organizations'] })
      await queryClient.invalidateQueries({ queryKey: ['organization-details'] })
    },
    onError: (err: any) => {
      error('Failed to update organization', getApiErrorMessage(err, 'Please try again.'))
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
      error('Failed to save agent defaults', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  if (!organization) {
    return (
      <EmptyState
        variant="panel"
        icon={Building}
        title="No organization selected"
        description="Select or create an organization to manage its settings."
      />
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
            <CardTitle>Organization details</CardTitle>
            <CardDescription>Manage your organization settings</CardDescription>
          </div>
          {!isEditing ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setIsEditing(true)}>
                Edit organization
              </Button>
              {/*
                Creating one was possible and unreachable: the
                organizations page holds the dialog and is in neither the
                sidebar nor anywhere a person looks for it.
              */}
              <Button variant="outline" asChild data-testid="new-organization">
                <Link to="/organizations/new">New organization</Link>
              </Button>
            </div>
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
            <label htmlFor="org-name" className="text-sm font-medium text-muted-foreground">Organization name</label>
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
              {(fullOrg.createdAt || fullOrg.created_at) ? formatDate(fullOrg.createdAt || fullOrg.created_at) : <span className="inline-block w-20 h-4 bg-muted animate-pulse rounded" />}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Agent defaults</CardTitle>
            <CardDescription>Default configuration applied to all agents in this organization</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="default-personality" className="text-sm font-medium text-muted-foreground">Default personality</Label>
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
            <Label htmlFor="default-rules" className="text-sm font-medium text-muted-foreground">Default rules</Label>
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
              <Label htmlFor="default-max-cost" className="text-sm font-medium text-muted-foreground">Max cost per run ($)</Label>
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
              <Label htmlFor="default-max-steps" className="text-sm font-medium text-muted-foreground">Max steps per run</Label>
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
            {updateAgentDefaultsMutation.isPending ? 'Saving...' : 'Save agent defaults'}
          </Button>
        </CardContent>
      </Card>

      <DataRetentionCard organizationId={organization.id} />
    </div>
  )
}

type ProfileErrors = { firstName?: string; lastName?: string; email?: string; currentPassword?: string }

export function ProfileTab() {
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()
  const [isEditing, setIsEditing] = useState(false)
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [validationErrors, setValidationErrors] = useState<ProfileErrors>({})

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
    mutationFn: (data: { name: string; email: string; currentPassword?: string }) =>
      authApi.updateProfile(data),
    onSuccess: async (_data, variables) => {
      const moved = !!variables.currentPassword
      success(
        'Profile updated',
        moved
          ? 'Check your new inbox for a verification link. Your previous address has been notified.'
          : 'Your profile has been updated successfully.',
      )
      setCurrentPassword('')
      setIsEditing(false)
      await queryClient.invalidateQueries({ queryKey: ['user-profile'] })
    },
    onError: (err: any) => {
      error('Failed to update profile', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  if (isLoading) {
    return (
      <div className="flex justify-center py-12" aria-label="Loading profile">
        <LoadingSpinner />
      </div>
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

  // A new email needs the current password (the server refuses without it).
  const emailChanged = isEditing && email.trim() !== (userProfile.email || '')

  const handleSave = () => {
    const errors: ProfileErrors = {}

    if (!firstName.trim()) {
      errors.firstName = 'First name is required'
    }
    if (!lastName.trim()) {
      errors.lastName = 'Last name is required'
    }
    if (!email.trim()) {
      errors.email = 'Email is required'
    }
    if (emailChanged && !currentPassword) {
      errors.currentPassword = 'Enter your current password to change your email'
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
      ...(emailChanged ? { currentPassword } : {}),
    })
  }

  const handleCancel = () => {
    setFirstName(userProfile.firstName || '')
    setLastName(userProfile.lastName || '')
    setEmail(userProfile.email || '')
    setCurrentPassword('')
    setValidationErrors({})
    setIsEditing(false)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Profile information</CardTitle>
          <CardDescription>Your account details and information</CardDescription>
        </div>
        {!isEditing ? (
          <Button variant="outline" onClick={() => setIsEditing(true)}>
            Edit profile
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
            <label htmlFor="first-name" className="text-sm font-medium text-muted-foreground">First name</label>
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
                  <p className="text-sm text-destructive mt-1">{validationErrors.firstName}</p>
                )}
              </>
            ) : (
              <div className="text-lg font-medium mt-1">{userProfile.firstName}</div>
            )}
          </div>
          <div>
            <label htmlFor="last-name" className="text-sm font-medium text-muted-foreground">Last name</label>
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
                  <p className="text-sm text-destructive mt-1">{validationErrors.lastName}</p>
                )}
              </>
            ) : (
              <div className="text-lg font-medium mt-1">{userProfile.lastName}</div>
            )}
          </div>
        </div>

        <div>
          <label htmlFor="email" className="text-sm font-medium text-muted-foreground">Email address</label>
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
                <p className="text-sm text-destructive mt-1">{validationErrors.email}</p>
              )}
              {emailChanged && (
                <div className="mt-3">
                  <label htmlFor="current-password" className="text-sm font-medium text-muted-foreground">
                    Current password
                  </label>
                  <Input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => {
                      setCurrentPassword(e.target.value)
                      if (validationErrors.currentPassword) {
                        setValidationErrors({ ...validationErrors, currentPassword: undefined })
                      }
                    }}
                    className="mt-1"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Needed to change your email. We will send a verification link to the new address and let the
                    current one know.
                  </p>
                  {validationErrors.currentPassword && (
                    <p className="text-sm text-destructive mt-1">{validationErrors.currentPassword}</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="text-lg mt-1">{userProfile.email}</div>
          )}
        </div>
        
        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="text-sm font-medium text-muted-foreground">Account created</label>
            <div className="text-sm mt-1">
              {formatDate(userProfile.createdAt)}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-muted-foreground">Account status</label>
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
