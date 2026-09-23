import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { agentsApi, gatewaysApi, getApiBaseUrl } from '@/lib/api'
import { captureEvent } from '@/lib/analytics'
import { getApiErrorMessage } from '@/lib/api-error'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'
import { useOrganizationStore } from '@/store/organization'
import type { Agent } from '@/types'

import { createGatewaySchema, type CreateGatewayForm as CreateGatewayValues } from './schema'

export const TOOL_GATEWAY_TYPES = [
  { value: 'mcp', label: 'MCP - Model Context Protocol' },
  { value: 'utcp', label: 'UTCP - Universal Tool Call Protocol' },
  { value: 'skills', label: 'Skills - Agent Skills (SKILL.md)' },
]

export const AGENT_GATEWAY_TYPES = [
  { value: 'a2a', label: 'A2A - Agent-to-Agent Protocol' },
  { value: 'acp', label: 'ACP - Agent Communication Protocol' },
  { value: 'openai_chat', label: 'OpenAI Chat - Chat Completions API' },
  { value: 'slack', label: 'Slack' },
  { value: 'discord', label: 'Discord' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'google_chat', label: 'Google Chat' },
  { value: 'microsoft_teams', label: 'Microsoft Teams' },
  { value: 'signal', label: 'Signal' },
  { value: 'matrix', label: 'Matrix' },
  { value: 'irc', label: 'IRC' },
  { value: 'chat_widget', label: 'Chat widget' },
]

/** The configuration a new gateway of each protocol starts with. */
function defaultConfiguration(type: string): Record<string, any> {
  switch (type) {
    case 'mcp':
      return { transport: 'http' }
    case 'a2a':
    case 'acp':
      return { agentCapabilities: {} }
    case 'utcp':
      return { protocol: 'http' }
    case 'skills':
      return { format: 'skill-md' }
    default:
      return {}
  }
}

const slugOf = (name: string) =>
  name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

type Values = CreateGatewayValues & { agentId?: string }

/**
 * Protocol surfaces a caller reaches with an almyty identity (an API key,
 * an OAuth token). Only these can be private: a chat channel is reached
 * by people who never sign in to almyty, so the server refuses a private
 * one. Mirrors PRIVATE_CAPABLE_GATEWAY_TYPES on the backend.
 */
export const PRIVATE_CAPABLE_GATEWAY_TYPES = new Set(['mcp', 'utcp', 'skills', 'a2a', 'acp', 'openai_chat'])

/**
 * Creating a gateway: what it serves (tools or an agent), over which
 * protocol, and at which path.
 *
 * The backend mints a first API key with every non-Skills gateway and
 * returns it once. It used to be dropped on the floor when the dialog
 * closed; it now travels to the new gateway's page, which shows it once.
 */
