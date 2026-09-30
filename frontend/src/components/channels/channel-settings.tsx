import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Trash2 } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { useConnectionOptions } from '@/components/connections/connection-select'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyField } from '@/components/ui/copy-field'
import { Disclosure } from '@/components/ui/disclosure'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { getApiBaseUrl } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import {
  BUNDLE_ID_PATTERN,
  CHANNEL_DESCRIPTIONS,
  CHANNEL_INBOUND,
  CHANNEL_LABELS,
  PACKAGED_CHANNEL_TYPES,
  SLACK_APP_CONNECTOR_KEY,
  agentChannelsApi,
  carriesDisclosure,
  channelCallbackUrl,
  channelConnectorKey,
  grantsLocalAccess,
  isBuildable,
  isMessagingChannel,
  isOpenToAnyone,
  webChatAddressError,
  webChatUrl,
  type AgentChannel,
  type ChannelCapabilities,
  type EffectiveSettings,
  type WebhookRegistration,
} from '@/lib/agent-channels'
import { DEFAULT_AI_DISCLOSURE } from '@/lib/hosted-chat'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { Agent } from '@/types'
import { BuildPanel } from './build-panel'
import { CHANNEL_STATUS } from './channel-meta'
import { channelKeys, channelsTabPath } from './channel-page-loader'
import {
  A2aChannelSettings,
  SurfaceFieldError,
  WebChatLink,
  WebChatSettings,
  WidgetChannelSettings,
  useSurfaceSettings,
} from './hosted-channels'
import {
  PublicSettingsFields,
  formFromEffective,
  overridesFromForm,
  retentionInvalid,
  type PublicSettingsForm,
} from './public-settings-fields'
import { SlackInstall } from './slack-install'

/** Refusals a field on this page answers; the rest are said once, next to Publish. */
const FIELD_REFUSALS = new Set(['MISSING_CREDENTIALS', 'BUNDLE_ID_INVALID', 'DISCLOSURE_REMOVAL_NOT_ENTITLED', 'SENDER_NAME_REQUIRED'])

/** What the sender name field says when it is cleared. */
export const SENDER_NAME_EMPTY = 'Enter the sender name replies go out from. LoopMessage cannot send a reply without one.'

/** How the platform a webhook is registered with is called in a sentence. */
const CHANNEL_REGISTRAR_NAMES: Partial<Record<AgentChannel['type'], string>> = {
  telegram: 'Telegram',
  whatsapp: 'Twilio',
  sms: 'Twilio',
  imessage_sendblue: 'Sendblue',
}

/**
 * What publishing last did about the platform's webhook, in plain words.
 * A failure is said here, next to the URL, with the platform's own reason.
 */
export function WebhookRegistrationLine({ registration, platform }: { registration: WebhookRegistration | null; platform: string }) {
  if (!registration || registration.action !== 'register') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="webhook-registration">
        Registering it with {platform}...
      </p>
    )
  }
  if (registration.status === 'registered') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="webhook-registration">
        Registered with {platform}.
      </p>
    )
  }
  const reason = registration.error?.trim() || 'no reason was given'
  return (
    <p className="flex gap-2 text-sm text-destructive" role="alert" data-testid="webhook-registration">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        {registration.status === 'skipped'
          ? `Not registered with ${platform} automatically: ${reason}. Add the URL above there yourself.`
          : `Could not register it with ${platform}: ${reason}. Fix the credential, then unpublish and publish again, or add the URL above there yourself.`}
      </span>
    </p>
  )
}

export interface ChannelSettingsProps {
  agent: Agent
  channel: AgentChannel
  /** What the channel inherits from the agent, to tell its own settings apart. */
  inherited: EffectiveSettings
}

