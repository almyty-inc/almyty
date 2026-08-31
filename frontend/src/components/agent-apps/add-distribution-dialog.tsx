import React, { useState } from 'react'
import { useMutation } from '@tanstack/react-query'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import {
  DISTRIBUTION_BLURBS,
  DISTRIBUTION_LABELS,
  agentAppsApi,
  isChannelTarget,
  type AgentApp,
  type DistributionTarget,
} from '@/lib/agent-apps'

export interface AddDistributionDialogProps {
  app: AgentApp
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}

/** Grouped so the choice reads as a decision about reach, not a list. */
const GROUPS: Array<{ title: string; blurb: string; targets: DistributionTarget[] }> = [
  {
    title: 'Hosted',
    blurb: 'Served by almyty, live as soon as you publish',
    targets: ['web'],
  },
  {
    title: 'Installable',
    blurb: 'Built here, signed with your certificate',
    // 'binary' is deliberately absent. It compiles to byte-identical
    // output to 'tui' — same entry point, same bun invocation — so
    // offering both asked people to choose between two names for one
    // thing. Existing binary distributions keep working; the API still
    // accepts the target.
    targets: ['tui', 'desktop'],
  },
  {
    title: 'Messaging',
    blurb: 'Needs the platform credentials for each one',
    targets: [
      'slack',
      'discord',
      'telegram',
      'whatsapp',
      'whatsapp_cloud',
      'sms',
      'microsoft_teams',
      'google_chat',
      'email',
      'signal',
      'matrix',
      'irc',
      'webhook',
    ],
  },
]

export function AddDistributionDialog({
  app,
  open,
  onOpenChange,
  onAdded,
}: AddDistributionDialogProps) {
  const { success, error: errorNotif } = useNotifications()
  const [pending, setPending] = useState<DistributionTarget | null>(null)

  // One distribution per target, so anything already shipped is shown
  // as taken rather than offered again and failing on submit.
  const taken = new Set((app.distributions ?? []).map((d) => d.target))

  const add = useMutation({
    mutationFn: (target: DistributionTarget) => agentAppsApi.addDistribution(app.slug, target),
    onSuccess: (_data, target) => {
      success('Added', `${DISTRIBUTION_LABELS[target] ?? target} is on this app.`)
      setPending(null)
      onOpenChange(false)
      onAdded()
    },
    onError: (err: any) => {
      setPending(null)
      errorNotif('Could not add', err?.response?.data?.message || 'Something went wrong.')
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a distribution</DialogTitle>
          <DialogDescription>
            Choose where this app is published.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {GROUPS.map((group) => (
            <section key={group.title} className="space-y-2">
              <div>
                <h3 className="text-sm font-medium">{group.title}</h3>
                <p className="text-xs text-muted-foreground">{group.blurb}</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {group.targets.map((target) => {
                  const already = taken.has(target)
                  return (
                    <button
                      key={target}
                      type="button"
                      disabled={already || add.isPending}
                      onClick={() => {
                        setPending(target)
                        add.mutate(target)
                      }}
                      className={cn(
                        'flex items-start gap-2 rounded-lg border p-3 text-left transition-colors',
                        already
                          ? 'cursor-not-allowed opacity-50'
                          : 'hover:border-primary hover:bg-muted/50',
                      )}
                    >
                      <span className="min-w-0">
                        <span className="mb-1 flex items-center gap-2">
                          <span className="truncate text-sm font-medium">
                            {DISTRIBUTION_LABELS[target]}
                            {pending === target && ' ...'}
                          </span>
                          <ProtocolBadge protocol={target} />
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {already ? 'Already added' : DISTRIBUTION_BLURBS[target]}
                        </span>
                        {!already && isChannelTarget(target) && (
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            You will need its credentials
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>
          ))}
        </div>

        <div className="flex justify-end pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
