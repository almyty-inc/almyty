import React, { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useNotifications } from '@/store/app'
import {
  AUTH_MODE_LABELS,
  agentAppsApi,
  isOpenToAnyone,
  type AgentApp,
  type AppAuthMode,
} from '@/lib/agent-apps'

export interface AppSettingsPanelProps {
  app: AgentApp
  onSaved: () => void
}

const AUTH_MODES: AppAuthMode[] = ['public_link', 'email_otp', 'oauth', 'sso']

/**
 * Branding, access, and what the app may touch.
 *
 * Branding lives here rather than on each distribution so a product
 * looks the same in a browser, a terminal and a dock. A distribution
 * only carries what its medium forces.
 */
export function AppSettingsPanel({ app, onSaved }: AppSettingsPanelProps) {
  const { success, error: errorNotif } = useNotifications()

  const [appName, setAppName] = useState(app.branding?.appName ?? app.name)
  const [primaryColor, setPrimaryColor] = useState(app.branding?.primaryColor ?? '#8b5cf6')
  const [greeting, setGreeting] = useState(app.branding?.greeting ?? '')
  const [aiDisclosure, setAiDisclosure] = useState(app.branding?.aiDisclosure ?? '')
  const [authMode, setAuthMode] = useState<AppAuthMode>(app.authMode)

  // Kept as strings so an empty field stays empty rather than becoming
  // a zero the moment someone clears it to retype.
  const [costCap, setCostCap] = useState(
    app.limits?.costCapCents != null ? String(app.limits.costCapCents / 100) : '',
  )
  const [perUser, setPerUser] = useState(
    app.limits?.perUserRateLimit != null ? String(app.limits.perUserRateLimit) : '',
  )
  const [perIp, setPerIp] = useState(
    app.limits?.perIpRateLimit != null ? String(app.limits.perIpRateLimit) : '',
  )
  const [shell, setShell] = useState(app.capabilities?.shell === true)
  const [fsRead, setFsRead] = useState((app.capabilities?.filesystemRead ?? []).join(', '))

  const open = isOpenToAnyone(authMode)
  const wantsLocal = shell || fsRead.trim().length > 0

  const save = useMutation({
    mutationFn: () =>
      agentAppsApi.update(app.slug, {
        branding: {
          ...(app.branding ?? {}),
          appName: appName.trim(),
          primaryColor,
          greeting,
          // Null means the default wording; an empty string is a
          // deliberate removal, which the API gates on white-label.
          aiDisclosure: aiDisclosure.trim() ? aiDisclosure.trim() : null,
        },
        authMode,
        limits: {
          // Entered in whole currency, stored in cents, because a cost
          // ceiling in floating point is a rounding argument later.
          costCapCents: costCap.trim() ? Math.round(Number(costCap) * 100) : null,
          perUserRateLimit: perUser.trim() ? Number(perUser) : null,
          perIpRateLimit: perIp.trim() ? Number(perIp) : null,
        },
        capabilities: {
          ...(app.capabilities ?? {}),
          shell,
          filesystemRead: fsRead
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
        },
      }),
    onSuccess: () => {
      success('App updated', 'Your changes are saved.')
      onSaved()
    },
    onError: (err: any) =>
      errorNotif('Could not save', err?.response?.data?.message || 'Something went wrong.'),
  })

  return (
    <div className="mt-6 space-y-6">
      <section className="space-y-4">
        <h3 className="text-sm font-medium">Branding</h3>

        <div className="space-y-1.5">
          <Label htmlFor="app-display-name">Name users see</Label>
          <Input
            id="app-display-name"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="app-color">Brand color</Label>
          <div className="flex items-center gap-2">
            <input
              id="app-color"
              type="color"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              className="h-9 w-12 cursor-pointer rounded border bg-transparent"
            />
            <Input
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              aria-label="Brand color hex"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="app-greeting">Greeting</Label>
          <Textarea
            id="app-greeting"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            rows={2}
            placeholder="How can we help?"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="app-disclosure">AI disclosure</Label>
          <Input
            id="app-disclosure"
            value={aiDisclosure}
            onChange={(e) => setAiDisclosure(e.target.value)}
            placeholder="You are chatting with an AI assistant."
          />
          <p className="text-xs text-muted-foreground">
            Required by the EU AI Act (Art. 50). Leave blank for the default wording.
          </p>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-medium">Who can use it</h3>
        <Select value={authMode} onValueChange={(v) => setAuthMode(v as AppAuthMode)}>
          <SelectTrigger aria-label="Who can use it">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AUTH_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {AUTH_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-medium">What it may cost</h3>

        {open && (
          // Said here rather than only at publish time, because this is
          // the screen where it gets fixed.
          <p className="text-xs text-muted-foreground">
            Anyone with the link or the binary can use this, so it spends against your
            model keys. A product open to anyone needs all three before it can be
            published.
          </p>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="app-cost-cap">Cost ceiling per run</Label>
          <Input
            id="app-cost-cap"
            inputMode="decimal"
            value={costCap}
            onChange={(e) => setCostCap(e.target.value)}
            placeholder="0.50"
          />
          <p className="text-xs text-muted-foreground">
            In whole currency. A run that would cost more is stopped rather than billed.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="app-per-user">Requests per user, per hour</Label>
            <Input
              id="app-per-user"
              inputMode="numeric"
              value={perUser}
              onChange={(e) => setPerUser(e.target.value)}
              placeholder="60"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="app-per-ip">Requests per IP, per hour</Label>
            <Input
              id="app-per-ip"
              inputMode="numeric"
              value={perIp}
              onChange={(e) => setPerIp(e.target.value)}
              placeholder="60"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The per-IP ceiling covers surfaces where a visitor has no account, so one
          person cannot exhaust the product for everyone else.
        </p>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-medium">What it may touch</h3>

        {open && wantsLocal && (
          // Stated before the save is attempted, because the reason is
          // not obvious: the artifact runs on someone else's machine.
          <p className="flex gap-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Anyone can use this app, so it cannot also have local access. A downloadable
              artifact runs on your users' machines. Restrict who can use it, or remove the
              access.
            </span>
          </p>
        )}

        <div className="flex items-center justify-between rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="app-shell">Run local commands</Label>
            <p className="text-xs text-muted-foreground">Requires an attached runner.</p>
          </div>
          <Switch id="app-shell" checked={shell} onCheckedChange={setShell} />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="app-fs-read">Readable paths</Label>
          <Input
            id="app-fs-read"
            value={fsRead}
            onChange={(e) => setFsRead(e.target.value)}
            placeholder="~/Documents, /srv/data"
          />
          <p className="text-xs text-muted-foreground">
            Comma separated. Leave empty for no filesystem access.
          </p>
        </div>
      </section>

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
