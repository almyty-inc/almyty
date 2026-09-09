/**
 * Registers a connector the catalog does not ship: an OpenAI-compatible
 * server, an MCP server, an S3-compatible registry. Every custom connector
 * gets one api_key method whose schema carries the base URL (prefilled) and
 * the key (secret, optional for keyless servers).
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { connectorsApi, errorMessage } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'
import { CONNECTOR_KIND_LABELS, type ConnectorKind, type ConnectorValidation, type CreateConnectorBody } from '@/types/connections'
import type { JsonSchemaObject } from '@/types/deployments'
import { CONNECTORS_QUERY_KEY } from './connect-sheet'

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * Kinds a custom connector can take. Each emits the schema its server-side
 * validation reads: an OpenAI-compatible server is probed at
 * `{{baseUrl}}/models`, an MCP server through `mcp_initialize` (serverUrl +
 * apiKey), an S3 bucket through `s3_bucket` (endpoint, region, bucket, keys).
 */
export const CUSTOM_CONNECTOR_KINDS: Array<{ kind: ConnectorKind; label: string; urlLabel: string; urlPlaceholder: string; urlField: string }> = [
  { kind: 'inference', label: 'OpenAI-compatible inference', urlLabel: 'Base URL', urlPlaceholder: 'https://models.example.com/v1', urlField: 'baseUrl' },
  { kind: 'mcp', label: 'MCP server', urlLabel: 'Server URL', urlPlaceholder: 'https://mcp.example.com/mcp', urlField: 'serverUrl' },
  { kind: 'registry', label: 'S3-compatible registry', urlLabel: 'Endpoint URL', urlPlaceholder: 'https://s3.eu-central-1.example.com', urlField: 'endpoint' },
  { kind: 'tool_source', label: 'Tool source', urlLabel: 'Base URL', urlPlaceholder: 'https://api.example.com', urlField: 'baseUrl' },
  { kind: 'memory', label: 'Memory backend', urlLabel: 'Base URL', urlPlaceholder: 'https://memory.example.com', urlField: 'baseUrl' },
]

export interface CustomConnectorForm {
  key: string
  kind: ConnectorKind
  displayName: string
  description: string
  baseUrl: string
  requiresKey: boolean
}

export const EMPTY_CUSTOM_CONNECTOR: CustomConnectorForm = {
  key: '',
  kind: 'inference',
  displayName: '',
  description: '',
  baseUrl: '',
  requiresKey: true,
}

export type CustomConnectorBuild = { ok: true; body: CreateConnectorBody } | { ok: false; errors: Record<string, string> }

/** Turn the form into POST /connectors, or the field errors that stop it. */
export function buildCustomConnectorBody(form: CustomConnectorForm): CustomConnectorBuild {
  const errors: Record<string, string> = {}
  const key = form.key.trim().toLowerCase()
  if (!key) errors.key = 'Key is required'
  else if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(key)) errors.key = 'Two to 64 lowercase letters, digits or dashes'
  if (!form.displayName.trim()) errors.displayName = 'Display name is required'
  const baseUrl = form.baseUrl.trim()
  if (!baseUrl) errors.baseUrl = 'URL is required'
  else if (!/^https?:\/\//i.test(baseUrl)) errors.baseUrl = 'Enter the URL including the protocol'
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const meta = CUSTOM_CONNECTOR_KINDS.find((k) => k.kind === form.kind) ?? CUSTOM_CONNECTOR_KINDS[0]
  const urlProp = { type: 'string' as const, title: meta.urlLabel, format: 'uri', default: baseUrl }
  const keyProp = { type: 'string' as const, title: form.kind === 'mcp' ? 'Bearer token' : 'API key', 'x-secret': true, ...(form.requiresKey ? {} : { description: 'Leave empty for keyless servers' }) }

  let schema: JsonSchemaObject
  let validation: ConnectorValidation
  let label: string
  if (form.kind === 'registry') {
    schema = {
      type: 'object',
      properties: {
        endpoint: urlProp,
        region: { type: 'string', title: 'Region', default: 'us-east-1' },
        bucket: { type: 'string', title: 'Bucket' },
        prefix: { type: 'string', title: 'Key prefix' },
        accessKeyId: { type: 'string', title: 'Access key id', 'x-secret': true },
        secretAccessKey: { type: 'string', title: 'Secret access key', 'x-secret': true },
      },
      required: ['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey'],
    }
    validation = { kind: 's3_bucket' }
    label = 'Bucket and access keys'
  } else if (form.kind === 'mcp') {
    schema = { type: 'object', properties: { serverUrl: urlProp, apiKey: keyProp }, required: form.requiresKey ? ['serverUrl', 'apiKey'] : ['serverUrl'] }
    validation = { kind: 'mcp_initialize' }
    label = 'Server URL and token'
  } else {
    schema = { type: 'object', properties: { baseUrl: urlProp, apiKey: keyProp }, required: form.requiresKey ? ['baseUrl', 'apiKey'] : ['baseUrl'] }
    validation = form.kind === 'inference'
      ? { kind: 'http', url: '{{baseUrl}}/models', auth: 'bearer' }
      : { kind: 'format', urlFields: ['baseUrl'], accountLabelFrom: 'baseUrl' }
    label = form.requiresKey ? 'URL and API key' : 'URL only'
  }

  const body: CreateConnectorBody = {
    key,
    kind: form.kind,
    displayName: form.displayName.trim(),
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    connect: [{ type: 'api_key', label, schema }],
    validation,
  }
  return { ok: true, body }
}
export interface CustomConnectorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (key: string) => void
}