/** What to do when a messaging channel has no keys yet, in plain words. */
export function missingKeysLine(type: AgentChannel['type']): string {
  if (type === 'slack') return 'Pick or create the Slack app credential first.'
  return `Pick or create the ${CHANNEL_LABELS[type] ?? type} credential first.`
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
 * chat's sign-in provider, domain and allowed sites, and where the widget
 * sits, are stored on the gateway it answers on and saved by the same Save.
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

  // What is stored, refreshed from each save's response so the form is
  // clean again without waiting for a refetch.
  const [stored, setStored] = useState<AgentChannel>(channel)
  const configuration = stored.configuration ?? {}
  const live = stored.status === 'live'

  // Keys: a credential on Credentials, picked or created here.
  const storedCredential: string | null = typeof configuration.credentialId === 'string' && configuration.credentialId ? configuration.credentialId : null
  const [credentialId, setCredentialId] = useState<string | null>(null)
  const [credentialTouched, setCredentialTouched] = useState(false)
  const { all: credentials } = useConnectionOptions({ kind: 'channel', enabled: messaging })

  const [name, setName] = useState(stored.name)
  const [nameError, setNameError] = useState<string | undefined>()
  const nameChanged = name.trim() !== stored.name

  // The web chat's address: generated from the agent's name, the owner's
  // to change.
  const storedSlug = stored.slug ?? ''
  const [slug, setSlug] = useState(storedSlug)
  const [slugError, setSlugError] = useState<string | undefined>()
  const slugChanged = type === 'web' && slug.trim().toLowerCase() !== storedSlug

  // The AI disclosure switch: on unless it was turned off.
  const disclosureCarried = carriesDisclosure(type)
  const storedDisclosure = configuration.aiDisclosure !== false
  const [disclosure, setDisclosure] = useState(storedDisclosure)
  const disclosureChanged = disclosureCarried && disclosure !== storedDisclosure

  const storedBundleId = (configuration.bundleId as string | undefined) ?? ''
  const [bundleId, setBundleId] = useState(storedBundleId)
  const [bundleError, setBundleError] = useState<string | undefined>()

  // LoopMessage's sender name belongs to the channel: one organization key
  // can carry several senders, and every reply names one.
  const senderNamed = type === 'imessage_loopmessage'
  const storedSenderName = typeof configuration.sender_name === 'string' ? configuration.sender_name : ''
  const [senderName, setSenderName] = useState(storedSenderName)
  const [senderNameError, setSenderNameError] = useState<string | undefined>()
  const senderNameChanged = senderNamed && senderName.trim() !== storedSenderName

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
    nameChanged ||
    slugChanged ||
    disclosureChanged ||
    (credentialTouched && credentialId !== storedCredential) ||
    (packaged && bundleId !== storedBundleId) ||
    capabilitiesChanged ||
    overridesChanged ||
    senderNameChanged
  const surface = useSurfaceSettings(stored)
  const pageDirty = dirty || surface.dirty
  const guard = useLeaveGuard(pageDirty)
  // Missing keys are said once someone tries to publish, not on first view.
  const [triedPublish, setTriedPublish] = useState(false)

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
    mutationFn: async (body: Parameters<typeof agentChannelsApi.update>[2]) => {
      const saved = Object.keys(body).length ? await agentChannelsApi.update(agent.id, channel.id, body) : null
      await surface.save()
      return saved
    },
    onSuccess: (saved) => {
      success('Saved', `${(saved ?? stored).name} is updated.`)
      if (!saved) return refresh()
      setCredentialTouched(false)
      setName(saved.name)
      setSlug(saved.slug ?? '')
      setSenderName(typeof saved.configuration?.sender_name === 'string' ? saved.configuration.sender_name : '')
      refresh(saved)
    },
    onError: (err: unknown, body) => {
      // The field it failed on says why.
      if (err instanceof SurfaceFieldError) return
      const message = getApiErrorMessage(err, 'Please try again.')
      // A taken name or address is said next to the field it is about.
      if (body.slug !== undefined && /address/i.test(message)) setSlugError(message)
      else if (body.name !== undefined && /name|called/i.test(message)) setNameError(message)
      else errorNotif('Could not save', message)
    },
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
      success('Deleted', `${stored.name} is no longer a channel of ${agent.name}.`)
      queryClient.invalidateQueries({ queryKey: channelKeys.list(agent.id) })
      guard.leave(back)
    },
    onError: (err: unknown) => errorNotif('Could not delete', getApiErrorMessage(err, 'Something went wrong.')),
  })

  const askRemove = async () => {
    const ok = await confirm({
      title: `Delete ${stored.name}?`,
      description: stored.gatewayId
        ? 'It stops answering, the gateway it answers on is deleted, and its settings go with it. Downloads already handed out keep working.'
        : 'Its settings go with it. Downloads already handed out keep working.',
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  const submit = () => {
    if (nameChanged && !name.trim()) {
      setNameError('Give the channel a name.')
      return
    }
    setNameError(undefined)
    if (slugChanged) {
      const error = webChatAddressError(slug)
      if (error) {
        setSlugError(error)
        return
      }
    }
    setSlugError(undefined)
    const trimmed = bundleId.trim()
    if (packaged && trimmed !== storedBundleId && !BUNDLE_ID_PATTERN.test(trimmed)) {
      setBundleError('Use a reverse-domain name you own, such as com.acme.assistant.')
      return
    }
    setBundleError(undefined)
    if (senderNameChanged && !senderName.trim()) {
      setSenderNameError(SENDER_NAME_EMPTY)
      return
    }
    setSenderNameError(undefined)
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
    if (disclosureChanged) patch.aiDisclosure = disclosure
    if (senderNameChanged) patch.sender_name = senderName.trim()
    const body: Parameters<typeof agentChannelsApi.update>[2] = {}
    if (nameChanged) body.name = name.trim()
    if (slugChanged) body.slug = slug.trim().toLowerCase()
    if (Object.keys(patch).length) body.configuration = patch
    if (credentialTouched && credentialId !== storedCredential) body.credentialId = credentialId
    if (overridesChanged) {
      body.branding = overrides.branding
      body.visitorRules = overrides.visitorRules
    }
    if (!surface.validate()) return
    if (Object.keys(body).length === 0 && !surface.dirty) return
    save.mutate(body)
  }

  const orgSlug =
    currentOrganization?.slug || currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') || 'org'
  const inbound = CHANNEL_INBOUND[type]
  const callbackUrl = channelCallbackUrl(getApiBaseUrl(), orgSlug, stored)
  const status = CHANNEL_STATUS[stored.status] ?? CHANNEL_STATUS.draft

  const usingCredential = credentialTouched ? credentialId : storedCredential
  const keysMissing = !live && (check?.refusals ?? []).some((r) => r.code === 'MISSING_CREDENTIALS')
  const missingKeys = triedPublish && keysMissing ? missingKeysLine(type) : undefined
  // LoopMessage's sender name: said next to its field once someone tries to
  // publish without one, or straight away on a live channel that lost it.
  const senderNameRefusal = senderNamed
    ? (check?.refusals ?? []).find((r) => r.code === 'SENDER_NAME_REQUIRED')?.message
    : undefined
  const senderNameShown = senderNameError ?? ((triedPublish || live) && !senderNameChanged ? senderNameRefusal : undefined)
  const tryPublish = () => {
    if (keysMissing || (!live && senderNameRefusal)) {
      setTriedPublish(true)
      errorNotif('Could not publish', keysMissing ? missingKeysLine(type) : senderNameRefusal)
      return
    }
    publish.mutate()
  }
  // Where publishing registers the webhook itself, what that last did. While
  // it is still under way (the registrar runs after publish answers), the
  // channel is read again every two seconds, a few times.
  const platformName = CHANNEL_REGISTRAR_NAMES[type] ?? label
  const registrationAwaited =
    inbound?.mode === 'auto' && live && (!stored.webhookRegistration || stored.webhookRegistration.action !== 'register')
  const { data: latest } = useQuery({
    queryKey: [...channelKeys.one(agent.id, channel.id), 'webhook-registration'],
    queryFn: () => agentChannelsApi.get(agent.id, channel.id),
    enabled: registrationAwaited,
    refetchInterval: (query) => {
      const last = query.state.data?.webhookRegistration
      const settled = last && last.action === 'register'
      return settled || query.state.dataUpdateCount >= 10 ? false : 2000
    },
  })
  const registration = (registrationAwaited ? latest?.webhookRegistration : undefined) ?? stored.webhookRegistration ?? null
  const disclosureRefusal = (check?.refusals ?? []).find((r) => r.code === 'DISCLOSURE_REMOVAL_NOT_ENTITLED')?.message
  const disclosureLine = stored.effective.branding.aiDisclosure?.trim() || DEFAULT_AI_DISCLOSURE

  /** The keys picker: only credentials of this service are offered. */
  const keysPicker = (id: string, label: string, connectorKey: string, hint?: string) => (
    <CredentialPicker
      id={id}
      label={label}
      kind="channel"
      connectorKey={connectorKey}
      connections={credentials.filter((c) => c.connectorKey === connectorKey)}
      value={usingCredential ?? ''}
      onChange={(picked) => {
        setCredentialTouched(true)
        setCredentialId(picked?.id ?? null)
        setTriedPublish(false)
      }}
      required
      hint={hint}
      error={missingKeys}
    />
  )

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
      {type === 'web' && (
        <Field
          id="channel-address"
          label="Address"
          hint={`People open it at ${webChatUrl(slug.trim().toLowerCase() || storedSlug)}. Unique across almyty, since it is a web address.`}
          error={slugError}
        >
          <Input
            id="channel-address"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugError(undefined)
            }}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>
      )}
      {type === 'web' && !slugChanged && <WebChatLink channel={stored} />}
      {notReady}
      <div>
        <Button type="button" variant="outline" disabled={publish.isPending || pageDirty} onClick={tryPublish}>
          {publish.isPending ? (live ? 'Unpublishing...' : 'Publishing...') : live ? 'Unpublish' : 'Publish'}
        </Button>
        {pageDirty && <p className="mt-1 text-xs text-muted-foreground">Save your changes first.</p>}
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
      title={stored.name}
      description={CHANNEL_DESCRIPTIONS[type]}
      back={{ to: back, label: agent.name }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Save"
      submitting={save.isPending}
      submitDisabled={!pageDirty || (own && retentionInvalid(overrideForm))}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{label}</Badge>
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
      <FormSection>
        <Field
          id="channel-name"
          label="Name"
          required
          hint={`Tells it apart from ${agent.name}'s other channels.`}
          error={nameError}
        >
          <Input
            id="channel-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameError(undefined)
            }}
            maxLength={120}
            autoComplete="off"
          />
        </Field>
      </FormSection>

      {(type === 'web' || type === 'widget' || type === 'a2a') && publishSection}

      {messaging && (
        <FormSection
          title={type === 'slack' ? 'Add to Slack' : 'Keys'}
          description={
            type === 'slack'
              ? 'Your own Slack app, from api.slack.com/apps. Once this is published, anyone you send the install link to can add it to their workspace.'
              : 'Your account on the platform, kept on Credentials with your other keys.'
          }
        >
          {type === 'slack'
            ? keysPicker('channel-credential', 'Slack app', SLACK_APP_CONNECTOR_KEY)
            : keysPicker('channel-credential', 'Credential', channelConnectorKey(type))}
          {senderNamed && (
            <Field
              id="channel-sender-name"
              label="Sender name"
              required
              hint="The sender name replies go out from, exactly as it is set up in your LoopMessage dashboard. LoopMessage needs one for every reply."
              error={senderNameShown}
            >
              <Input
                id="channel-sender-name"
                aria-required="true"
                value={senderName}
                onChange={(e) => {
                  setSenderName(e.target.value)
                  setSenderNameError(undefined)
                }}
                maxLength={100}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
          {type === 'slack' && (
            <Disclosure title="Advanced" summary="One workspace with a bot token instead">
              {keysPicker('channel-credential-bot', 'Bot token', channelConnectorKey('slack'), 'For a single workspace: a Slack bot token instead of the app.')}
            </Disclosure>
          )}
        </FormSection>
      )}

      {type === 'slack' && live && stored.gatewayId && <SlackInstall gatewayId={stored.gatewayId} />}

      {messaging && callbackUrl && inbound && (
        <FormSection title="Callback URL" description={inbound.where}>
          <CopyField id="channel-callback-url" value={callbackUrl} label="Callback URL" />
          {inbound.mode === 'auto' && live && <WebhookRegistrationLine registration={registration} platform={platformName} />}
        </FormSection>
      )}
      {messaging && !callbackUrl && inbound?.why && (
        <p className="text-sm text-muted-foreground" data-testid="no-callback-url">
          No callback URL needed: {inbound.why}
        </p>
      )}

      {disclosureCarried && (
        <FormSection title="AI disclosure" description="People are told they are talking to an AI. The EU AI Act (Art. 50) requires it.">
          <div className="flex items-center justify-between gap-4 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="channel-ai-disclosure">Tell people they are talking to an AI</Label>
              <p className="text-xs text-muted-foreground">
                {messaging ? 'Before the first reply of each conversation' : 'Under the message box'}: {disclosureLine}
              </p>
              {!stored.disclosureRemovable && (
                <p className="text-xs text-muted-foreground">Turning it off needs the white-label entitlement.</p>
              )}
              {disclosureRefusal && <p className="text-xs text-destructive">{disclosureRefusal}</p>}
            </div>
            <Switch
              id="channel-ai-disclosure"
              checked={disclosure}
              onCheckedChange={setDisclosure}
              disabled={disclosure && !stored.disclosureRemovable}
            />
          </div>
        </FormSection>
      )}

      {messaging && publishSection}

      {type === 'web' && <WebChatSettings channel={stored} surface={surface} />}
      {type === 'widget' && <WidgetChannelSettings channel={stored} surface={surface} />}
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
        </FormSection>
      )}
      {confirmDialog}
    </FormPage>
  )
}
