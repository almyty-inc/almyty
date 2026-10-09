/**
 * The owner's one-click grant on a private provider (`hostedPodAccess`):
 * coding tools on the owner's own hosted machines may call models through
 * it. An organization-wide provider needs no grant, and nobody but the
 * owner of a private one may give it, so the switch shows only then, and
 * only on a server with hosted machines.
 */
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useEnvironments } from '@/components/runners/hosted-environments-tab'
import { useAuthStore } from '@/store/auth'

interface Props {
  provider: { visibility?: string | null; ownerUserId?: string | null; hostedPodAccess?: boolean | null }
  onChange: (hostedPodAccess: boolean) => void
  disabled?: boolean
}

export function HostedPodAccess({ provider, onChange, disabled }: Props) {
  const userId = useAuthStore((s) => s.user?.id)
  const { enabled } = useEnvironments()
  if (provider.visibility !== 'private' || !userId || provider.ownerUserId !== userId || !enabled) return null
  return (
    <div className="flex max-w-xl items-start justify-between gap-4" data-testid="hosted-pod-access">
      <div className="space-y-0.5">
        <Label htmlFor="hosted-pod-access">Let my hosted machines use this provider</Label>
        <p className="text-xs text-muted-foreground">
          Coding tools on your own hosted machines can then call its models through almyty. Nobody else's machines can, and the key never goes onto the machine.
        </p>
      </div>
      <Switch id="hosted-pod-access" checked={!!provider.hostedPodAccess} onCheckedChange={onChange} disabled={disabled} />
    </div>
  )
}
