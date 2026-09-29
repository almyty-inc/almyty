import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Trash2 } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { CredentialChoice } from '@/components/credentials/credential-choice'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import { Switch } from '@/components/ui/switch'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { getApiBaseUrl } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  BUNDLE_ID_PATTERN,
  CHANNEL_CREDENTIAL_FIELDS,
  CHANNEL_DESCRIPTIONS,
  CHANNEL_INBOUND,
  CHANNEL_LABELS,
  PACKAGED_CHANNEL_TYPES,
  agentChannelsApi,
  channelCallbackUrl,
  channelConnectorKey,
  grantsLocalAccess,
  isBuildable,
  isMessagingChannel,
  isOpenToAnyone,
  missingChannelFields,
  webChatUrl,
  type AgentChannel,
  type ChannelCapabilities,
  type ChannelCredentialField,
  type EffectiveSettings,
} from '@/lib/agent-channels'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { Agent } from '@/types'
import { BuildPanel } from './build-panel'
import { CHANNEL_STATUS } from './channel-meta'
import { channelKeys, channelsTabPath } from './channel-page-loader'
import { A2aChannelSettings, WebChatAddress, WebChatSettings, WidgetChannelSettings } from './hosted-channels'
import {
  PublicSettingsFields,
  formFromEffective,
  overridesFromForm,
  retentionInvalid,
  type PublicSettingsForm,
} from './public-settings-fields'
import { SlackInstall } from './slack-install'

/** Refusals a field on this page answers; the rest are said once, next to Publish. */
const FIELD_REFUSALS = new Set(['MISSING_CREDENTIALS', 'BUNDLE_ID_INVALID'])

export interface ChannelSettingsProps {
  agent: Agent
  channel: AgentChannel
  /** What the channel inherits from the agent, to tell its own settings apart. */
  inherited: EffectiveSettings
}

const list = (text: string) =>
  text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)

/**
 * One channel of an agent, on its own page: what the platform needs,
 * where it answers, how to publish or build it, and, when it should
 * differ from the agent, its own branding and visitor rules.
 *
 * The settings are one form with one Save. Publishing and building are
 * actions on what is saved, so they are buttons of their own. The web
 * chat's sign-in, domain and allowed-site cards save themselves.
 */
