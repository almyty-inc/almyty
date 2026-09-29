import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Loader2 } from 'lucide-react'

import { FormPage, FormSection } from '@/components/layout/form-page'
import { ProtocolBadge } from '@/components/ui/protocol-badge'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { cn } from '@/lib/utils'
import {
  DISTRIBUTION_BLURBS,
  DISTRIBUTION_LABELS,
  agentAppsApi,
  isChannelTarget,
  type AgentApp,
  type DistributionTarget,
} from '@/lib/agent-apps'

/** Grouped so the choice reads as a decision about reach, not a list. */
export const DISTRIBUTION_GROUPS: Array<{
  title: string
  blurb: string
  targets: DistributionTarget[]
}> = [
  {
    title: 'Hosted',
    blurb: 'Served by almyty, live as soon as you publish.',
    targets: ['web'],
  },
  {
    title: 'Installable',
    blurb: 'Built here, signed with your certificate.',
    // 'binary' is deliberately absent. It compiles to byte-identical
    // output to 'tui' -- same entry point, same bun invocation -- so
    // offering both asked people to choose between two names for one
    // thing. Existing binary distributions keep working; the API still
    // accepts the target.
    targets: ['tui', 'desktop'],
  },
  {
    title: 'Messaging',
    blurb: 'Each one needs the settings from your own account on that platform.',
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

/**
 * Where an app can ship, one card per place.
 *
 * Picking one records it on the app and goes straight to its own page,
 * where its settings and its callback URL live. A place the app already
 * ships to links to that page instead of being offered twice.
 */
export function AddDistributionPicker({ app }: { app: AgentApp }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [pending, setPending] = useState<DistributionTarget | null>(null)

  const taken = new Set((app.distributions ?? []).map((d) => d.target))
  const pageFor = (target: DistributionTarget) => `/apps/${app.slug}/distributions/${target}`

  const add = useMutation({
    mutationFn: (target: DistributionTarget) => agentAppsApi.addDistribution(app.slug, target),
    onSuccess: async (_data, target) => {
      success('Added', `${DISTRIBUTION_LABELS[target] ?? target} is on this app.`)
      await queryClient.invalidateQueries({ queryKey: ['agent-app', app.slug] })
      queryClient.invalidateQueries({ queryKey: ['agent-app-check', app.slug] })
      navigate(pageFor(target))
    },
    onError: (err: unknown) => {
      setPending(null)
      errorNotif('Could not add it', getApiErrorMessage(err, 'Please try again.'))
    },
  })

  return (
    <FormPage
      title="Where people use it"
      description="Pick a place. You can add more later."
      back={{ to: `/apps/${app.slug}`, label: app.branding?.appName || app.name }}
    >
      {DISTRIBUTION_GROUPS.map((group) => (
        <FormSection key={group.title} title={group.title} description={group.blurb}>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {group.targets.map((target) => {
              const already = taken.has(target)
              const body = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="mb-1 flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {DISTRIBUTION_LABELS[target]}
                      </span>
                      <ProtocolBadge protocol={target} />
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {already ? 'Already added. Open its settings.' : DISTRIBUTION_BLURBS[target]}
                    </span>
                    {!already && isChannelTarget(target) && (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        You will need its settings from that platform
                      </span>
                    )}
                  </span>
                  {pending === target ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                </>
              )
              const classes =
                'flex items-center gap-2 rounded-lg border p-3 text-left transition-colors hover:border-primary hover:bg-muted/50'
              return already ? (
                <Link key={target} to={pageFor(target)} className={cn(classes, 'bg-muted/30')}>
                  {body}
                </Link>
              ) : (
                <button
                  key={target}
                  type="button"
                  disabled={add.isPending}
                  onClick={() => {
                    setPending(target)
                    add.mutate(target)
                  }}
                  className={cn(classes, 'disabled:cursor-wait disabled:opacity-60')}
                >
                  {body}
                </button>
              )
            })}
          </div>
        </FormSection>
      ))}
    </FormPage>
  )
}
