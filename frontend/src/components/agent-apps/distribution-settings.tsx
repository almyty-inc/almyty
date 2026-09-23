import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Trash2 } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Input } from '@/components/ui/input'
import { SecretInput } from '@/components/ui/secret-input'
import { useConfirm } from '@/components/ui/confirm-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import { getApiBaseUrl } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  CHANNEL_CREDENTIAL_FIELDS,
  DISTRIBUTION_DESCRIPTIONS,
  DISTRIBUTION_INBOUND,
  DISTRIBUTION_LABELS,
  PACKAGED_TARGETS,
  agentAppsApi,
  distributionCallbackUrl,
  isBuildable,
  isChannelTarget,
  servesOverGateway,
  type AgentApp,
  type AppDistribution,
  type DistributionStatus,
} from '@/lib/agent-apps'
import { BuildPanel } from './build-panel'

/** Stands in for "the product's default", because a Select cannot take ''. */
const DEFAULT_AGENT = 'default'

/** Mirrors BUNDLE_ID_PATTERN in the backend (agent-app.rules.ts). */
const BUNDLE_ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/

/** Targets the backend refuses to build without a bundle id. */
const NEEDS_BUNDLE_ID = ['desktop', 'binary']

/**
 * The two refusals that belong to a distribution. Everything else the
 * distribution check returns is about the app as a whole (no agents, no
 * cost cap, an entitlement), and is shown once, on the app's page, not
 * repeated inside every channel.
 */
const DISTRIBUTION_REFUSALS = new Set(['MISSING_CREDENTIALS', 'BUNDLE_ID_INVALID'])

const STATUS: Record<DistributionStatus, { label: string; variant: 'success' | 'secondary' | 'warning' | 'outline' | 'destructive' }> = {
  live: { label: 'Live', variant: 'success' },
  built: { label: 'Built', variant: 'secondary' },
  building: { label: 'Building', variant: 'warning' },
  draft: { label: 'Draft', variant: 'outline' },
  failed: { label: 'Build failed', variant: 'destructive' },
}

export interface DistributionSettingsProps {
  app: AgentApp
  distribution: AppDistribution
  /** Every agent in the org, so this surface can name one of the app's. */
  agents?: Array<{ id: string; name: string }>
}

/**
 * One distribution on its own page: what the platform needs, where the
 * platform should call, and how to ship it.
 *
 * The settings are one form with one Save. Publishing and building are
 * actions on what is saved, so they sit below it as buttons of their
 * own rather than as a second save. Branding is not repeated here: it
 * belongs to the app, so the product looks the same everywhere.
 */