export function CustomConnectorDialog({ open, onOpenChange, onCreated }: CustomConnectorDialogProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [form, setForm] = useState<CustomConnectorForm>(EMPTY_CUSTOM_CONNECTOR)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_CUSTOM_CONNECTOR)
      setErrors({})
    }
  }, [open])

  const create = useMutation({
    mutationFn: (body: CreateConnectorBody) => connectorsApi.create(body),
    onSuccess: (connector, body) => {
      queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY })
      notifications.success('Connector added', `${connector?.displayName ?? body.displayName} is in the gallery. Connect it to start using it.`)
      onOpenChange(false)
      onCreated?.(connector?.key ?? body.key)
    },
    onError: (error: unknown) => notifications.error('Could not add connector', errorMessage(error, 'The connector was not saved')),
  })

  const set = <K extends keyof CustomConnectorForm>(key: K, value: CustomConnectorForm[K]) => setForm((prev) => ({ ...prev, [key]: value }))

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const result = buildCustomConnectorBody(form)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    create.mutate(result.body)
  }

  const meta = CUSTOM_CONNECTOR_KINDS.find((k) => k.kind === form.kind) ?? CUSTOM_CONNECTOR_KINDS[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add custom connector</DialogTitle>
          <DialogDescription>Anything that speaks a known protocol: an OpenAI-compatible server, an MCP server, an S3 registry. Admins only.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="custom-connector-kind">Kind</Label>
            <select id="custom-connector-kind" className={SELECT_CLASS} value={form.kind} onChange={(e) => set('kind', e.target.value as ConnectorKind)}>
              {CUSTOM_CONNECTOR_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>{k.label} ({CONNECTOR_KIND_LABELS[k.kind]})</option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="custom-connector-name">Display name</Label>
              <Input id="custom-connector-name" value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="Office vLLM" aria-invalid={!!errors.displayName} />
              {errors.displayName && <p role="alert" className="text-xs text-destructive">{errors.displayName}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="custom-connector-key">Key</Label>
              <Input id="custom-connector-key" className="font-mono" value={form.key} onChange={(e) => set('key', e.target.value)} placeholder="office-vllm" aria-invalid={!!errors.key} />
              {errors.key && <p role="alert" className="text-xs text-destructive">{errors.key}</p>}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custom-connector-url">{meta.urlLabel}</Label>
            <Input id="custom-connector-url" className="font-mono" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={meta.urlPlaceholder} aria-invalid={!!errors.baseUrl} />
            {errors.baseUrl && <p role="alert" className="text-xs text-destructive">{errors.baseUrl}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="custom-connector-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="custom-connector-description" value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What it is and who runs it" />
          </div>
          <div className="flex items-center gap-2">
            <Checkbox id="custom-connector-requires-key" checked={form.requiresKey} onCheckedChange={(v) => set('requiresKey', v === true)} />
            <Label htmlFor="custom-connector-requires-key" className="font-normal">Requires an API key</Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>Cancel</Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Add connector
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
