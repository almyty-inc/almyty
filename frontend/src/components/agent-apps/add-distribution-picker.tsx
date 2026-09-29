import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, Code2, Globe, Loader2, MessageSquare, Monitor, Terminal } from 'lucide-react'

import { FormPage } from '@/components/layout/form-page'
import { ChoiceTile, ChoiceTiles, splitTileName } from '@/components/connect/service-tiles'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
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
  id: string
  title: string
  blurb: string
  targets: DistributionTarget[]
}> = [
  {
    id: 'web',
    title: 'On the web',
    blurb: 'Served by almyty, live as soon as you publish.',
    targets: ['web', 'widget'],
  },
  {
    id: 'installable',
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
    id: 'messaging',
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
  {
    id: 'agents',
    title: 'Other agents',
    blurb: 'Agents elsewhere find yours by its agent card and call it. Each caller signs in with a key.',
    targets: ['a2a'],
  },
]

/** What a tile says in the picker, where a label has room for about fifteen characters. */
const TILE_HINTS: Partial<Record<DistributionTarget, string>> = {
  whatsapp: 'Via Twilio',
  whatsapp_cloud: 'Via Meta',
}

export function placeTile(target: DistributionTarget): { label: string; hint?: string } {
  // "WhatsApp (Meta)" -> "WhatsApp" over "Via Meta"; "Other agents (A2A)" -> over "A2A".
  const { label, hint } = splitTileName(DISTRIBUTION_LABELS[target])
  return { label, hint: TILE_HINTS[target] ?? hint ?? (isChannelTarget(target) ? undefined : DISTRIBUTION_BLURBS[target]) }
}

function iconFor(target: DistributionTarget) {
  const cls = 'h-4 w-4 text-primary'
  if (target === 'web') return <Globe className={cls} />
  if (target === 'widget') return <Code2 className={cls} />
  if (target === 'tui' || target === 'binary') return <Terminal className={cls} />
  if (target === 'desktop') return <Monitor className={cls} />
  if (target === 'a2a') return <Bot className={cls} />
  if (isChannelTarget(target)) return <MessageSquare className={cls} />
  return <Globe className={cls} />
}

/**
 * Where an app can ship, one tile per place.
 *
 * Picking one records it on the app and goes straight to its own page,
 * where its settings and its address live. A place the app already has
 * opens that page instead of being added twice.
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
        <section
          key={group.id}
          aria-labelledby={`places-${group.id}`}
          className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground sm:p-6"
        >
          <div className="space-y-1">
            <h2 id={`places-${group.id}`} className="text-base font-semibold">
              {group.title}
            </h2>
            <p className="text-sm text-muted-foreground">{group.blurb}</p>
          </div>
          <ChoiceTiles label={group.title}>
            {group.targets.map((target) => {
              const already = taken.has(target)
              const tile = placeTile(target)
              return (
                <ChoiceTile
                  key={target}
                  testId={`place-${target}`}
                  icon={pending === target ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : iconFor(target)}
                  label={tile.label}
                  // A platform's name says what it is; the other places get one line.
                  hint={already ? (tile.hint ? `${tile.hint}, added` : 'Already added') : tile.hint}
                  disabled={add.isPending}
                  onClick={() => {
                    if (already) {
                      navigate(pageFor(target))
                      return
                    }
                    setPending(target)
                    add.mutate(target)
                  }}
                />
              )
            })}
          </ChoiceTiles>
        </section>
      ))}
    </FormPage>
  )
}
