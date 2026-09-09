/**
 * The credential half of the agent-side channel deploy dialog, shared by
 * every channel it can deploy instead of repeated per channel.
 *
 * Same three-way choice as the gateway-side ChannelConfigForm: pick an
 * existing channel connection, connect a new account, or paste the
 * values. A picked connection supplies every secret key, so the deploy
 * body carries `credentialId` and no secret at all; the non-secret keys
 * (phone number, room id, reply-from address and the like) stay in the
 * form either way.
 *
 * The field list is CHANNEL_FIELD_SETS from the gateway form, so both
 * surfaces ask for exactly the keys the adapters read.
 */
import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ConnectAccountButton } from '@/components/connections/connect-sheet'
import { ConnectedChip } from '@/components/connections/connected-chip'
import { ConnectionSelect, useConnectionOptions } from '@/components/connections/connection-select'
import { ConnectionHealthBadge } from '@/components/connections/health-badge'
import {
  CHANNEL_FIELD_SETS,
  buildChannelConfigPatch,
  channelConnectorKey,
  isChannelType,
  type ChannelFieldDef,
} from '@/components/gateways/detail/channel-config-form'
import type { Connection } from '@/types/connections'

export { channelConnectorKey }

/**
 * Keys the gateway form shows that the deploy dialog cannot: the inbound
 * webhook URL only exists once the gateway has an endpoint, and it is
 * filled in by the registrar right after the deploy.
 */
const DEPLOY_HIDDEN_KEYS: Record<string, string[]> = {
  whatsapp: ['webhook_url'],
  sms: ['webhook_url'],
}

/** Every credential field of a channel type, deploy-time or not. */
export function channelFields(type: string): ChannelFieldDef[] {
  return isChannelType(type) ? CHANNEL_FIELD_SETS[type] ?? [] : []
}

/** The fields the deploy dialog asks for. */
export function channelDeployFields(type: string): ChannelFieldDef[] {
  const hidden = DEPLOY_HIDDEN_KEYS[type] ?? []
  return channelFields(type).filter((f) => !hidden.includes(f.key))
}

/**
 * The configuration POSTed with a new agent gateway. Pure so the rule is
 * testable without the dialog: a picked connection replaces every secret
 * key with `credentialId`, and without one the typed values go as they
 * always did.
 */
export function buildDeployChannelConfig(input: {
  type: string
  config: Record<string, any>
  connection?: Connection | null
}): Record<string, any> {
  const next: Record<string, any> = { ...input.config }
  delete next.credentialId
  delete next.credentialKeys
  if (!input.connection) return next
  for (const f of channelFields(input.type)) if (f.secret) delete next[f.key]
  next.credentialId = input.connection.id
  return next
}

/**
 * The PATCH body that points a deployed channel at another connection,
 * or drops the one backing it. Delegates to the gateway form's rule so
 * both surfaces clear the same keys.
 */
export function buildChannelConnectionPatch(input: {
  type: string
  configuration: Record<string, any> | null | undefined
  connection?: Connection | null
}): Record<string, any> {
  return buildChannelConfigPatch({
    existing: (input.configuration ?? {}) as Record<string, any>,
    fields: channelFields(input.type),
    edits: {},
    connection: input.connection ?? null,
    clearConnection: !input.connection,
  })
}

/** The connection id backing a deployed channel, when there is one. */
export function backingConnectionId(configuration: Record<string, any> | null | undefined): string | null {
  const id = configuration?.credentialId
  return typeof id === 'string' && id ? id : null
}

function channelLabel(type: string): string {
  return type.replace(/_/g, ' ')
}

export interface ChannelCredentialsSectionProps {
  type: string
  config: Record<string, any>
  onConfigChange: (next: Record<string, any>) => void
  /** The connection the operator picked for this deploy, if any. */
  connection: Connection | null
  onConnectionChange: (connection: Connection | null) => void
  /** Skip the fetch and list these instead (tests, callers holding the list). */
  connections?: Connection[]
}

