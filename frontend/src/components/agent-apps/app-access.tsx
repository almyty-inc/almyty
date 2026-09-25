import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Globe, KeyRound, Mail, ShieldCheck } from 'lucide-react'

import { ChoiceTile, ChoiceTiles } from '@/components/ui/choice-tile'
import { WhoCanUseLine } from '@/components/llm-providers/who-can-use'
import { useEntitlements } from '@/hooks/use-entitlement'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import {
  AUTH_MODE_HINTS,
  AUTH_MODE_LABELS,
  AUTH_MODE_SUMMARY,
  agentAppsApi,
  type AgentApp,
  type AppAuthMode,
} from '@/lib/agent-apps'

const MODES: Array<{ mode: AppAuthMode; icon: typeof Globe }> = [
  { mode: 'public_link', icon: Globe },
  { mode: 'email_otp', icon: Mail },
  { mode: 'oauth', icon: KeyRound },
  { mode: 'sso', icon: ShieldCheck },
]

/**
 * Who can use an app, as one line until someone wants to change it.
 *
 * The same one-liner as a provider's "Who can use it", with the app's
 * choices behind it as tiles. Picking one saves it: it is the one
 * decision a web app asks, and the page below it (sign-in provider,
 * SSO URLs) follows from it.
 */
export function AppAccess({ app, onSaved }: { app: AgentApp; onSaved?: () => void }) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const entitlements = useEntitlements()
  const [open, setOpen] = useState(false)
  const current = app.authMode ?? 'public_link'

  const save = useMutation({
    mutationFn: (authMode: AppAuthMode) => agentAppsApi.update(app.slug, { authMode }),
    onSuccess: (_saved, authMode) => {
      success('Saved', `Who can use it: ${AUTH_MODE_SUMMARY[authMode]}.`)
      setOpen(false)
      queryClient.invalidateQueries({ queryKey: ['agent-app', app.slug] })
      queryClient.invalidateQueries({ queryKey: ['agent-app-check', app.slug] })
      onSaved?.()
    },
    onError: (err: unknown) => errorNotif('Could not save', getApiErrorMessage(err, 'Please try again.')),
  })

  if (!open) {
    return <WhoCanUseLine summary={AUTH_MODE_SUMMARY[current]} onChange={() => setOpen(true)} testId="app-access" />
  }

  return (
    <div className="space-y-2" data-testid="app-access-picker">
      <p className="text-sm text-muted-foreground">Who can use it</p>
      <ChoiceTiles label="Who can use it">
        {MODES.map(({ mode, icon: Icon }) => {
          const locked = mode === 'sso' && !entitlements.has('sso')
          return (
            <ChoiceTile
              key={mode}
              testId={`access-${mode}`}
              icon={<Icon className="h-4 w-4 text-primary" />}
              label={AUTH_MODE_LABELS[mode]}
              hint={locked ? 'Needs a commercial licence' : AUTH_MODE_HINTS[mode]}
              selected={mode === current}
              disabled={locked || save.isPending}
              onClick={() => (mode === current ? setOpen(false) : save.mutate(mode))}
            />
          )
        })}
      </ChoiceTiles>
    </div>
  )
}
