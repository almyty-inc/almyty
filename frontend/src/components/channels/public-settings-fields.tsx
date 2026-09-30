import { Globe, KeyRound, Mail, Plus, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'

import { Field, FormSection } from '@/components/layout/form-page'
import { ChoiceTile, ChoiceTiles } from '@/components/connect/service-tiles'
import { Button } from '@/components/ui/button'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useEntitlements } from '@/hooks/use-entitlement'
import { pluralized } from '@/lib/utils'
import {
  AUTH_MODE_HINTS,
  AUTH_MODE_LABELS,
  formatCents,
  type ChannelBranding,
  type EffectiveSettings,
  type VisitorAuthMode,
  type VisitorLimits,
  type VisitorPrivacy,
  type VisitorRules,
} from '@/lib/agent-channels'

/** At most this many starter prompts: they fill the empty chat on a phone. */
const MAX_PROMPTS = 4

const MODES: Array<{ mode: VisitorAuthMode; icon: typeof Globe }> = [
  { mode: 'public_link', icon: Globe },
  { mode: 'email_otp', icon: Mail },
  { mode: 'oauth', icon: KeyRound },
  { mode: 'sso', icon: ShieldCheck },
]

/**
 * The branding and visitor rules as the form edits them. Numbers are kept
 * as strings so a field someone cleared to retype stays empty instead of
 * becoming zero, and money is in whole currency, not cents.
 */
export interface PublicSettingsForm {
  appName: string
  primaryColor: string
  theme: NonNullable<ChannelBranding['theme']>
  greeting: string
  prompts: string[]
  aiDisclosure: string
  whiteLabel: boolean
  authMode: VisitorAuthMode
  costCap: string
  dailyCap: string
  monthlyCap: string
  perUser: string
  perIp: string
  retentionDays: string
  visitorCanDelete: boolean
  visitorCanExport: boolean
  visitorMemory: boolean
}

const money = (cents: number | null | undefined) => (cents != null ? String(cents / 100) : '')
const count = (n: number | null | undefined) => (n != null ? String(n) : '')

/** The form for what a channel resolves to (or what the agent's channels inherit). */
export function formFromEffective(effective: EffectiveSettings): PublicSettingsForm {
  const b = effective.branding
  const r = effective.visitorRules
  return {
    appName: b.appName ?? '',
    primaryColor: b.primaryColor ?? '#8b5cf6',
    theme: b.theme ?? 'auto',
    greeting: b.greeting ?? '',
    prompts: b.suggestedPrompts ?? [],
    aiDisclosure: b.aiDisclosure ?? '',
    whiteLabel: b.whiteLabel === true,
    authMode: r.authMode ?? 'public_link',
    costCap: money(r.limits.costCapCents),
    // Shown with the effective value, default included, so the cap in
    // force is on the screen rather than implied by an empty field.
    dailyCap: money(r.caps.dailyCents),
    monthlyCap: money(r.caps.monthlyCents),
    perUser: count(r.limits.perUserRateLimit),
    perIp: count(r.limits.perIpRateLimit),
    retentionDays: count(r.privacy.retentionDays),
    visitorCanDelete: r.privacy.visitorCanDelete,
    visitorCanExport: r.privacy.visitorCanExport,
    visitorMemory: r.privacy.visitorMemory,
  }
}

const cents = (value: string) => (value.trim() ? Math.round(Number(value) * 100) : null)
const whole = (value: string) => (value.trim() ? Number(value) : null)

