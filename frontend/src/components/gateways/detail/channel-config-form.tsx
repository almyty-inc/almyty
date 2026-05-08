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

export type ChannelType =
  | 'slack'
  | 'discord'
  | 'telegram'
  | 'whatsapp'
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

interface FieldDef {
  key: string
  label: string
  placeholder?: string
  helper?: string
  secret?: boolean
  required?: boolean
}

const FIELD_SETS: Record<ChannelType, FieldDef[]> = {
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

export interface ChannelConfigFormProps {
  gateway: {
    id: string
    type: string
    configuration?: Record<string, any> | null
  }
  type: ChannelType
  onSave: (newConfig: Record<string, any>) => Promise<void> | void
  onTestConnection: () => Promise<{ ok: boolean; detail: string }>
  isSaving?: boolean
}

export function ChannelConfigForm({
  gateway,
  type,
  onSave,
  onTestConnection,
  isSaving = false,
}: ChannelConfigFormProps) {
  const fields = FIELD_SETS[type] || []
  const existing = (gateway.configuration ?? {}) as Record<string, any>

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
  const [testStatus, setTestStatus] = useState<
    | { state: 'idle' }
    | { state: 'pending' }
    | { state: 'ok'; detail: string }
    | { state: 'fail'; detail: string }
  >({ state: 'idle' })

  React.useEffect(() => {
    setEditing(initialEditing)
    setValues({})
    setReveal({})
    setTestStatus({ state: 'idle' })
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
  // hasn't clicked Edit on it.
  const isFieldComplete = (f: FieldDef) => {
    if (!f.required) return true
    if (editing[f.key]) {
      return (values[f.key] || '').trim().length > 0
    }
    return existing[f.key] != null && String(existing[f.key]).length > 0
  }

  const allRequiredFilled = fields.every(isFieldComplete)

  // Anything actually entered counts as a change.
  const hasUnsavedEdits = Object.entries(values).some(([, v]) => v !== '')

  const buildPatchPayload = () => {
    // Only patch keys the user actually typed into. Untouched fields
    // keep their existing encrypted value untouched on the backend.
    const next = { ...existing }
    for (const f of fields) {
      if (editing[f.key] && (values[f.key] !== undefined)) {
        const v = values[f.key]
        if (v === '') {
          // Empty string → user explicitly cleared the field. Drop it.
          delete next[f.key]
        } else {
          next[f.key] = v
        }
      }
    }
    return next
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
        {fields.map((f) => {
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