export function DistributionSettings({ app, distribution, agents = [] }: DistributionSettingsProps) {
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const { confirm, dialog: confirmDialog } = useConfirm()

  const target = distribution.target
  const label = DISTRIBUTION_LABELS[target] ?? target
  const appPath = `/apps/${app.slug}`
  const packaged = PACKAGED_TARGETS.includes(target)
  const channel = isChannelTarget(target)
  const served = servesOverGateway(target)
  const fields = channel ? CHANNEL_CREDENTIAL_FIELDS[target] ?? [] : []

  // What is stored, updated locally on a successful save so the form is
  // clean again without waiting for the refetch.
  const [stored, setStored] = useState<Record<string, any>>(() => ({
    ...(distribution.configuration ?? {}),
  }))
  const storedBundleId = (stored.bundleId as string | undefined) ?? `com.example.${app.slug}`
  const storedAgent = (stored.agentId as string | undefined) ?? ''

  const [bundleId, setBundleId] = useState(storedBundleId)
  const [agentId, setAgentId] = useState(storedAgent)
  // Secrets start empty: a stored one is never shown back, and an empty
  // secret field means "keep what is stored". Plain values start as
  // stored, so clearing one is a real edit.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => [f.key, f.secret ? '' : ((stored[f.key] as string) ?? '')]),
    ),
  )
  const [bundleError, setBundleError] = useState<string | undefined>()

  const changedFields = fields.filter((f) =>
    f.secret ? values[f.key] !== '' : values[f.key] !== ((stored[f.key] as string) ?? ''),
  )
  const dirty =
    (packaged && bundleId !== storedBundleId) || agentId !== storedAgent || changedFields.length > 0
  const guard = useLeaveGuard(dirty)

  const appAgents = app.agentIds.map((id) => agents.find((a) => a.id === id) ?? { id, name: id })
  const choosesAgent = served && appAgents.length > 1
  const hasForm = packaged || fields.length > 0 || choosesAgent

  const { data: check } = useQuery({
    queryKey: ['agent-app-distribution-check', app.slug, target],
    queryFn: () => agentAppsApi.checkDistribution(app.slug, target),
  })
  const appNotReady = (check?.refusals ?? []).some((r) => !DISTRIBUTION_REFUSALS.has(r.code))

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['agent-app-distribution-check', app.slug, target] })
    queryClient.invalidateQueries({ queryKey: ['agent-app', app.slug] })
    queryClient.invalidateQueries({ queryKey: ['agent-app-check', app.slug] })
  }

  const save = useMutation({
    // Only what changed. The backend merges into the stored config, so
    // re-sending the existing configuration is not just redundant -- a
    // masked secret sent back would overwrite the real value.
    mutationFn: (patch: Record<string, unknown>) =>
      agentAppsApi.addDistribution(app.slug, target, patch),
    onSuccess: (_saved, patch) => {
      success('Saved', `${label} settings updated.`)
      setStored((s) => ({ ...s, ...patch }))
      setValues((v) =>
        Object.fromEntries(fields.map((f) => [f.key, f.secret ? '' : v[f.key] ?? ''])),
      )
      refresh()
    },
    onError: (err: unknown) =>
      errorNotif('Could not save', getApiErrorMessage(err, 'Please try again.')),
  })

  // The certificate choice belongs to the build, so it is applied when
  // it is picked rather than waiting for the settings Save.
  const setSigning = useMutation({
    mutationFn: (signingCredentialId: string) =>
      agentAppsApi.addDistribution(app.slug, target, { signingCredentialId }),
    onSuccess: (_saved, signingCredentialId) => {
      setStored((s) => ({ ...s, signingCredentialId }))
      refresh()
    },
    onError: (err: unknown) =>
      errorNotif('Could not change the certificate', getApiErrorMessage(err, 'Please try again.')),
  })

  const live = distribution.status === 'live'
  const publish = useMutation({
    mutationFn: () =>
      live
        ? agentAppsApi.unpublishDistribution(app.slug, target)
        : agentAppsApi.publishDistribution(app.slug, target),
    onSuccess: () => {
      success(
        live ? 'Unpublished' : 'Published',
        live
          ? 'It has stopped answering. Its settings and address are kept.'
          : 'It is answering now.',
      )
      refresh()
    },
    // The backend throws the joined list of every blocker it found --
    // missing cost cap, white label not entitled, no agents. Throwing
    // that away left the one refusal that goes out of its way to be
    // actionable as a bare title.
    onError: (err: unknown) =>
      errorNotif(
        live ? 'Could not unpublish' : 'Could not publish',
        getApiErrorMessage(err, live ? 'It is still answering.' : 'It is not answering yet.'),
      ),
  })

  const remove = useMutation({
    mutationFn: () => agentAppsApi.removeDistribution(app.slug, target),
    onSuccess: () => {
      success('Distribution removed', 'It is no longer on this app.')
      queryClient.invalidateQueries({ queryKey: ['agent-app', app.slug] })
      queryClient.invalidateQueries({ queryKey: ['agent-app-check', app.slug] })
      guard.leave(appPath)
    },
    onError: (err: unknown) =>
      errorNotif('Could not remove', getApiErrorMessage(err, 'Something went wrong.')),
  })

  const askRemove = async () => {
    const ok = await confirm({
      title: 'Remove distribution?',
      description: `This removes the ${label} distribution and its configuration from this app. Builds already downloaded keep working.`,
      confirmLabel: 'Remove distribution',
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  const submit = () => {
    const trimmed = bundleId.trim()
    if (packaged) {
      const required = NEEDS_BUNDLE_ID.includes(target)
      if ((required || trimmed) && !BUNDLE_ID_PATTERN.test(trimmed)) {
        setBundleError('Use a reverse-domain name you own, such as com.acme.assistant.')
        return
      }
    }
    setBundleError(undefined)
    const patch: Record<string, unknown> = {}
    if (packaged && trimmed !== storedBundleId) patch.bundleId = trimmed
    if (agentId !== storedAgent) patch.agentId = agentId
    for (const f of changedFields) patch[f.key] = values[f.key].trim()
    if (Object.keys(patch).length === 0) return
    save.mutate(patch)
  }

  const orgSlug =
    currentOrganization?.slug ||
    currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') ||
    'org'
  const inbound = DISTRIBUTION_INBOUND[target]
  const callbackUrl = distributionCallbackUrl(getApiBaseUrl(), orgSlug, app.slug, target)
  const status = STATUS[distribution.status] ?? STATUS.draft

  return (
    <FormPage
      title={label}
      description={DISTRIBUTION_DESCRIPTIONS[target]}
      back={{ to: appPath, label: app.branding?.appName || app.name }}
      guard={guard}
      onSubmit={hasForm ? submit : undefined}
      submitLabel="Save"
      submitting={save.isPending}
      submitDisabled={!dirty}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.variant}>{status.label}</Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={remove.isPending}
            onClick={() => void askRemove()}
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
            Remove
          </Button>
        </div>
      }
    >
      {packaged && (
        <FormSection title="Identity">
          <Field
            id="dist-bundle-id"
            label="Bundle identifier"
            required={NEEDS_BUNDLE_ID.includes(target)}
            hint="A reverse-domain name you own, such as com.acme.assistant. Signing toolchains identify the app by it."
            error={bundleError}
          >
            <Input
              value={bundleId}
              onChange={(e) => setBundleId(e.target.value)}
              placeholder="com.acme.assistant"
              autoComplete="off"
            />
          </Field>
        </FormSection>
      )}

      {fields.length > 0 && (
        <FormSection
          title="Platform settings"
          description={`From your own ${label} account. Stored encrypted.`}
        >
          <div className="space-y-4">
            {fields.map((field) => {
              const has = !!(stored[field.key] as string | undefined)?.toString().trim()
              const missing = field.required && !has && !values[field.key]?.trim()
              return (
                <Field
                  key={field.key}
                  id={`cred-${field.key}`}
                  label={field.label}
                  required={field.required}
                  hint={
                    <>
                      {field.hint}
                      {missing && (
                        <span className="mt-0.5 block text-amber-700 dark:text-amber-300">
                          Needed before this can go live.
                        </span>
                      )}
                    </>
                  }
                >
                  <SecretInput
                    masked={!!field.secret}
                    value={values[field.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
                    placeholder={
                      field.secret && has ? 'Saved. Type a new value to replace it.' : field.placeholder
                    }
                  />
                </Field>
              )
            })}
          </div>
        </FormSection>
      )}

      {callbackUrl && inbound && (
        <FormSection title="Callback URL" description={inbound.where}>
          <CopyField id="dist-callback-url" value={callbackUrl} label="Callback URL" />
        </FormSection>
      )}
      {channel && !callbackUrl && inbound?.why && (
        <p className="text-sm text-muted-foreground" data-testid="no-callback-url">
          No callback URL needed: {inbound.why}
        </p>
      )}

      {/* A product can carry several agents, and which one answers is
          per surface: a billing channel should be able to reach the
          billing agent. Only worth asking when there is a choice. */}
      {choosesAgent && (
        <FormSection>
          <Field
            id="dist-agent"
            label="Answered by"
            hint="Which of the app's agents answers here. The first agent is the app's default."
          >
            <Select
              value={agentId || DEFAULT_AGENT}
              onValueChange={(value) => setAgentId(value === DEFAULT_AGENT ? '' : value)}
            >
              <SelectTrigger id="dist-agent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_AGENT}>{appAgents[0].name} (the product default)</SelectItem>
                {appAgents.slice(1).map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FormSection>
      )}

      {/* Adding a distribution records where a product will ship.
          Publishing is the separate decision to let people reach it. */}
      {served && (
        <FormSection
          title={live ? 'Live' : 'Publish'}
          description={
            live
              ? 'Unpublish stops it answering and keeps its address, so publishing again needs no re-registration.'
              : 'Publishing stands up the surface and points it at this app. It uses the saved settings.'
          }
        >
          {appNotReady && (
            <p className="flex gap-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>
                The app itself is not ready to publish yet.{' '}
                <Link to={appPath} className="underline underline-offset-2">
                  See what it needs
                </Link>
                .
              </span>
            </p>
          )}
          <Button
            type="button"
            variant={hasForm ? 'outline' : 'default'}
            disabled={publish.isPending}
            onClick={() => publish.mutate()}
          >
            {publish.isPending
              ? live
                ? 'Unpublishing...'
                : 'Publishing...'
              : live
                ? 'Unpublish'
                : 'Publish'}
          </Button>
        </FormSection>
      )}

      {/* Builds run on our machines, so this is a button rather than a
          command to paste into a terminal. */}
      {isBuildable(target) && (
        <FormSection title="Builds">
          <BuildPanel
            app={app}
            target={target}
            signingCredentialId={(stored.signingCredentialId as string | undefined) ?? ''}
            onSigningCredentialChange={(id) => setSigning.mutate(id)}
            onAddCertificate={(kind) =>
              navigate(`/apps/${app.slug}/distributions/${target}/signing/new?kind=${kind}`)
            }
          />
          {distribution.lastBuild && (
            <div className="space-y-1 rounded-md border p-3 text-xs">
              <div className="font-medium">Last build</div>
              {distribution.lastBuild.error ? (
                <p className="text-destructive">{distribution.lastBuild.error}</p>
              ) : (
                <p className="text-muted-foreground">
                  v{distribution.lastBuild.version ?? '?'} for{' '}
                  {distribution.lastBuild.platform ?? 'unknown platform'}
                  {distribution.lastBuild.signed ? ', signed' : ', unsigned'}
                </p>
              )}
            </div>
          )}
        </FormSection>
      )}
      {confirmDialog}
    </FormPage>
  )
}
