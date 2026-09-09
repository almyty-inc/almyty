/**
 * ChannelConfigForm — per-channel-type credential editor.
 *
 * Renders the right input fields for each of the 12 channel adapters
 * (slack, discord, telegram, whatsapp, microsoft_teams, google_chat,
 * signal, matrix, irc, email, webhook, chat_widget). The keys here are
 * derived from the actual adapter source files in
 * backend/src/modules/gateways/channels/adapters/ — `config.<key>`
 * lookups are the ground truth.
 *
 * Sensitive values (tokens / secrets / API keys) are NEVER echoed in
 * plaintext on initial render. If a value is already set on the
 * gateway, we show "••••••••" as a placeholder and the user must click
 * Edit to replace it; only the new value gets PATCHed. Save and Test
 * buttons are disabled until all required keys are filled in.
 */
import React, { useMemo, useState } from 'react'
import { Eye, EyeOff, AlertCircle, CheckCircle2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { ConnectionSelect, useConnectionOptions } from '@/components/connections/connection-select'
import { ConnectionHealthBadge } from '@/components/connections/health-badge'
import type { Connection } from '@/types/connections'

export type ChannelType =
  | 'slack'
  | 'discord'
  | 'telegram'
  | 'whatsapp'
  | 'whatsapp_cloud'
  | 'sms'
  | 'microsoft_teams'
  | 'google_chat'
  | 'signal'
  | 'matrix'
  | 'irc'
  | 'email'
  | 'webhook'
  | 'chat_widget'

export const CHANNEL_TYPES: ChannelType[] = [
  'slack',
  'discord',
  'telegram',
  'whatsapp',
  'whatsapp_cloud',
  'sms',
  'microsoft_teams',
  'google_chat',
  'signal',
  'matrix',
  'irc',
  'email',
  'webhook',
  'chat_widget',
]

export function isChannelType(t: string | undefined | null): t is ChannelType {
  return !!t && (CHANNEL_TYPES as string[]).includes(t)
}

export interface ChannelFieldDef {
  key: string
  label: string
  placeholder?: string
  helper?: string
  secret?: boolean
  required?: boolean
}

type FieldDef = ChannelFieldDef

/**
 * The credential fields each channel adapter reads, shared with the
 * agent-side deploy dialog so both surfaces ask for the same keys.
 */
export const CHANNEL_FIELD_SETS: Record<ChannelType, ChannelFieldDef[]> = {
  slack: [
    { key: 'bot_token', label: 'Bot token', placeholder: 'xoxb-...', secret: true, required: true },
    { key: 'signing_secret', label: 'Signing secret', placeholder: 'Slack app signing secret', secret: true, required: false, helper: 'Used to verify inbound webhook signatures.' },
  ],
  discord: [
    { key: 'bot_token', label: 'Bot token', placeholder: 'Discord bot token', secret: true, required: true },
  ],
  telegram: [
    { key: 'bot_token', label: 'Bot token', placeholder: '123456:ABC-DEF...', secret: true, required: true },
  ],
  whatsapp: [
    { key: 'twilio_account_sid', label: 'Twilio Account SID', placeholder: 'ACxxxxxxxx', required: true },
    { key: 'twilio_auth_token', label: 'Twilio auth token', secret: true, required: true },
    { key: 'phone_number', label: 'From phone number', placeholder: 'whatsapp:+15551234567', required: true },
    { key: 'webhook_url', label: 'Inbound webhook URL', placeholder: 'https://api.example.com/acme/support-bot', required: false, helper: 'The exact URL Twilio calls. Twilio signs the full URL, so inbound signature checks stay off until this is set. Filled in automatically when the webhook is registered for you.' },
  ],
  whatsapp_cloud: [
    { key: 'access_token', label: 'Access token', placeholder: 'Meta system-user token', secret: true, required: true },
    { key: 'phone_number_id', label: 'Phone number ID', placeholder: 'Cloud API phone number ID, not the E.164', required: true },
    { key: 'verify_token', label: 'Verify token', placeholder: 'Any string, echoed during Meta webhook setup', secret: true, required: true },
    { key: 'app_secret', label: 'App secret', secret: true, required: false, helper: 'Verifies the X-Hub-Signature-256 header on inbound messages. Inbound is unverified while this is empty.' },
  ],
  sms: [
    { key: 'twilio_account_sid', label: 'Twilio Account SID', placeholder: 'ACxxxxxxxx', required: true },
    { key: 'twilio_auth_token', label: 'Twilio auth token', secret: true, required: true },
    { key: 'phone_number', label: 'From phone number', placeholder: '+15551234567', required: true },
    { key: 'webhook_url', label: 'Inbound webhook URL', placeholder: 'https://api.example.com/acme/support-bot', required: false, helper: 'The exact URL Twilio calls. Twilio signs the full URL, so inbound signature checks stay off until this is set. Filled in automatically when the webhook is registered for you.' },
  ],
  microsoft_teams: [
    { key: 'bot_id', label: 'Bot ID', placeholder: 'Azure AD app (client) ID', required: true },
    { key: 'bot_password', label: 'Bot password', placeholder: 'Client secret', secret: true, required: true },
    { key: 'service_url', label: 'Service URL (optional)', placeholder: 'Used as fallback if not provided in payload', required: false },
  ],
  google_chat: [
    { key: 'webhook_url', label: 'Incoming webhook URL', placeholder: 'https://chat.googleapis.com/...', required: true },
    { key: 'verification_token', label: 'Verification token (optional)', placeholder: 'Bot framework verification token', secret: true, required: false },
  ],
  signal: [
    { key: 'api_url', label: 'signal-cli REST API URL', placeholder: 'http://signal-cli:8080', required: true },
    { key: 'phone_number', label: 'Registered phone number', placeholder: '+15551234567', required: true },
  ],
  matrix: [
    { key: 'homeserver_url', label: 'Homeserver URL', placeholder: 'https://matrix.org', required: true },
    { key: 'access_token', label: 'Access token', secret: true, required: true },
    { key: 'room_id', label: 'Default room ID (optional)', placeholder: '!roomid:matrix.org', required: false },
  ],
  irc: [
    { key: 'webhook_url', label: 'IRC bridge webhook URL', placeholder: 'https://irc-bridge/...', required: true },
    { key: 'nick', label: 'Bot nick', placeholder: 'almyty-bot', required: true },
    { key: 'channel', label: 'Default channel', placeholder: '#general', required: true },
  ],
  email: [
    { key: 'resend_api_key', label: 'Resend API key', placeholder: 're_...', secret: true, required: true },
    { key: 'reply_from', label: 'Reply-from address', placeholder: 'agent@yourdomain.com', required: true },
  ],
  webhook: [
    { key: 'callback_url', label: 'Callback URL', placeholder: 'https://your-server/almyty', required: true },
    { key: 'secret', label: 'HMAC secret (optional)', helper: 'When set, outbound payloads are signed with HMAC-SHA256.', secret: true, required: false },
  ],
  chat_widget: [],
}

const FIELD_SETS = CHANNEL_FIELD_SETS

export interface ChannelConfigFormProps {
  gateway: {
    id: string
    type: string
    /**
     * The stored configuration as the API shows it: secret keys masked,
     * plus `credentialId` (the connection backing the channel) and
     * `credentialKeys` (which secret keys that connection holds).
     */
    configuration?: Record<string, any> | null
  }
  type: ChannelType
  onSave: (newConfig: Record<string, any>) => Promise<void> | void
  onTestConnection: () => Promise<{ ok: boolean; detail: string }>
  isSaving?: boolean
  /** The org's connections, when the caller already holds them (skips the fetch). */
  connections?: Connection[]
}

/**
 * The connector key the backend gives a channel's managed connection:
 * `channel-<type>` with the gateway type's underscores dasherized, the
 * same rule as channelKey() in the backend connector catalog (connector
 * keys are [a-z0-9-]).
 */
export function channelConnectorKey(type: string): string {
  return `channel-${type.replace(/_/g, '-')}`
}

/**
 * The PATCH payload for a channel configuration. Pure so the rules are
 * testable without the form:
 *  - `edits`: keys the user typed ('' removes the key)
 *  - a picked `connection` replaces every secret key (typed, masked or
 *    held by the previous connection) with `credentialId`
 *  - `clearConnection` sends `credentialId: null`
 * `credentialKeys` is server-owned and never round-tripped.
 */
export function buildChannelConfigPatch(input: {
  existing: Record<string, any>
  fields: Array<{ key: string; secret?: boolean }>
  edits: Record<string, string | undefined>
  connection?: Connection | null
  clearConnection?: boolean
}): Record<string, any> {
  const next: Record<string, any> = { ...input.existing }
  delete next.credentialKeys
  for (const f of input.fields) {
    if (input.connection && f.secret) continue
    const v = input.edits[f.key]
    if (v === undefined) continue
    if (v === '') delete next[f.key]
    else next[f.key] = v
  }
  if (input.connection) {
    for (const f of input.fields) if (f.secret) delete next[f.key]
    for (const key of (input.existing.credentialKeys as string[] | undefined) ?? []) delete next[key]
    next.credentialId = input.connection.id
  } else if (input.clearConnection) {
    next.credentialId = null
  }
  return next
}

export function ChannelConfigForm({
  gateway,
  type,
  onSave,
  onTestConnection,
  isSaving = false,
  connections,
}: ChannelConfigFormProps) {
  const fields = FIELD_SETS[type] || []
  const existing = (gateway.configuration ?? {}) as Record<string, any>
  const backingId: string | null = typeof existing.credentialId === 'string' && existing.credentialId ? existing.credentialId : null

  // For each field, track whether the user has chosen to edit it. If a
  // value already exists, we keep editing=false until the user clicks
  // Edit, and only send the new value (or an unchanged one) on Save.
  const initialEditing = useMemo(() => {
    const m: Record<string, boolean> = {}
    for (const f of fields) {
      const has = existing[f.key] != null && existing[f.key] !== ''
      m[f.key] = !has
    }
    return m
  }, [type, gateway.id])

  const [editing, setEditing] = useState<Record<string, boolean>>(initialEditing)
  const [values, setValues] = useState<Record<string, string>>({})
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  // A connected account (Connections layer) stands in for the pasted tokens.
  const [connection, setConnection] = useState<Connection | null>(null)
  // The user asked to drop the connection backing the channel today.
  const [clearConnection, setClearConnection] = useState(false)
  const [testStatus, setTestStatus] = useState<
    | { state: 'idle' }
    | { state: 'pending' }
    | { state: 'ok'; detail: string }
    | { state: 'fail'; detail: string }
  >({ state: 'idle' })

  // Channel connections, the adapter's own connector first. Also names the
  // connection backing the channel today.
  const options = useConnectionOptions({ kind: 'channel', preferConnectorKey: channelConnectorKey(type), connections, enabled: type !== 'chat_widget' })
  const backing = backingId ? options.all.find((c) => c.id === backingId) ?? null : null

  React.useEffect(() => {
    setEditing(initialEditing)
    setValues({})
    setReveal({})
    setTestStatus({ state: 'idle' })
    setConnection(null)
    setClearConnection(false)
  }, [type, gateway.id, initialEditing])

  if (type === 'chat_widget') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Channel configuration</CardTitle>
          <CardDescription>
            The chat widget needs no extra credentials; it serves on this gateway's public endpoint.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  // A field is "complete" if either the user has typed a non-empty
  // value, or there's an existing value on the gateway and the user
  // hasn't clicked Edit on it. A picked connection completes every
  // secret field.
  const isFieldComplete = (f: FieldDef) => {
    if (!f.required) return true
    if (connection && f.secret) return true
    if (editing[f.key]) {
      return (values[f.key] || '').trim().length > 0
    }
    return existing[f.key] != null && String(existing[f.key]).length > 0
  }

  const allRequiredFilled = fields.every(isFieldComplete)

  // Anything actually entered counts as a change.
  const hasUnsavedEdits = Object.entries(values).some(([, v]) => v !== '') || !!connection || clearConnection

  const buildPatchPayload = () => {
    // Only patch keys the user actually typed into. Untouched fields
    // keep their existing encrypted value untouched on the backend.
    const edits: Record<string, string | undefined> = {}
    for (const f of fields) {
      if (editing[f.key] && values[f.key] !== undefined) edits[f.key] = values[f.key]
    }
    return buildChannelConfigPatch({ existing, fields, edits, connection, clearConnection })
  }

  const handleSave = async () => {
    if (!allRequiredFilled || isSaving) return
    await onSave(buildPatchPayload())
    // Reset edit state so newly-saved secrets become masked again.
    const m: Record<string, boolean> = {}
    for (const f of fields) m[f.key] = false
    setEditing(m)
    setValues({})
    setReveal({})
    setConnection(null)
    setClearConnection(false)
  }

  const handleTest = async () => {
    if (!allRequiredFilled) return
    setTestStatus({ state: 'pending' })
    try {
      const res = await onTestConnection()
      setTestStatus({ state: res.ok ? 'ok' : 'fail', detail: res.detail })
    } catch (err: any) {
      setTestStatus({ state: 'fail', detail: err?.message || 'Test failed' })
    }
  }

  const pickConnection = (next: Connection | null) => {
    setConnection(next)
    if (next) setClearConnection(false)
  }

  const secretFields = fields.filter((f) => f.secret)
  const visibleFields = connection ? fields.filter((f) => !f.secret) : fields

  return (
    <Card>
      <CardHeader>
        <CardTitle>Channel configuration</CardTitle>
        <CardDescription>
          Credentials for the {type.replace('_', ' ')} channel adapter. Saved values are
          encrypted at rest and never echoed back to the browser in plaintext.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2" data-testid="channel-connection">
          {backingId && !clearConnection && !connection && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm" data-testid="channel-backing-connection">
              <span className="text-muted-foreground">Backed by</span>
              <span className="font-medium">{backing?.name ?? 'a connection'}</span>
              {backing && <ConnectionHealthBadge health={backing.health} />}
              <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setClearConnection(true)}>
                Disconnect
              </Button>
            </div>
          )}
          {clearConnection && (
            <p className="text-xs text-muted-foreground" data-testid="channel-connection-cleared">
              The connection is removed on save; paste the tokens below or pick another connection.
              <Button type="button" variant="link" size="sm" className="h-auto px-1" onClick={() => setClearConnection(false)}>Undo</Button>
            </p>
          )}
          {connection ? (
            <ConnectedChip connection={connection} onClear={() => pickConnection(null)} />
          ) : (
            <>
              <ConnectionSelect
                id={`cfg-connection-${type}`}
                kind="channel"
                preferConnectorKey={channelConnectorKey(type)}
                value=""
                onChange={pickConnection}
                connections={connections}
              />
              <ConnectAccountButton kind="channel" onConnected={pickConnection} />
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {connection
              ? `The connection supplies ${secretFields.map((f) => f.label.toLowerCase()).join(', ') || 'the secrets'}; nothing is pasted here.`
              : `Connect the ${type.replace('_', ' ')} account once and skip pasting tokens below.`}
          </p>
        </div>
        {visibleFields.map((f) => {
          const isEditing = !!editing[f.key]
          const hasExisting = existing[f.key] != null && existing[f.key] !== ''
          const showAsText = f.secret ? !!reveal[f.key] : true
          return (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={`cfg-${f.key}`}>
                {f.label}
                {f.required && <span className="text-red-500 ml-1">*</span>}
              </Label>

              {!isEditing && hasExisting ? (
                <div className="flex items-center gap-2">
                  <Input
                    id={`cfg-${f.key}`}
                    value="••••••••"
                    readOnly
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditing((e) => ({ ...e, [f.key]: true }))}
                  >
                    Edit
                  </Button>
                </div>
              ) : (
                <div className="relative">
                  <Input
                    id={`cfg-${f.key}`}
                    type={f.secret && !showAsText ? 'password' : 'text'}
                    value={values[f.key] ?? ''}
                    placeholder={f.placeholder}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                    className={f.secret ? 'pr-10' : ''}
                  />
                  {f.secret && (
                    <button
                      type="button"
                      aria-label={reveal[f.key] ? 'Hide value' : 'Show value'}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center"
                      onClick={() =>
                        setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))
                      }
                    >
                      {reveal[f.key] ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                    </button>
                  )}
                </div>
              )}

              {f.helper && (
                <p className="text-xs text-muted-foreground">{f.helper}</p>
              )}
            </div>
          )
        })}

        {testStatus.state === 'ok' && (
          <div className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900/40 dark:bg-green-950/20">
            <CheckCircle2 className="h-4 w-4 text-green-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-green-900 dark:text-green-300">Connection OK</p>
              <p className="text-green-700 dark:text-green-400">{testStatus.detail}</p>
            </div>
          </div>
        )}
        {testStatus.state === 'fail' && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900/40 dark:bg-red-950/20">
            <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
            <div>
              <p className="font-medium text-red-900 dark:text-red-300">Connection failed</p>
              <p className="text-red-700 dark:text-red-400">{testStatus.detail}</p>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={!allRequiredFilled || isSaving || !hasUnsavedEdits}
          >
            {isSaving ? 'Saving…' : 'Save'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleTest}
            disabled={!allRequiredFilled || testStatus.state === 'pending'}
          >
            {testStatus.state === 'pending' ? (
              <>
                <LoadingSpinner size="sm" />
                <span className="ml-2">Testing…</span>
              </>
            ) : (
              'Test connection'
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
