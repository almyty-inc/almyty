import React, { useState } from 'react'
import { UseFormReturn } from 'react-hook-form'
import { UseMutationResult, useQuery } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { agentsApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import type { Agent } from '@/types'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'

interface CreateGatewayDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  createForm: UseFormReturn<any>
  onSubmit: (data: any) => void
  createGatewayMutation: UseMutationResult<any, any, any, any>
}

const TOOL_TYPES = [
  { value: 'mcp', label: 'MCP - Model Context Protocol' },
  { value: 'utcp', label: 'UTCP - Universal Tool Call Protocol' },
  { value: 'skills', label: 'Skills - Agent Skills (SKILL.md)' },
]

const AGENT_TYPES = [
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
  { value: 'chat_widget', label: 'Chat Widget' },
]

export function CreateGatewayDialog({
  open,
  onOpenChange,
  createForm,
  onSubmit,
  createGatewayMutation,
}: CreateGatewayDialogProps) {
  const [kind, setKind] = useState<'tool' | 'agent'>('tool')
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })
  const { currentOrganization } = useOrganizationStore()

  // Fetch agents for agent-kind gateways
  const { data: agentsData } = useQuery({
    queryKey: ['agents', currentOrganization?.id],
    queryFn: async () => {
      const d = await agentsApi.getAll()
      const result = d?.agents || (Array.isArray(d) ? d : [])
      return Array.isArray(result) ? result : []
    },
    enabled: !!currentOrganization && kind === 'agent' && open,
  })

  const agents: Agent[] = Array.isArray(agentsData) ? agentsData : []
  const typeOptions = kind === 'tool' ? TOOL_TYPES : AGENT_TYPES

  const handleOpenChange = (openVal: boolean) => {
    onOpenChange(openVal)
    if (!openVal) {
      createForm.reset()
      setKind('tool')
    }
  }

  const handleSubmit = (data: any) => {
    onSubmit({
      ...data,
      kind,
      agentId: kind === 'agent' ? createForm.getValues('agentId') : undefined,
      visibility: visibility.visibility,
      teamId: visibility.teamId,
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create New Gateway</DialogTitle>
          <DialogDescription>
            Create a new gateway to expose your tools or agents via different protocols.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={createForm.handleSubmit(handleSubmit)} className="space-y-6">
          {/* Kind selector */}
          <div>
            <Label>Gateway Kind</Label>
            <div className="grid grid-cols-2 gap-3 mt-2">
              <button
                type="button"
                className={`p-3 rounded-lg border text-left transition-colors ${
                  kind === 'tool'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'hover:border-muted-foreground/30'
                }`}
                onClick={() => {
                  setKind('tool')
                  createForm.setValue('type', '')
                  createForm.setValue('agentId', undefined)
                }}
              >
                <div className="font-medium text-sm">Tools</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Expose tools via MCP, UTCP, or Agent Skills
                </div>
              </button>
              <button
                type="button"
                className={`p-3 rounded-lg border text-left transition-colors ${
                  kind === 'agent'
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'hover:border-muted-foreground/30'
                }`}
                onClick={() => {
                  setKind('agent')
                  createForm.setValue('type', '')
                }}
              >
                <div className="font-medium text-sm">Agent</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  Serve an agent via A2A, OpenAI Chat, Slack, and more
                </div>
              </button>
            </div>
          </div>

          <div>
            <Label htmlFor="name">Gateway Name</Label>
            <Input
              id="name"
              placeholder="Enter gateway name"
              {...createForm.register('name', {
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                  const current = createForm.getValues('endpoint')
                  // Auto-fill endpoint if empty or was auto-generated
                  if (!current || current === '/' + (createForm.getValues('name') || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')) {
                    const slug = e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
                    createForm.setValue('endpoint', '/' + slug)
                  }
                }
              })}
            />
            {createForm.formState.errors.name && (
              <p className="text-sm text-red-500 mt-1">
                {(createForm.formState.errors.name as any).message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="type">Gateway Type</Label>
            <Select
              onValueChange={(value) => createForm.setValue('type', value)}
              value={createForm.watch('type')}
            >
              <SelectTrigger id="type" aria-label="Gateway Type">
                <SelectValue placeholder="Select gateway type" />
              </SelectTrigger>
              <SelectContent>
                {typeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {createForm.formState.errors.type && (
              <p className="text-sm text-red-500 mt-1">
                {(createForm.formState.errors.type as any).message}
              </p>
            )}
          </div>

          {/* Agent picker for agent-kind gateways */}
          {kind === 'agent' && (
            <div>
              <Label htmlFor="agentId">Agent</Label>
              <Select
                onValueChange={(value) => createForm.setValue('agentId', value)}
                value={createForm.watch('agentId') || ''}
              >
                <SelectTrigger id="agentId" aria-label="Agent">
                  <SelectValue placeholder="Select an agent" />
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
              <p className="text-xs text-muted-foreground mt-1">
                The agent that will handle requests on this gateway.
              </p>
            </div>
          )}

          <div>
            <Label htmlFor="endpoint">Endpoint Path</Label>
            <Input
              id="endpoint"
              placeholder="/my-gateway"
              {...createForm.register('endpoint')}
            />
            {createForm.formState.errors.endpoint && (
              <p className="text-sm text-red-500 mt-1">
                {(createForm.formState.errors.endpoint as any).message}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="description">Description (Optional)</Label>
            <Textarea
              id="description"
              placeholder="Enter gateway description"
              {...createForm.register('description')}
            />
          </div>

          <div className="border-t pt-4">
            <VisibilityField
              organizationId={currentOrganization?.id ?? ''}
              value={visibility}
              onChange={setVisibility}
            />
          </div>

          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={createGatewayMutation.isPending}
            >
              {createGatewayMutation.isPending ? 'Creating...' : 'Create Gateway'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