export function CreateGatewayForm() {
  const { currentOrganization } = useOrganizationStore()
  const { success, error: errorNotif } = useNotifications()
  const queryClient = useQueryClient()

  const [kind, setKind] = useState<'tool' | 'agent'>('tool')
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const [agentError, setAgentError] = useState<string | undefined>()
  // The path follows the name until someone types into it.
  const [endpointTouched, setEndpointTouched] = useState(false)

  const form = useForm<Values>({
    resolver: zodResolver(createGatewaySchema),
    defaultValues: { name: '', type: '', endpoint: '', description: '' },
  })
  const { errors, isDirty } = form.formState
  const guard = useLeaveGuard(isDirty)

  const { data: agentsData } = useQuery({
    queryKey: ['agents', currentOrganization?.id],
    queryFn: async () => {
      const d = await agentsApi.getAll()
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization && kind === 'agent',
  })
  const agents: Agent[] = Array.isArray(agentsData) ? agentsData : []
  const typeOptions = kind === 'tool' ? TOOL_GATEWAY_TYPES : AGENT_GATEWAY_TYPES

  const create = useMutation({
    mutationFn: (payload: Record<string, any>) => gatewaysApi.create(payload),
    onSuccess: async (gateway: any) => {
      captureEvent('gateway_deployed')
      success('Gateway created', 'It is now serving on its protocol endpoint.')
      await queryClient.invalidateQueries({ queryKey: ['gateways'] })
      guard.leave(gateway?.id ? `/gateways/${gateway.id}` : '/gateways', {
        state: gateway?.initialApiKey ? { initialApiKey: gateway.initialApiKey } : undefined,
      })
    },
    onError: (err: unknown) =>
      errorNotif('Could not create the gateway', getApiErrorMessage(err, 'Please try again.')),
  })

  const selectedType: string = form.watch('type') || ''
  const privateNotPossible =
    visibility.visibility === 'private' && !!selectedType && !PRIVATE_CAPABLE_GATEWAY_TYPES.has(selectedType)

  const onValid = (data: Values) => {
    if (privateNotPossible) return
    if (kind === 'agent' && !data.agentId) {
      setAgentError('Choose the agent that answers on this gateway.')
      return
    }
    setAgentError(undefined)
    const endpoint = data.endpoint.startsWith('/') ? data.endpoint : `/${data.endpoint}`
    create.mutate({
      name: data.name,
      type: data.type,
      endpoint,
      description: data.description,
      configuration: defaultConfiguration(data.type),
      kind,
      ...(kind === 'agent' ? { agentId: data.agentId } : {}),
      visibility: visibility.visibility,
      teamId: visibility.teamId,
    })
  }

  const orgSlug =
    currentOrganization?.slug ||
    currentOrganization?.name?.toLowerCase().replace(/\s+/g, '-') ||
    'org'
  const endpoint = form.watch('endpoint') || '/my-gateway'

  const chooseKind = (next: 'tool' | 'agent') => {
    setKind(next)
    form.setValue('type', '', { shouldDirty: true })
    if (next === 'tool') form.setValue('agentId', undefined)
    setAgentError(undefined)
  }

  return (
    <FormPage
      title="Create gateway"
      description="Serve your tools or an agent over MCP, UTCP, Agent Skills, A2A and more, at one endpoint."
      back={{ to: '/gateways', label: 'Gateways' }}
      guard={guard}
      submitLabel="Create gateway"
      submitting={create.isPending}
      submitDisabled={privateNotPossible}
      onSubmit={form.handleSubmit(onValid, () => {
        if (kind === 'agent' && !form.getValues('agentId')) {
          setAgentError('Choose the agent that answers on this gateway.')
        }
      })}
    >
      <FormSection title="What it serves">
        <div role="radiogroup" aria-label="Gateway kind" className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(
            [
              ['tool', 'Tools', 'Expose tools via MCP, UTCP, or Agent Skills'],
              ['agent', 'Agent', 'Serve an agent via A2A, OpenAI Chat, Slack, and more'],
            ] as const
          ).map(([value, title, blurb]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                kind === value
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'hover:border-muted-foreground/30',
              )}
              onClick={() => chooseKind(value)}
            >
              <div className="text-sm font-medium">{title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{blurb}</div>
            </button>
          ))}
        </div>

        <Field id="gateway-type" label="Protocol" required error={errors.type?.message}>
          <Select
            value={form.watch('type')}
            onValueChange={(value) =>
              form.setValue('type', value, { shouldDirty: true, shouldValidate: true })
            }
          >
            <SelectTrigger id="gateway-type" aria-invalid={errors.type ? true : undefined}>
              <SelectValue placeholder="Choose a protocol" />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {kind === 'agent' && (
          <Field
            id="gateway-agent"
            label="Agent"
            required
            hint="The agent that answers requests on this gateway."
            error={agentError}
          >
            <Select
              value={form.watch('agentId') || ''}
              onValueChange={(value) => {
                form.setValue('agentId', value, { shouldDirty: true })
                setAgentError(undefined)
              }}
            >
              <SelectTrigger id="gateway-agent" aria-invalid={agentError ? true : undefined}>
                <SelectValue placeholder="Choose an agent" />
              </SelectTrigger>
              <SelectContent>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
                {agents.length === 0 && (
                  <SelectItem value="__none" disabled>
                    No agents available
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </Field>
        )}
      </FormSection>

      <FormSection title="Details">
        <Field id="gateway-name" label="Name" required error={errors.name?.message}>
          <Input
            placeholder="Support tools"
            autoComplete="off"
            {...form.register('name', {
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                // The path follows the name until someone edits it.
                if (!endpointTouched) {
                  form.setValue('endpoint', `/${slugOf(e.target.value)}`)
                }
              },
            })}
          />
        </Field>

        <Field
          id="gateway-endpoint"
          label="Endpoint path"
          required
          hint={`Clients call ${getApiBaseUrl()}/${orgSlug}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`}
          error={errors.endpoint?.message}
        >
          <Input
            placeholder="/my-gateway"
            autoComplete="off"
            {...form.register('endpoint', { onChange: () => setEndpointTouched(true) })}
          />
        </Field>

        <Field id="gateway-description" label="Description" error={errors.description?.message}>
          <Textarea placeholder="What this gateway is for" rows={3} {...form.register('description')} />
        </Field>

        <div>
          <VisibilityField
            organizationId={currentOrganization?.id ?? ''}
            value={visibility}
            onChange={setVisibility}
            noun="this gateway"
          />
          {privateNotPossible && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              A chat channel can't be private: the people it answers don't sign in to almyty.
              Private works for MCP, UTCP, Skills, A2A, ACP and OpenAI Chat gateways.
            </p>
          )}
        </div>
      </FormSection>
    </FormPage>
  )
}
