/**
 * Registers a connector the catalog does not ship: an OpenAI-compatible
 * server, an MCP server, an S3-compatible registry. Every custom connector
 * gets one api_key method whose schema carries the base URL (prefilled) and
 * the key (secret, optional for keyless servers). A page at
 * /connections/custom/new.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { connectorsApi, errorMessage } from '@/lib/connections-api'
import { useNotifications } from '@/store/app'
import { CONNECTOR_KIND_LABELS, type ConnectorKind, type ConnectorValidation, type CreateConnectorBody } from '@/types/connections'
import type { JsonSchemaObject } from '@/types/deployments'
import { CONNECTORS_QUERY_KEY } from './connect-flow'
import { CONNECTIONS_ADVANCED_PATH, connectServicePath } from './paths'

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
  else if (!/^https?:\/\//i.test(baseUrl)) errors.baseUrl = 'Enter the URL including https://'
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
export interface CustomConnectorFormProps {
  /** After the connector is saved; defaults to its connect page. */
  onCreated?: (key: string) => void
}

/** /connections/custom/new */
export function CustomConnectorCreate({ onCreated }: CustomConnectorFormProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const [form, setForm] = useState<CustomConnectorForm>(EMPTY_CUSTOM_CONNECTOR)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const guard = useLeaveGuard(JSON.stringify(form) !== JSON.stringify(EMPTY_CUSTOM_CONNECTOR))

  const create = useMutation({
    mutationFn: (body: CreateConnectorBody) => connectorsApi.create(body),
    onSuccess: (connector, body) => {
      queryClient.invalidateQueries({ queryKey: CONNECTORS_QUERY_KEY })
      notifications.success('Service added', `${connector?.displayName ?? body.displayName} is on the list. Connect it to start using it.`)
      const key = connector?.key ?? body.key
      if (onCreated) onCreated(key)
      // Straight on to connecting it, as the gallery's own Connect would.
      else guard.leave(connectServicePath(key))
    },
    onError: (error: unknown) => notifications.error('Could not add the service', errorMessage(error, 'It was not saved.')),
  })

  const set = <K extends keyof CustomConnectorForm>(key: K, value: CustomConnectorForm[K]) => setForm((prev) => ({ ...prev, [key]: value }))

  const submit = () => {
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
    <FormPage
      title="Add a custom service"
      description="Anything with a known API format: an OpenAI-compatible server, an MCP server, an S3 bucket. Admins only."
      back={{ to: CONNECTIONS_ADVANCED_PATH, label: 'Advanced' }}
      guard={guard}
      onSubmit={submit}
      submitLabel="Add service"
      submitting={create.isPending}
      width="narrow"
    >
      <FormSection>
        <Field id="custom-connector-kind" label="Kind">
          <select className={SELECT_CLASS} value={form.kind} onChange={(e) => set('kind', e.target.value as ConnectorKind)}>
            {CUSTOM_CONNECTOR_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>{k.label} ({CONNECTOR_KIND_LABELS[k.kind]})</option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="custom-connector-name" label="Display name" required error={errors.displayName}>
            <Input value={form.displayName} onChange={(e) => set('displayName', e.target.value)} placeholder="Office vLLM" />
          </Field>
          <Field id="custom-connector-key" label="Key" required error={errors.key} hint="Lowercase letters, digits and dashes.">
            <Input className="font-mono" value={form.key} onChange={(e) => set('key', e.target.value)} placeholder="office-vllm" />
          </Field>
        </div>
        <Field id="custom-connector-url" label={meta.urlLabel} required error={errors.baseUrl}>
          <Input className="font-mono" value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder={meta.urlPlaceholder} />
        </Field>
        <Field id="custom-connector-description" label={<>Description <span className="font-normal text-muted-foreground">(optional)</span></>}>
          <Input value={form.description} onChange={(e) => set('description', e.target.value)} placeholder="What it is and who runs it" />
        </Field>
        <div className="flex items-center gap-2">
          <Checkbox id="custom-connector-requires-key" checked={form.requiresKey} onCheckedChange={(v) => set('requiresKey', v === true)} />
          <Label htmlFor="custom-connector-requires-key" className="font-normal">Requires an API key</Label>
        </div>
      </FormSection>
    </FormPage>
  )
}