/** What the form stores: branding and visitor rules in full. */
export function settingsFromForm(form: PublicSettingsForm): { branding: ChannelBranding; visitorRules: VisitorRules } {
  return {
    branding: {
      appName: form.appName.trim(),
      primaryColor: form.primaryColor,
      theme: form.theme,
      greeting: form.greeting,
      suggestedPrompts: form.prompts,
      // Null means the default wording; an empty string is a deliberate
      // removal, which the API gates on white label.
      aiDisclosure: form.aiDisclosure.trim() ? form.aiDisclosure.trim() : null,
      whiteLabel: form.whiteLabel,
    },
    visitorRules: {
      authMode: form.authMode,
      limits: {
        costCapCents: cents(form.costCap),
        perUserRateLimit: whole(form.perUser),
        perIpRateLimit: whole(form.perIp),
        // Empty is "no limit", sent as null, which the server keeps apart
        // from a field never set (that one takes the default).
        dailySpendCapCents: cents(form.dailyCap),
        monthlySpendCapCents: cents(form.monthlyCap),
      },
      privacy: {
        retentionDays: whole(form.retentionDays),
        visitorCanDelete: form.visitorCanDelete,
        visitorCanExport: form.visitorCanExport,
        visitorMemory: form.visitorMemory,
      },
    },
  }
}

/**
 * A channel's own settings: only the fields where the form differs from
 * what the channel inherits from its agent, so every other field keeps
 * following the agent. Null when nothing differs.
 */
export function overridesFromForm(
  form: PublicSettingsForm,
  inherited: EffectiveSettings,
): { branding: ChannelBranding | null; visitorRules: VisitorRules | null } {
  const mine = settingsFromForm(form)
  const theirs = settingsFromForm(formFromEffective(inherited))
  const diff = <T extends object>(a: T, b: T): Partial<T> | null => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(a)) {
      if (JSON.stringify(value) !== JSON.stringify((b as Record<string, unknown>)[key])) out[key] = value
    }
    return Object.keys(out).length ? (out as Partial<T>) : null
  }
  const branding = diff(mine.branding, theirs.branding)
  const limits = diff(mine.visitorRules.limits as VisitorLimits, theirs.visitorRules.limits as VisitorLimits)
  const privacy = diff(mine.visitorRules.privacy as VisitorPrivacy, theirs.visitorRules.privacy as VisitorPrivacy)
  const rules: VisitorRules = {
    ...(mine.visitorRules.authMode !== theirs.visitorRules.authMode ? { authMode: mine.visitorRules.authMode } : {}),
    ...(limits ? { limits } : {}),
    ...(privacy ? { privacy } : {}),
  }
  return { branding, visitorRules: Object.keys(rules).length ? rules : null }
}

/** A money field (whole currency, as typed) the way the owner reads money: "$5", "$0.50". */
function asMoney(text: string): string {
  const value = Number(text)
  return Number.isFinite(value) ? formatCents(Math.round(value * 100)) : text
}

/** The one-line summary the Advanced disclosure shows while closed. */
export function advancedSummary(form: PublicSettingsForm): string {
  const run = form.costCap.trim()
  const day = form.dailyCap.trim()
  const month = form.monthlyCap.trim()
  const total = [day ? `${asMoney(day)} a day` : '', month ? `${asMoney(month)} a month` : ''].filter(Boolean).join(', ')
  return [
    run ? `${asMoney(run)} per run` : 'No spend limit per run',
    total || 'No total spend limit',
    form.perUser.trim() ? `${pluralized(Number(form.perUser.trim()), 'message')} per visitor an hour` : 'No visitor limit',
    form.retentionDays.trim()
      ? `visitor data deleted after ${form.retentionDays.trim()} days`
      : 'visitor data kept per organization policy',
  ].join(' · ')
}

/** Whether the retention field holds something the API would refuse. */
export function retentionInvalid(form: PublicSettingsForm): boolean {
  const value = Number(form.retentionDays)
  return form.retentionDays.trim().length > 0 && (!Number.isInteger(value) || value < 1)
}

export interface PublicSettingsFieldsProps {
  form: PublicSettingsForm
  onChange: (form: PublicSettingsForm) => void
  /** Prefix for field ids, so two forms on one page never share one. */
  idPrefix?: string
  /** What the spend limits apply to, in the sentence under them. */
  scope?: 'agent' | 'channel'
}

/**
 * Branding and visitor rules as form sections: how it looks, who can use
 * it, and under Advanced what it may cost and what it keeps. The same
 * fields for an agent (what every channel inherits) and for one channel
 * (its own).
 */
