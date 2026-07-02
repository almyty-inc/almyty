/**
 * Multi-workspace installations panel for a Slack channel gateway.
 *
 * Rendered from the interfaces tab's setup dialog (alongside the
 * ChannelSetupPanel). When the Slack channel is configured with the
 * Slack app's OAuth client credentials (client_id + client_secret),
 * one deployment becomes installable into unlimited customer
 * workspaces:
 *
 *   - shows the public "Add to Slack" install URL (copyable) that
 *     starts the OAuth flow on the API host
 *   - lists completed workspace installations (team name, install
 *     date) with a revoke action that clears the stored token
 *
 * Renders nothing for non-Slack gateways or Slack channels without a
 * configured client_id — those keep single-workspace behavior.
 */
import React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, Loader2, Building2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { useCopy } from '@/lib/clipboard'
import { useNotifications } from '@/store/app'
import { formatDateTime } from '@/lib/utils'
import type { Gateway } from '@/types'

interface ChannelInstallationsPanelProps {
  gateway: Gateway
}

interface ChannelInstallation {
  id: string
  externalTenantId: string
  status: 'active' | 'revoked'
  metadata?: { teamName?: string | null } | null
  installedAt: string
}

export function ChannelInstallationsPanel({ gateway }: ChannelInstallationsPanelProps) {
  const queryClient = useQueryClient()
  const copy = useCopy()
  const { success, error: errorNotif } = useNotifications()

  const config = gateway.configuration || {}
  const hasOAuthClient = !!(config.client_id || config.clientId)
  const isMultiWorkspaceSlack = gateway.type === 'slack' && hasOAuthClient

  const installUrl = `${getApiBaseUrl()}/gateways/${gateway.id}/install/slack`

  const { data: installations = [], isLoading } = useQuery<ChannelInstallation[]>({
    queryKey: ['gateway-installations', gateway.id],
    queryFn: () => gatewaysApi.getInstallations(gateway.id) as Promise<ChannelInstallation[]>,
    enabled: isMultiWorkspaceSlack,
  })

  const revokeMutation = useMutation({
    mutationFn: (installationId: string) =>
      gatewaysApi.revokeInstallation(gateway.id, installationId),
    onSuccess: () => {
      success('Installation Revoked', 'The workspace token has been cleared.')
      queryClient.invalidateQueries({ queryKey: ['gateway-installations', gateway.id] })
    },
    onError: (err: any) => {
      errorNotif(
        'Revoke Failed',
        err?.response?.data?.message || err?.message || 'Failed to revoke installation',
      )
    },
  })

  if (!isMultiWorkspaceSlack) return null

  return (
    <div className="space-y-4 border-t pt-4" data-testid="channel-installations-panel">
      {/* Install URL */}
      <div className="rounded-md border bg-muted/30 p-3">
        <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-1">
          Add to Slack — install URL
        </div>
        <div className="flex items-center gap-1">
          <code className="text-[11px] break-all flex-1" data-testid="slack-install-url">
            {installUrl}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label="Copy install URL"
            onClick={() => copy(installUrl, 'Install URL')}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Anyone with this link can install the agent into their own Slack workspace via OAuth.
        </p>
      </div>

      {/* Installations list */}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
          Workspace installations
        </p>
        {isLoading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : installations.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="no-installations">
            No workspaces have installed this channel yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {installations.map((installation) => (
              <li
                key={installation.id}
                className="flex items-center justify-between gap-2 rounded-md border p-2"
                data-testid="installation-row"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium truncate">
                      {installation.metadata?.teamName || installation.externalTenantId}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      Installed {formatDateTime(installation.installedAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge variant={installation.status === 'active' ? 'success' : 'secondary'}>
                    {installation.status}
                  </Badge>
                  {installation.status === 'active' && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revokeMutation.isPending}
                      onClick={() => revokeMutation.mutate(installation.id)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
