/**
 * Settings > Organization: whether members may add credentials only they
 * can use, next to the organization's shared ones. Off, every credential
 * is the organization's (or one team's), added by an admin.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useOrganizationRole } from '@/hooks/use-organization-role'
import { organizationsApi } from '@/lib/api'
import { allowUserScopedConnections, connectionSettingsApi, errorMessage } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'

export function PersonalKeysCard({ organizationId }: { organizationId: string }) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const { canManage } = useOrganizationRole()
  const orgQuery = useQuery({
    queryKey: ['organization-details', organizationId],
    queryFn: () => organizationsApi.getById(organizationId),
    enabled: !!organizationId,
  })
  const allowed = allowUserScopedConnections(orgQuery.data)
  const toggle = useMutation({
    mutationFn: (allow: boolean) => connectionSettingsApi.setAllowUserScopedConnections(organizationId, allow),
    onSuccess: (_result, allow) => {
      queryClient.invalidateQueries({ queryKey: ['organization-details', organizationId] })
      notifications.success(allow ? 'Personal keys allowed' : 'Personal keys off', allow ? 'Members can add keys only they can use.' : 'Only an admin can add credentials, for everyone or one team.')
    },
    onError: (error: unknown) => notifications.error('Could not save', errorMessage(error, 'The setting was not changed.')),
  })
  return (
    <Card data-testid="personal-keys">
      <CardHeader>
        <CardTitle>Personal keys</CardTitle>
        <CardDescription>Let members add credentials only they can use, next to the ones the organization shares.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-3">
          <Switch
            id="allow-user-scoped"
            checked={allowed}
            onCheckedChange={(v) => toggle.mutate(v)}
            disabled={!canManage || !organizationId || toggle.isPending || orgQuery.isLoading}
            aria-label="Members may add their own keys"
          />
          <Label htmlFor="allow-user-scoped" className="font-normal">
            {allowed ? 'Members may add their own keys' : 'Only shared credentials, added by an admin'}
          </Label>
        </div>
      </CardContent>
    </Card>
  )
}