export function PublicSettingsFields({ form, onChange, idPrefix = 'ps', scope = 'agent' }: PublicSettingsFieldsProps) {
  const entitlements = useEntitlements()
  const canWhiteLabel = entitlements.has('white_label')
  const [promptDraft, setPromptDraft] = useState('')
  const set = <K extends keyof PublicSettingsForm>(key: K, value: PublicSettingsForm[K]) => onChange({ ...form, [key]: value })
  const id = (name: string) => `${idPrefix}-${name}`

  const addPrompt = () => {
    const prompt = promptDraft.trim()
    if (!prompt || form.prompts.length >= MAX_PROMPTS || form.prompts.includes(prompt)) return
    set('prompts', [...form.prompts, prompt])
    setPromptDraft('')
  }
  const retentionError = retentionInvalid(form)

  return (
    <>
      <FormSection title="Look" description="What people see in the web chat, the website widget and the apps they download.">
        <Field id={id('name')} label="Name people see">
          <Input id={id('name')} value={form.appName} onChange={(e) => set('appName', e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={id('color')} label="Brand color">
            <div className="flex items-center gap-2">
              <input
                id={id('color')}
                type="color"
                value={form.primaryColor}
                onChange={(e) => set('primaryColor', e.target.value)}
                className="h-9 w-12 cursor-pointer rounded border bg-transparent"
              />
              <Input value={form.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} aria-label="Brand color hex" />
            </div>
          </Field>
          <Field id={id('theme')} label="Theme">
            <Select value={form.theme} onValueChange={(v) => set('theme', v as PublicSettingsForm['theme'])}>
              <SelectTrigger id={id('theme')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Match the visitor&apos;s system</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Field id={id('greeting')} label="Greeting">
          <Textarea id={id('greeting')} value={form.greeting} onChange={(e) => set('greeting', e.target.value)} rows={2} placeholder="How can we help?" />
        </Field>
        <Field id={id('prompt')} label="Suggested prompts" hint="Up to four, shown in an empty chat.">
          <div className="space-y-2">
            {form.prompts.length > 0 && (
              <div className="flex flex-wrap gap-2" aria-label="Suggested prompts">
                {form.prompts.map((prompt) => (
                  <span key={prompt} className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs">
                    {prompt}
                    <button type="button" aria-label={`Remove ${prompt}`} onClick={() => set('prompts', form.prompts.filter((p) => p !== prompt))}>
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {form.prompts.length < MAX_PROMPTS && (
              <div className="flex gap-2">
                <Input
                  id={id('prompt')}
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
          </div>
        </Field>
        <Field id={id('disclosure')} label="AI disclosure" hint="Required by the EU AI Act (Art. 50). Leave blank for the default wording.">
          <Input
            id={id('disclosure')}
            value={form.aiDisclosure}
            onChange={(e) => set('aiDisclosure', e.target.value)}
            placeholder="You are chatting with an AI assistant."
          />
        </Field>
        <div className="flex items-center justify-between gap-4 rounded-md border p-3">
          <div className="space-y-0.5">
            <Label htmlFor={id('white-label')}>Remove almyty branding</Label>
            <p className="text-xs text-muted-foreground">{canWhiteLabel ? 'Hides the powered-by mark.' : 'Requires a commercial licence.'}</p>
          </div>
          <Switch
            id={id('white-label')}
            checked={form.whiteLabel}
            disabled={!canWhiteLabel && !form.whiteLabel}
            onCheckedChange={(v) => set('whiteLabel', v)}
          />
        </div>
      </FormSection>

      <FormSection title="Who can use it">
        <ChoiceTiles label="Who can use it" className="sm:grid-cols-2 lg:grid-cols-2">
          {MODES.map(({ mode, icon: Icon }) => {
            const locked = mode === 'sso' && !entitlements.has('sso')
            return (
              <ChoiceTile
                key={mode}
                testId={`access-${mode}`}
                icon={<Icon className="h-4 w-4 text-primary" />}
                label={AUTH_MODE_LABELS[mode]}
                hint={locked ? 'Needs a commercial licence' : AUTH_MODE_HINTS[mode]}
                selected={mode === form.authMode}
                disabled={locked}
                onClick={() => set('authMode', mode)}
              />
            )
          })}
        </ChoiceTiles>
      </FormSection>

      <FormSection>
        <Disclosure title="Advanced" summary={advancedSummary(form)} testId={id('advanced')}>
          <div className="space-y-6">
            <section className="space-y-4">
              <h3 className="text-sm font-medium">What it may cost</h3>
              <Field id={id('cost-cap')} label="Spend limit per run" hint="In whole currency. A run that would cost more is stopped rather than billed.">
                <Input id={id('cost-cap')} inputMode="decimal" value={form.costCap} onChange={(e) => set('costCap', e.target.value)} placeholder="0.50" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field id={id('daily-cap')} label="Spend limit per day">
                  <Input id={id('daily-cap')} inputMode="decimal" value={form.dailyCap} onChange={(e) => set('dailyCap', e.target.value)} placeholder="No daily limit" />
                </Field>
                <Field id={id('monthly-cap')} label="Spend limit per month">
                  <Input id={id('monthly-cap')} inputMode="decimal" value={form.monthlyCap} onChange={(e) => set('monthlyCap', e.target.value)} placeholder="No monthly limit" />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                {scope === 'agent'
                  ? 'For every channel of this agent together, except a channel with limits of its own. '
                  : 'For this channel alone once set here; otherwise it shares the agent’s. '}
                Days and months start at midnight UTC. Once a limit is reached, visitors are told it has reached its limit until
                it resets, and owners and admins are notified. Leave a field empty for no limit.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field id={id('per-user')} label="Messages per visitor, per hour">
                  <Input id={id('per-user')} inputMode="numeric" value={form.perUser} onChange={(e) => set('perUser', e.target.value)} placeholder="60" />
                </Field>
                <Field id={id('per-ip')} label="Messages per IP address, per hour">
                  <Input id={id('per-ip')} inputMode="numeric" value={form.perIp} onChange={(e) => set('perIp', e.target.value)} placeholder="120" />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                A visitor is identified by their sign-in or private chat cookie. Visitors sharing an IP address also share the IP
                allowance. These limits are not one shared bucket for everyone.
              </p>
            </section>

            <section className="space-y-4">
              <h3 className="text-sm font-medium">Visitor data</h3>
              <Field
                id={id('retention')}
                label="Delete visitor data after (days)"
                hint={
                  retentionError
                    ? undefined
                    : 'Leave blank to inherit the organization policy. This can shorten that policy, never extend it.'
                }
                error={retentionError ? 'Enter a whole number of at least 1 day.' : undefined}
              >
                <Input
                  id={id('retention')}
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={form.retentionDays}
                  onChange={(e) => set('retentionDays', e.target.value)}
                  placeholder="Use organization policy"
                />
              </Field>
              {(
                [
                  ['visitorCanExport', 'Let visitors download their data', 'On by default. Adds a download to the web chat and the website widget.'],
                  ['visitorCanDelete', 'Let visitors delete their data', 'On by default. Visitors can remove a conversation, or everything about them in the web chat.'],
                  [
                    'visitorMemory',
                    'Include visitor conversations in memory',
                    'Off by default. When on, visitor conversations may be summarized into shared agent memory and influence answers to other visitors.',
                  ],
                ] as const
              ).map(([key, label, hint]) => (
                <div key={key} className="flex items-center justify-between gap-4 rounded-md border p-3">
                  <div className="space-y-0.5">
                    <Label htmlFor={id(key)}>{label}</Label>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                  </div>
                  <Switch id={id(key)} checked={form[key]} onCheckedChange={(v) => set(key, v)} />
                </div>
              ))}
            </section>
          </div>
        </Disclosure>
      </FormSection>
    </>
  )
}
