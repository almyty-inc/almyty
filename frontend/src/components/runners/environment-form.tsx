/**
 * The one form for a hosted environment: the new-environment page and the
 * Settings card on an environment's page. Every field is one the API takes
 * (backend hosted-runners/dto/environment.dto.ts); the server checks them
 * all again and its message is shown when it refuses.
 */
import { useState, type FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { PlanHint } from '@/components/plan-indicator'
import { useEntitlement } from '@/hooks/use-entitlement'
import {
  ENVIRONMENT_NAME_PATTERN,
  ENVIRONMENT_NAME_RE,
  SHARED_ENVIRONMENTS_ENTITLEMENT,
  imageLabel,
  isPlainHost,
  parseAllowedSites,
  type HostedEnvironment,
  type HostedSettings,
} from './hosted-shared'

export interface EnvironmentFormProps {
  organizationId: string
  settings: HostedSettings
  /** The saved environment when editing; absent when creating. */
  initial?: HostedEnvironment
  submitLabel: string
  submitting?: boolean
  /** Everything read-only (hosted machines are off, or the caller may not change it). */
  disabled?: boolean
  onSubmit: (body: Record<string, unknown>) => void
  onCancel?: () => void
}

export function EnvironmentForm({ organizationId, settings, initial, submitLabel, submitting, disabled, onSubmit, onCancel }: EnvironmentFormProps) {
  const idle = settings.idleTimeoutMinutes
  const [name, setName] = useState(initial?.name ?? '')
  const [repoUrl, setRepoUrl] = useState(initial?.repo?.url ?? '')
  const [repoRef, setRepoRef] = useState(initial?.repo?.ref ?? '')
  const [image, setImage] = useState(initial?.image.base ?? settings.images[0] ?? '')
  const [setupScript, setSetupScript] = useState(initial?.setupScript ?? '')
  const [sites, setSites] = useState((initial?.egress.allowHosts ?? []).join('\n'))
  const [idleMinutes, setIdleMinutes] = useState(String(initial?.idleTimeoutMinutes ?? idle.default))
  const [allowVendorKeys, setAllowVendorKeys] = useState(initial?.allowVendorKeys ?? false)
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: initial?.visibility ?? 'private', teamId: initial?.teamId ?? null })
  const [tried, setTried] = useState(false)
  const shared = useEntitlement(SHARED_ENVIRONMENTS_ENTITLEMENT)

  const allowHosts = parseAllowedSites(sites)
  const badHosts = allowHosts.filter((h) => !isPlainHost(h))
  const minutes = Number(idleMinutes)
  const problems = {
    name: !ENVIRONMENT_NAME_RE.test(name) ? 'Use lowercase letters, digits and dashes, starting with a letter.' : null,
    repo: repoUrl.trim() && !/^https:\/\/\S+$/.test(repoUrl.trim()) ? 'Use the https address of the repository.' : null,
    image: !image ? 'Pick a starting point.' : null,
    sites: badHosts.length ? `Not a site name: ${badHosts.join(', ')}. Write each one exactly, like github.com.` : null,
    idle: !Number.isInteger(minutes) || minutes < idle.min || minutes > idle.max ? `Pick a whole number from ${idle.min} to ${idle.max}.` : null,
  }
  const invalid = Object.values(problems).some(Boolean)
  const show = (key: keyof typeof problems) => (tried || key === 'sites' ? problems[key] : null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if (invalid) return
    const url = repoUrl.trim()
    onSubmit({
      name,
      repo: url ? { url, ref: repoRef.trim() || null, ...(initial?.repo?.connectionId ? { connectionId: initial.repo.connectionId } : {}) } : null,
      image: { base: image },
      setupScript: setupScript.trim() ? setupScript : null,
      egress: { allowHosts, ...(initial?.egress.allowBinaries?.length ? { allowBinaries: initial.egress.allowBinaries } : {}) },
      idleTimeoutMinutes: minutes,
      allowVendorKeys,
      visibility: visibility.visibility,
      teamId: visibility.visibility === 'team' ? visibility.teamId : null,
    })
  }

  const locked = !shared.isLoading && !shared.enabled
  const field = 'space-y-1.5'
  const hint = 'text-xs text-muted-foreground'
  const error = 'text-xs text-destructive'

  return (
    <form className="space-y-6" onSubmit={submit} noValidate data-testid="environment-form">
      <fieldset disabled={disabled || submitting} className="space-y-6">
        <div className={field}>
          <Label htmlFor="env-name">Name</Label>
          <Input id="env-name" value={name} onChange={(e) => setName(e.target.value)} pattern={ENVIRONMENT_NAME_PATTERN} maxLength={64} placeholder="for example web-app" autoComplete="off" />
          {show('name') ? <p className={error}>{show('name')}</p> : <p className={hint}>Lowercase letters, digits and dashes. Its tools are named after it.</p>}
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <div className={field}>
            <Label htmlFor="env-repo">Repository <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="env-repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/your-org/your-repo" autoComplete="off" />
            {show('repo') ? <p className={error}>{show('repo')}</p> : <p className={hint}>The machine works in a copy of this repository.</p>}
          </div>
          <div className={field}>
            <Label htmlFor="env-ref">Branch <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="env-ref" value={repoRef} onChange={(e) => setRepoRef(e.target.value)} placeholder="the default branch" autoComplete="off" />
          </div>
        </div>

        <div className={field}>
          <Label htmlFor="env-image">Starting point</Label>
          <Select value={image} onValueChange={setImage}>
            <SelectTrigger id="env-image" className="sm:w-80"><SelectValue placeholder="Pick one" /></SelectTrigger>
            <SelectContent>
              {settings.images.map((name) => <SelectItem key={name} value={name}>{imageLabel(name)}</SelectItem>)}
              {initial && !settings.images.includes(initial.image.base) && <SelectItem value={initial.image.base}>{imageLabel(initial.image.base)} (no longer offered)</SelectItem>}
            </SelectContent>
          </Select>
          {show('image') ? <p className={error}>{show('image')}</p> : <p className={hint}>The software the machine starts with.</p>}
        </div>

        <div className={field}>
          <Label htmlFor="env-setup">Setup script <span className="font-normal text-muted-foreground">(optional)</span></Label>
          <Textarea id="env-setup" value={setupScript} onChange={(e) => setSetupScript(e.target.value)} rows={4} className="font-mono text-xs" placeholder="for example: npm ci" spellCheck={false} />
          <p className={hint}>Commands run on the machine to get it ready, for example installing what the project needs.</p>
        </div>

        <div className={field}>
          <Label htmlFor="env-sites">Allowed sites</Label>
          <Textarea id="env-sites" value={sites} onChange={(e) => setSites(e.target.value)} rows={3} className="font-mono text-xs" placeholder={'for example:\ngithub.com\nregistry.npmjs.org'} spellCheck={false} />
          {show('sites') ? (
            <p className={error}>{show('sites')}</p>
          ) : (
            <p className={hint}>The machine can only reach the websites listed here, one per line. Everything else is blocked. almyty and the repository are always allowed.</p>
          )}
        </div>

        <div className={field}>
          <Label htmlFor="env-idle">Park after</Label>
          <div className="flex items-center gap-2">
            <Input id="env-idle" type="number" inputMode="numeric" min={idle.min} max={idle.max} step={1} value={idleMinutes} onChange={(e) => setIdleMinutes(e.target.value)} className="w-24" />
            <span className="text-sm text-muted-foreground">minutes without use</span>
          </div>
          {show('idle') ? (
            <p className={error}>{show('idle')}</p>
          ) : (
            <p className={hint}>The machine stops when nobody has used it for this long, and starts again when it is needed. Its files are kept. From {idle.min} to {idle.max}; {idle.default} if you leave it.</p>
          )}
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="env-vendor-keys">Let coding tools use the provider's own key instead of almyty</Label>
            <p className={hint}>
              Off: coding tools on the machine reach models through almyty, and no provider key is put on the machine. Turn it on only for a tool that cannot work through almyty; the key then sits on the machine.
            </p>
          </div>
          <Switch id="env-vendor-keys" checked={allowVendorKeys} onCheckedChange={setAllowVendorKeys} />
        </div>

        <VisibilityField
          organizationId={organizationId}
          value={visibility}
          onChange={setVisibility}
          noun="this environment"
          descriptions={{ private: "Only you can use it. Your organization's admins can still see it, and it passes to them if you leave." }}
          disabled={disabled || submitting}
          lockedOptions={locked ? ['team', 'org'] : undefined}
          lockedHint={
            <PlanHint feature={SHARED_ENVIRONMENTS_ENTITLEMENT} testId="environment-sharing-locked">
              Sharing an environment with a team or everyone is part of the Business plan.
            </PlanHint>
          }
        />
        <p className={hint}>Everyone who uses it gets a machine and files of their own.</p>
      </fieldset>

      {!disabled && (
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="submit" disabled={submitting}>{submitLabel}</Button>
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>Cancel</Button>}
        </div>
      )}
    </form>
  )
}