export function ChannelSettings({ agent, channel, inherited }: ChannelSettingsProps) {
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { currentOrganization } = useOrganizationStore()
  const { confirm, dialog: confirmDialog } = useConfirm()

  const type = channel.type
  const label = CHANNEL_LABELS[type] ?? type
  const back = channelsTabPath(agent.id)
  const messaging = isMessagingChannel(type)
  const packaged = PACKAGED_CHANNEL_TYPES.includes(type)
  const buildable = isBuildable(type)
  const fields = messaging ? CHANNEL_CREDENTIAL_FIELDS[type] ?? [] : []

  // What is stored, refreshed from each save's response so the form is
  // clean again without waiting for a refetch.
  const [stored, setStored] = useState<AgentChannel>(channel)
  const configuration = stored.configuration ?? {}
  const live = stored.status === 'live'

  // Keys: from a credential on Credentials, or entered here. A credential
  // this channel made for keys typed here is "entered here".
  const storedCredential: string | null = (() => {
    const id = configuration.credentialId
    return typeof id === 'string' && id && stored.credentialPicked ? id : null
  })()
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [credentialTouched, setCredentialTouched] = useState(false)
  const pickedCredential = credentialTouched ? credentialId : null
  // Secrets start empty: a stored one is never shown back, and an empty
  // secret field means "keep what is stored".
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.secret ? '' : ((configuration[f.key] as string) ?? '')])),
  )
  const changedFields = fields.filter((f) => (f.secret ? values[f.key] !== '' : values[f.key] !== ((configuration[f.key] as string) ?? '')))

  const storedBundleId = (configuration.bundleId as string | undefined) ?? ''
  const [bundleId, setBundleId] = useState(storedBundleId)
  const [bundleError, setBundleError] = useState<string | undefined>()

  const storedCapabilities = (configuration.capabilities ?? {}) as ChannelCapabilities
  const [shell, setShell] = useState(storedCapabilities.shell === true)
  const [fsRead, setFsRead] = useState((storedCapabilities.filesystemRead ?? []).join(', '))
  const [approval, setApproval] = useState((storedCapabilities.requireApprovalFor ?? []).length > 0)
  const capabilitiesChanged =
    buildable &&
    (shell !== (storedCapabilities.shell === true) ||
      fsRead !== (storedCapabilities.filesystemRead ?? []).join(', ') ||
      approval !== (storedCapabilities.requireApprovalFor ?? []).length > 0)

  // The channel's own branding and visitor rules: the form shows what it
  // resolves to, and only what differs from the agent is stored.
  const ownAtStart = !!stored.branding || !!stored.visitorRules
  const [own, setOwn] = useState(ownAtStart)
  const startForm = useMemo(() => formFromEffective(stored.effective), [stored])
  const [overrideForm, setOverrideForm] = useState<PublicSettingsForm>(startForm)
  const overrides = own ? overridesFromForm(overrideForm, inherited) : { branding: null, visitorRules: null }
  const overridesChanged =
    JSON.stringify(overrides.branding) !== JSON.stringify(stored.branding ?? null) ||
    JSON.stringify(overrides.visitorRules) !== JSON.stringify(stored.visitorRules ?? null)

  const dirty =
    changedFields.length > 0 ||
    (credentialTouched && credentialId !== storedCredential) ||
    (packaged && bundleId !== storedBundleId) ||
    capabilitiesChanged ||
    overridesChanged
  const guard = useLeaveGuard(dirty)

  const { data: check } = useQuery({
    queryKey: channelKeys.check(agent.id, channel.id),
    queryFn: () => agentChannelsApi.check(agent.id, channel.id),
  })
  const publishRefusals = (check?.refusals ?? []).filter((r) => !FIELD_REFUSALS.has(r.code))

  const refresh = (saved?: AgentChannel) => {
    if (saved) {
      setStored(saved)
      queryClient.setQueryData(channelKeys.one(agent.id, channel.id), saved)
    }
    queryClient.invalidateQueries({ queryKey: channelKeys.check(agent.id, channel.id) })
    queryClient.invalidateQueries({ queryKey: channelKeys.list(agent.id) })
  }

  const save = useMutation({
    mutationFn: (body: Parameters<typeof agentChannelsApi.update>[2]) => agentChannelsApi.update(agent.id, channel.id, body),
    onSuccess: (saved) => {
      success('Saved', `${label} settings updated.`)
      setValues((v) => Object.fromEntries(fields.map((f) => [f.key, f.secret ? '' : v[f.key] ?? ''])))
      setCredentialTouched(false)
      refresh(saved)
    },
    onError: (err: unknown) => errorNotif('Could not save', getApiErrorMessage(err, 'Please try again.')),
  })

  // The certificate choice belongs to the build, so it applies when picked.
  const setSigning = useMutation({
    mutationFn: (signingCredentialId: string) =>
      agentChannelsApi.update(agent.id, channel.id, { configuration: { signingCredentialId } }),
    onSuccess: (saved) => refresh(saved),
    onError: (err: unknown) => errorNotif('Could not change the certificate', getApiErrorMessage(err, 'Please try again.')),
  })

  const publish = useMutation({
    mutationFn: () => (live ? agentChannelsApi.unpublish(agent.id, channel.id) : agentChannelsApi.publish(agent.id, channel.id)),
    onSuccess: (saved) => {
      success(
        live ? 'Unpublished' : 'Published',
        live ? 'It has stopped answering. Its settings and address are kept.' : 'It is answering now.',
      )
      refresh(saved)
    },
    // The backend says every reason it refused, in one sentence each.
    onError: (err: unknown) =>
      errorNotif(
        live ? 'Could not unpublish' : 'Could not publish',
        getApiErrorMessage(err, live ? 'It is still answering.' : 'It is not answering yet.'),
      ),
  })

  const remove = useMutation({
    mutationFn: () => agentChannelsApi.remove(agent.id, channel.id),
    onSuccess: () => {
      success('Deleted', `${label} is no longer a channel of ${agent.name}.`)
      queryClient.invalidateQueries({ queryKey: channelKeys.list(agent.id) })
      guard.leave(back)
    },
    onError: (err: unknown) => errorNotif('Could not delete', getApiErrorMessage(err, 'Something went wrong.')),
  })

  const askRemove = async () => {
    const ok = await confirm({
      title: `Delete ${label}?`,
      description: 'It stops answering and its settings go with it. Downloads already handed out keep working.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  const submit = () => {
    const trimmed = bundleId.trim()
    if (packaged && trimmed !== storedBundleId && !BUNDLE_ID_PATTERN.test(trimmed)) {
      setBundleError('Use a reverse-domain name you own, such as com.acme.assistant.')
      return
    }
    setBundleError(undefined)
    const patch: Record<string, unknown> = {}
    if (packaged && trimmed !== storedBundleId) patch.bundleId = trimmed
    if (capabilitiesChanged) {
      patch.capabilities = {
        ...storedCapabilities,
        shell,
        filesystemRead: list(fsRead),
        requireApprovalFor: approval ? ['shell'] : [],
      }
    }
    if (!pickedCredential) for (const f of changedFields) patch[f.key] = values[f.key].trim()
    const body: Parameters<typeof agentChannelsApi.update>[2] = {}
    if (Object.keys(patch).length) body.configuration = patch
    if (credentialTouched && credentialId !== storedCredential) body.credentialId = credentialId
    if (overridesChanged) {
      body.branding = overrides.branding
      body.visitorRules = overrides.visitorRules
    }
    if (Object.keys(body).length === 0) return
    save.mutate(body)
  }

  const orgSlug =
    currentOrganization?.slug || currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
  const inbound = CHANNEL_INBOUND[type]
  const callbackUrl = channelCallbackUrl(getApiBaseUrl(), orgSlug, stored)
  const status = CHANNEL_STATUS[stored.status] ?? CHANNEL_STATUS.draft

  const has = (key: string) =>
    !!pickedCredential ||
    (!credentialTouched && !!storedCredential) ||
    !!(configuration[key] as string | undefined)?.toString().trim() ||
    (Array.isArray(configuration.credentialKeys) && configuration.credentialKeys.includes(key)) ||
    !!values[key]?.trim()
  const missing = new Set(missingChannelFields(type, has))
  const everyday = fields.filter((f) => !f.advanced)
  const alternatives = fields.filter((f) => f.advanced)
  const usingCredential = credentialTouched ? credentialId : storedCredential

  const renderField = (field: ChannelCredentialField) => {
    const saved =
      !!(configuration[field.key] as string | undefined)?.toString().trim() ||
      (Array.isArray(configuration.credentialKeys) && configuration.credentialKeys.includes(field.key))
    return (
      <Field
        key={field.key}
        id={`cred-${field.key}`}
        label={field.label}
        required={field.required}
        hint={
          <>
            {field.hint}
            {missing.has(field.key) && (
              <span className="mt-0.5 block text-amber-700 dark:text-amber-300">Needed before this can go live.</span>
            )}
          </>
        }
      >
        <SecretInput
          id={`cred-${field.key}`}
          masked={!!field.secret}
          value={values[field.key] ?? ''}
          onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
          placeholder={field.secret && saved ? 'Saved. Type a new value to replace it.' : field.placeholder}
        />
      </Field>
    )
  }

  const notReady = publishRefusals.length > 0 && (
    <ul className="space-y-1" data-testid="channel-refusals">
      {publishRefusals.map((r) => (
        <li key={r.code} className="flex gap-2 text-sm text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{r.message}</span>
        </li>
      ))}
    </ul>
  )

  const publishSection = !buildable && (
    <FormSection
      title={live ? 'Live' : 'Publish'}
      description={
        live
          ? 'Unpublish stops it answering and keeps its address, so publishing again needs no re-registration.'
          : 'Publishing makes it answer, with the saved settings.'
      }
    >
      {type === 'web' && <WebChatAddress channel={stored} />}
      {notReady}
      <div>
        <Button type="button" variant="outline" disabled={publish.isPending || dirty} onClick={() => publish.mutate()}>
          {publish.isPending ? (live ? 'Unpublishing...' : 'Publishing...') : live ? 'Unpublish' : 'Publish'}
        </Button>
        {dirty && <p className="mt-1 text-xs text-muted-foreground">Save your changes first.</p>}
      </div>
    </FormSection>
  )

  // A desktop app is a window onto one of the agent's web chats: the one
  // it names, else the agent's first.
  const { data: siblings } = useQuery({
    queryKey: channelKeys.list(agent.id),
    queryFn: () => agentChannelsApi.list(agent.id),
    enabled: type === 'desktop',
  })
  const opensWebChat = (() => {
    if (type !== 'desktop') return null
    const chats = (siblings ?? []).filter((c) => c.type === 'web' && c.slug)
    const chat = chats.find((c) => c.id === configuration.webChatChannelId) ?? chats[0]
    return chat?.slug ? webChatUrl(chat.slug) : null
  })()

  return (
    <FormPage
      title={label}
      description={CHANNEL_DESCRIPTIONS[type]}
      back={{ to: back, label: agent.name }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Save"
      submitting={save.isPending}
      submitDisabled={!dirty || (own && retentionInvalid(overrideForm))}
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
            Delete
          </Button>
        </div>
      }
    >
      {(type === 'web' || type === 'widget' || type === 'a2a') && publishSection}

      {messaging && (
        <FormSection
          title={type === 'slack' ? 'Add to Slack' : 'Keys'}
          description={
            type === 'slack'
              ? 'Create a Slack app at api.slack.com/apps and use its credentials. Once it is published, anyone you send the install link to can add it to their workspace.'
              : 'From your own account on the platform. Stored encrypted; a saved secret is never shown again.'
          }
        >
          <CredentialChoice
            id="channel-credential"
            label="Keys"
            connectorKey={channelConnectorKey(type)}
            value={usingCredential}
            onChange={(id) => {
              setCredentialTouched(true)
              setCredentialId(id)
            }}
          />
          {!usingCredential && (
            <>
              <div className="space-y-4">{everyday.map(renderField)}</div>
              {alternatives.length > 0 && (
                <Disclosure title="Advanced" summary="One workspace with a bot token instead">
                  <div className="space-y-4">{alternatives.map(renderField)}</div>
                </Disclosure>
              )}
            </>
          )}
        </FormSection>
      )}

      {type === 'slack' && live && stored.gatewayId && <SlackInstall gatewayId={stored.gatewayId} />}

      {messaging && callbackUrl && inbound && (
        <FormSection title="Callback URL" description={inbound.where}>
          <CopyField id="channel-callback-url" value={callbackUrl} label="Callback URL" />
        </FormSection>
      )}
      {messaging && !callbackUrl && inbound?.why && (
        <p className="text-sm text-muted-foreground" data-testid="no-callback-url">
          No callback URL needed: {inbound.why}
        </p>
      )}

      {messaging && publishSection}

      {type === 'web' && <WebChatSettings channel={stored} />}
      {type === 'widget' && <WidgetChannelSettings channel={stored} />}
      {type === 'a2a' && <A2aChannelSettings channel={stored} orgSlug={orgSlug} />}

      {buildable && (
        <FormSection title="Builds" description={type === 'desktop' && opensWebChat ? `It opens the web chat at ${opensWebChat}.` : undefined}>
          {notReady}
          <BuildPanel
            agentId={agent.id}
            channel={stored}
            signingCredentialId={(configuration.signingCredentialId as string | undefined) ?? ''}
            onSigningCredentialChange={(id) => setSigning.mutate(id)}
            onAddCertificate={(kind) => navigate(`/agents/${agent.id}/channels/${channel.id}/signing/new?kind=${kind}`)}
          />
          {stored.lastBuild && (
            <div className="space-y-1 rounded-md border p-3 text-xs">
              <div className="font-medium">Last build recorded</div>
              {stored.lastBuild.error ? (
                <p className="text-destructive">{stored.lastBuild.error}</p>
              ) : (
                <p className="text-muted-foreground">
                  v{stored.lastBuild.version ?? '?'} for {stored.lastBuild.platform ?? 'unknown platform'}
                  {stored.lastBuild.signed ? ', signed' : ', unsigned'}
                </p>
              )}
            </div>
          )}
        </FormSection>
      )}

      {buildable && (
        <FormSection
          title="What it may touch"
          description="On the machine it is installed on. Off unless you turn it on."
        >
          {isOpenToAnyone(stored.effective.visitorRules.authMode) &&
            grantsLocalAccess({ shell, filesystemRead: list(fsRead) }) && (
              <p className="flex gap-2 rounded-md border border-amber-400 bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  Anyone can use this app, so it cannot also have local access. It runs on your users&apos; machines. Restrict who
                  can use it, or remove the access.
                </span>
              </p>
            )}
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="channel-shell">Run local commands</Label>
              <p className="text-xs text-muted-foreground">Requires an attached runner.</p>
            </div>
            <Switch id="channel-shell" checked={shell} onCheckedChange={setShell} />
          </div>
          {shell && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="channel-approval">Ask before running a command</Label>
                <p className="text-xs text-muted-foreground">Needed before local commands are allowed.</p>
              </div>
              <Switch id="channel-approval" checked={approval} onCheckedChange={setApproval} />
            </div>
          )}
          <Field id="channel-fs-read" label="Readable paths" hint="Comma separated. Leave empty for no filesystem access.">
            <Input id="channel-fs-read" value={fsRead} onChange={(e) => setFsRead(e.target.value)} placeholder="~/Documents, /srv/data" />
          </Field>
        </FormSection>
      )}

      {packaged && (
        <FormSection>
          <Disclosure
            title="Advanced"
            summary={`App ID: ${bundleId}`}
            defaultOpen={!BUNDLE_ID_PATTERN.test(storedBundleId)}
            testId="channel-bundle-advanced"
          >
            <Field
              id="channel-bundle-id"
              label="App ID"
              required={type !== 'tui'}
              hint="The name computers use to tell your app apart from others. The one filled in works; change it only to match your own developer account, such as com.acme.assistant."
              error={bundleError}
            >
              <Input id="channel-bundle-id" value={bundleId} onChange={(e) => setBundleId(e.target.value)} autoComplete="off" />
            </Field>
          </Disclosure>
        </FormSection>
      )}

      {type !== 'a2a' && (
        <FormSection
          title="Branding and visitor rules"
          description={
            own
              ? `This channel's own. Everything you do not change here still follows ${agent.name}.`
              : `Same as ${agent.name}. Change them here to give this channel its own.`
          }
        >
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="channel-own-settings">Use this channel&apos;s own</Label>
              <p className="text-xs text-muted-foreground">
                Off uses {agent.name}&apos;s branding and visitor rules, as they are set on its Channels tab.
              </p>
            </div>
            <Switch
              id="channel-own-settings"
              checked={own}
              onCheckedChange={(on) => {
                setOwn(on)
                if (on) setOverrideForm(formFromEffective(stored.effective))
              }}
            />
          </div>
          {own && (
            <div className="space-y-6" data-testid="channel-own-settings">
              <PublicSettingsFields form={overrideForm} onChange={setOverrideForm} idPrefix="channel" scope="channel" />
            </div>
          )}
          {!own && type === 'web' && stored.slug && (
            <p className="text-xs text-muted-foreground">
              People open it at <span className="font-mono">{webChatUrl(stored.slug)}</span>.
            </p>
          )}
        </FormSection>
      )}
      {confirmDialog}
    </FormPage>
  )
}