export function ChannelCredentialsSection({
  type,
  config,
  onConfigChange,
  connection,
  onConnectionChange,
  connections,
}: ChannelCredentialsSectionProps) {
  const [reveal, setReveal] = useState<Record<string, boolean>>({})
  const fields = channelDeployFields(type)
  if (fields.length === 0) return null

  const secretFields = fields.filter((f) => f.secret)
  const visibleFields = connection ? fields.filter((f) => !f.secret) : fields
  const label = channelLabel(type)

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`channel-credentials-${type}`}>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label} settings</p>

      {secretFields.length > 0 && (
        <div className="space-y-2" data-testid="deploy-channel-connection">
          {connection ? (
            <ConnectedChip connection={connection} onClear={() => onConnectionChange(null)} />
          ) : (
            <>
              <ConnectionSelect
                id={`deploy-connection-${type}`}
                kind="channel"
                preferConnectorKey={channelConnectorKey(type)}
                value=""
                onChange={onConnectionChange}
                connections={connections}
              />
              <ConnectAccountButton
                kind="channel"
                connectorKey={channelConnectorKey(type)}
                onConnected={onConnectionChange}
              />
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {connection
              ? `The connection supplies ${secretFields.map((f) => f.label.toLowerCase()).join(', ')}; nothing is pasted here.`
              : `Connect the ${label} account once and skip pasting tokens below.`}
          </p>
        </div>
      )}

      {visibleFields.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={`cfg-${type}-${f.key}`}>
            {f.label}
            {f.required && <span className="text-red-500 ml-1">*</span>}
          </Label>
          <div className="relative">
            <Input
              id={`cfg-${type}-${f.key}`}
              type={f.secret && !reveal[f.key] ? 'password' : 'text'}
              placeholder={f.placeholder}
              value={config[f.key] ?? ''}
              onChange={(e) => onConfigChange({ ...config, [f.key]: e.target.value })}
              className={f.secret ? 'pr-10' : ''}
            />
            {f.secret && (
              <button
                type="button"
                aria-label={reveal[f.key] ? 'Hide value' : 'Show value'}
                className="absolute inset-y-0 right-0 pr-3 flex items-center"
                onClick={() => setReveal((r) => ({ ...r, [f.key]: !r[f.key] }))}
              >
                {reveal[f.key] ? (
                  <EyeOff className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <Eye className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            )}
          </div>
          {f.helper && <p className="text-xs text-muted-foreground">{f.helper}</p>}
        </div>
      ))}
    </div>
  )
}

export interface ChannelBackingConnectionProps {
  type: string
  configuration: Record<string, any> | null | undefined
  onSwap: (connection: Connection) => void
  onDisconnect: () => void
  isSaving?: boolean
  connections?: Connection[]
}

/**
 * What a deployed channel shows in place of a masked token when a
 * connection backs it: the account, its connector and its health, with a
 * way to swap the connection or drop it.
 */
export function ChannelBackingConnection({
  type,
  configuration,
  onSwap,
  onDisconnect,
  isSaving = false,
  connections,
}: ChannelBackingConnectionProps) {
  const [swapping, setSwapping] = useState(false)
  const id = backingConnectionId(configuration)
  const options = useConnectionOptions({ kind: 'channel', preferConnectorKey: channelConnectorKey(type), connections })
  const backing = id ? options.all.find((c) => c.id === id) ?? null : null
  if (!id) return null

  return (
    <div className="mb-3 space-y-2 rounded border bg-muted/30 p-2" data-testid="channel-backing-connection">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Backed by</span>
        <span className="font-medium truncate max-w-[45%]">{backing?.name ?? 'a connection'}</span>
        <span className="text-muted-foreground truncate">
          {backing?.connectorDisplayName ?? backing?.connectorKey ?? channelConnectorKey(type)}
        </span>
        <ConnectionHealthBadge health={backing?.health} />
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={isSaving}
          onClick={() => setSwapping((s) => !s)}
        >
          {swapping ? 'Cancel' : 'Swap'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={isSaving}
          onClick={onDisconnect}
        >
          Disconnect
        </Button>
      </div>
      {swapping && (
        <ConnectionSelect
          id={`swap-connection-${id}`}
          label="Use another connection"
          kind="channel"
          preferConnectorKey={channelConnectorKey(type)}
          value=""
          onChange={(next) => {
            if (!next) return
            setSwapping(false)
            onSwap(next)
          }}
          connections={connections}
        />
      )}
    </div>
  )
}
