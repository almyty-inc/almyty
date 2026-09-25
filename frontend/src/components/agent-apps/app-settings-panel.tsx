import React, { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, Plus, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/ui/disclosure'
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
import { useEntitlements } from '@/hooks/use-entitlement'
import { useNotifications } from '@/store/app'
import { getApiErrorMessage } from '@/lib/api-error'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import {
  appPrivacyFrom,
  agentAppsApi,
  isOpenToAnyone,
  type AgentApp,
  type AppBranding,
} from '@/lib/agent-apps'
import { AppAccess } from './app-access'

export interface AppSettingsPanelProps {
  app: AgentApp
  onSaved: () => void
}

/** At most this many starter prompts: they fill the empty chat on a phone. */
const MAX_PROMPTS = 4

/** "Spend limit 0.50 per run · 60 messages per visitor an hour · ...", the defaults at a glance. */
export function advancedSummary(values: {
  costCap: string
  perUser: string
  perIp: string
  retentionDays: string
  local: boolean
}): string {
  const parts = [
    values.costCap.trim() ? `Spend limit ${values.costCap.trim()} per run` : 'No spend limit',
    values.perUser.trim() ? `${values.perUser.trim()} messages per visitor an hour` : 'No visitor limit',
    values.retentionDays.trim()
      ? `visitor data deleted after ${values.retentionDays.trim()} days`
      : 'visitor data kept per organization policy',
    values.local ? 'local access on' : 'no local access',
  ]
  return parts.join(' · ')
}

/**
 * The app's look, once, and everything else under Advanced.
 *
 * Branding lives here and nowhere else: the hosted chat, the terminal
 * and the desktop app all read it from the app, so a product looks the
 * same everywhere and there is no second copy to keep in step. Who can
 * use it is the one line above; limits, visitor data and local access
 * wait under Advanced with a one-line summary of what they are now.
 */
export function AppSettingsPanel({ app, onSaved }: AppSettingsPanelProps) {
  const { success, error: errorNotif } = useNotifications()
  const entitlements = useEntitlements()
  const canWhiteLabel = entitlements.has('white_label')

  const [appName, setAppName] = useState(app.branding?.appName ?? app.name)
  const [primaryColor, setPrimaryColor] = useState(app.branding?.primaryColor ?? '#8b5cf6')
  const [theme, setTheme] = useState<NonNullable<AppBranding['theme']>>(app.branding?.theme ?? 'auto')
  const [greeting, setGreeting] = useState(app.branding?.greeting ?? '')
  const [prompts, setPrompts] = useState<string[]>(app.branding?.suggestedPrompts ?? [])
  const [promptDraft, setPromptDraft] = useState('')
  const [aiDisclosure, setAiDisclosure] = useState(app.branding?.aiDisclosure ?? '')
  const [whiteLabel, setWhiteLabel] = useState(app.branding?.whiteLabel === true)

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
  const initialPrivacy = appPrivacyFrom(app.privacy)
  const [retentionDays, setRetentionDays] = useState(
    initialPrivacy.retentionDays != null ? String(initialPrivacy.retentionDays) : '',
  )
  const [visitorCanDelete, setVisitorCanDelete] = useState(initialPrivacy.visitorCanDelete)
  const [visitorCanExport, setVisitorCanExport] = useState(initialPrivacy.visitorCanExport)
  const [visitorMemory, setVisitorMemory] = useState(initialPrivacy.visitorMemory)
  const [shell, setShell] = useState(app.capabilities?.shell === true)
  const [fsRead, setFsRead] = useState((app.capabilities?.filesystemRead ?? []).join(', '))

  const open = isOpenToAnyone(app.authMode)
  const wantsLocal = shell || fsRead.trim().length > 0
  const retentionValue = Number(retentionDays)
  const retentionError =
    retentionDays.trim().length > 0 &&
    (!Number.isInteger(retentionValue) || retentionValue < 1)

  // Settings changed since the panel opened (or since the last save) ask
  // before a navigation throws them away. A prompt typed and not added
  // counts too.
  const snapshot = JSON.stringify([
    appName, primaryColor, theme, greeting, prompts, aiDisclosure, whiteLabel, costCap, perUser, perIp,
    retentionDays, visitorCanDelete, visitorCanExport, visitorMemory, shell, fsRead,
  ])
  const [savedSnapshot, setSavedSnapshot] = useState(snapshot)

  const save = useMutation({
    mutationFn: () =>
      agentAppsApi.update(app.slug, {
        branding: {
          ...(app.branding ?? {}),
          appName: appName.trim(),
          primaryColor,
          theme,
          greeting,
          suggestedPrompts: prompts,
          // Null means the default wording; an empty string is a
          // deliberate removal, which the API gates on white-label.
          aiDisclosure: aiDisclosure.trim() ? aiDisclosure.trim() : null,
          whiteLabel,
        },
        limits: {
          // Entered in whole currency, stored in cents, because a cost
          // ceiling in floating point is a rounding argument later.
          costCapCents: costCap.trim() ? Math.round(Number(costCap) * 100) : null,
          perUserRateLimit: perUser.trim() ? Number(perUser) : null,
          perIpRateLimit: perIp.trim() ? Number(perIp) : null,
        },
        privacy: {
          retentionDays: retentionDays.trim() ? retentionValue : null,
          visitorCanDelete,
          visitorCanExport,
          visitorMemory,
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
      setSavedSnapshot(snapshot)
      onSaved()
    },
    onError: (err: any) =>
      errorNotif('Could not save app settings', getApiErrorMessage(err, 'Please try again.')),
  })

  const guard = useLeaveGuard((snapshot !== savedSnapshot || promptDraft !== '') && !save.isPending)

  const addPrompt = () => {
    const prompt = promptDraft.trim()
    if (!prompt || prompts.length >= MAX_PROMPTS || prompts.includes(prompt)) return
    setPrompts([...prompts, prompt])
    setPromptDraft('')
  }

  return (
    <div className="mt-6 space-y-6">
      <AppAccess app={app} onSaved={onSaved} />

      <section className="space-y-4">
        <h3 className="text-sm font-medium">Look</h3>

        <div className="space-y-1.5">
          <Label htmlFor="app-display-name">Name users see</Label>
          <Input
            id="app-display-name"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
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
            <Label htmlFor="app-theme">Theme</Label>
            <Select value={theme} onValueChange={(v) => setTheme(v as NonNullable<AppBranding['theme']>)}>
              <SelectTrigger id="app-theme">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Match the visitor&apos;s system</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
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
          <Label htmlFor="app-prompt">Suggested prompts</Label>
          {prompts.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label="Suggested prompts">
              {prompts.map((prompt) => (
                <span key={prompt} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs">
                  {prompt}
                  <button
                    type="button"
                    aria-label={`Remove ${prompt}`}
                    onClick={() => setPrompts(prompts.filter((p) => p !== prompt))}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {prompts.length < MAX_PROMPTS && (
            <div className="flex gap-2">
              <Input
                id="app-prompt"
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addPrompt()
                  }
                }}
                placeholder="Track my order"
              />
              <Button aria-label="Add suggested prompt" type="button" variant="outline" onClick={addPrompt}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground">Up to four, shown in an empty chat.</p>
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

        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="app-white-label">Remove almyty branding</Label>
            <p className="text-xs text-muted-foreground">
              {canWhiteLabel ? 'Hides the powered-by mark.' : 'Requires a commercial licence.'}
            </p>
          </div>
          <Switch
            id="app-white-label"
            checked={whiteLabel}
            disabled={!canWhiteLabel && !whiteLabel}
            onCheckedChange={setWhiteLabel}
          />
        </div>
      </section>

      <Disclosure
        title="Advanced"
        summary={advancedSummary({ costCap, perUser, perIp, retentionDays, local: wantsLocal })}
      >
        <section className="space-y-4">
          <h3 className="text-sm font-medium">What it may cost</h3>

          {open && (
            // Said here rather than only at publish time, because this is
            // the screen where it gets fixed.
            <p className="text-xs text-muted-foreground">
              Anyone with the link or the binary can use this, so it spends against your
              model keys. An app open to anyone needs all three before it can be
              published.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="app-cost-cap">Spend limit per run</Label>
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
              <Label htmlFor="app-per-user">Messages per visitor, per hour</Label>
              <Input
                id="app-per-user"
                inputMode="numeric"
                value={perUser}
                onChange={(e) => setPerUser(e.target.value)}
                placeholder="60"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="app-per-ip">Messages per IP address, per hour</Label>
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
            A visitor is identified by their sign-in or private chat cookie. Visitors
            sharing an IP address also share the IP allowance. Each allowance has a
            per-minute burst limit of one fifth of its hourly value, with a minimum of 3.
            These limits are not one shared bucket for the whole app.
          </p>
        </section>

        <section className="space-y-4">
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Privacy &amp; visitor data</h3>
            <p className="text-xs text-muted-foreground">
              Choose how long this app keeps visitor activity, what visitors can do with
              their own data, and whether conversations may enter shared agent memory.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="app-retention-days">Delete visitor data after (days)</Label>
            <Input
              id="app-retention-days"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={retentionDays}
              onChange={(e) => setRetentionDays(e.target.value)}
              placeholder="Use organization policy"
              aria-invalid={retentionError || undefined}
              aria-describedby="app-retention-help"
            />
            <p
              id="app-retention-help"
              className={retentionError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {retentionError
                ? 'Enter a whole number of at least 1 day.'
                : 'Leave blank to inherit the organization policy. An app can shorten that policy, never extend it.'}
            </p>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="app-visitor-export">Let visitors download their data</Label>
              <p className="text-xs text-muted-foreground">
                On by default. Adds a JSON download to the hosted chat.
              </p>
            </div>
            <Switch
              id="app-visitor-export"
              checked={visitorCanExport}
              onCheckedChange={setVisitorCanExport}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="app-visitor-delete">Let visitors delete their data</Label>
              <p className="text-xs text-muted-foreground">
                On by default. Visitors can remove one conversation or everything about them.
              </p>
            </div>
            <Switch
              id="app-visitor-delete"
              checked={visitorCanDelete}
              onCheckedChange={setVisitorCanDelete}
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="app-visitor-memory">Include visitor conversations in memory</Label>
              <p className="text-xs text-muted-foreground">
                Off by default. When enabled, visitor conversations may be summarized into
                shared agent memory and influence answers to other visitors.
              </p>
            </div>
            <Switch
              id="app-visitor-memory"
              checked={visitorMemory}
              onCheckedChange={setVisitorMemory}
            />
          </div>
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
      </Disclosure>

      <div className="flex justify-end">
        <Button disabled={save.isPending || retentionError} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving...' : 'Save'}
        </Button>
      </div>
      {guard.element}
    </div>
  )
}
