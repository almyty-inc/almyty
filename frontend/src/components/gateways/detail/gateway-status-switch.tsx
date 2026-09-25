import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Switch } from '@/components/ui/switch'
import { gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'

/**
 * Pause and resume, as one switch. A gateway is live or it is not; the
 * health check's own verdict ('error') reads as failing and resuming clears
 * it. There is nothing else to set by hand.
 */
export function GatewayStatusSwitch({ gateway }: { gateway: { id: string; status?: string; isSystem?: boolean } }) {
  const queryClient = useQueryClient()
  const { error: errorNotif } = useNotifications()
  const live = gateway.status === 'active'
  const toggle = useMutation({
    mutationFn: (next: boolean) => (next ? gatewaysApi.activate(gateway.id) : gatewaysApi.deactivate(gateway.id)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['gateway', gateway.id] })
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
    },
    onError: (err: unknown) =>
      errorNotif(live ? 'Could not pause it' : 'Could not resume it', getApiErrorMessage(err, 'Please try again.')),
  })
  const label = live ? 'Live' : gateway.status === 'error' ? 'Failing' : 'Paused'
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="gateway-status-switch">
      <Switch
        id={`gateway-live-${gateway.id}`}
        checked={live}
        disabled={toggle.isPending || !!gateway.isSystem}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label={live ? 'Pause' : 'Resume'}
      />
      <label htmlFor={`gateway-live-${gateway.id}`} className={live ? 'font-medium' : 'text-muted-foreground'}>
        {label}
      </label>
    </div>
  )
}
