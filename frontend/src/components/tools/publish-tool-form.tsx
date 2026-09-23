/**
 * tools/publish-tool-form -- publish a tool into this organization's tool
 * hub (`/tools/:id/publish`).
 *
 * What leaves is a shape, not a configured request: the backend copies the
 * method, path, parameters and examples and drops every header, credential
 * and API key on the way. The template lands in your organization's hub
 * only -- there is no way to publish into another tenant's, or into the
 * public catalogue.
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { toolHubApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'

export interface PublishableTool {
  id: string
  name: string
  description?: string
  executionMethod?: string | null
  version?: string
  metadata?: { sourceApi?: { name?: string } }
}

/** Only an HTTP tool round-trips through a template and back into a working tool. */
export function isPublishable(tool: { executionMethod?: string | null }): boolean {
  return tool.executionMethod === 'http'
}

export function PublishToolForm({ tool }: { tool: PublishableTool }) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const initialProvider = tool.metadata?.sourceApi?.name ?? ''
  const initialDescription = tool.description ?? ''
  const [name, setName] = useState(tool.name)
  const [category, setCategory] = useState('')
  const [provider, setProvider] = useState(initialProvider)
  const [description, setDescription] = useState(initialDescription)
  const [tagsInput, setTagsInput] = useState('')
  const [errors, setErrors] = useState<{ name?: string; category?: string }>({})

  const guard = useLeaveGuard(
    name !== tool.name || category !== '' || provider !== initialProvider ||
      description !== initialDescription || tagsInput !== '',
  )

  const tags = tagsInput
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

  const publishMutation = useMutation({
    mutationFn: () =>
      toolHubApi.publishTemplate({
        toolId: tool.id,
        category: category.trim(),
        ...(name.trim() && name.trim() !== tool.name ? { name: name.trim() } : {}),
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tool-hub-templates'] })
      queryClient.invalidateQueries({ queryKey: ['tool-hub-providers'] })
      queryClient.invalidateQueries({ queryKey: ['tool-hub-categories'] })
      notifications.success('Published', `${name.trim() || tool.name} is now in your tool hub.`)
      guard.leave('/tools?tab=hub')
    },
    onError: (error: any) => {
      notifications.error('Publish failed', getApiErrorMessage(error, 'Failed to publish tool'))
    },
  })

  const handleSubmit = () => {
    const next: { name?: string; category?: string } = {}
    if (!name.trim()) next.name = 'Give the template a name.'
    if (!category.trim()) next.category = 'Pick a category, so the template can be found in the hub.'
    setErrors(next)
    if (next.name || next.category) return
    publishMutation.mutate()
  }

  return (
    <FormPage
      title="Publish to Tool Hub"
      description="Shares the request shape with your organization. Headers, API keys and credentials are stripped before the template is saved."
      back={{ to: `/tools/${tool.id}`, label: tool.name }}
      guard={guard}
      onSubmit={handleSubmit}
      submitLabel={publishMutation.isPending ? 'Publishing…' : 'Publish'}
      submitting={publishMutation.isPending}
      width="narrow"
    >
      <FormSection title="Template">
        <Field id="publish-name" label="Template name" error={errors.name} required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="List widgets" />
        </Field>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field id="publish-category" label="Category" hint="How the hub groups templates." error={errors.category} required>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="commerce" />
          </Field>
          <Field id="publish-provider" label="Provider">
            <Input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="Stripe" />
          </Field>
        </div>

        <Field id="publish-description" label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this tool does, and when to reach for it."
            rows={3}
          />
        </Field>

        <Field id="publish-tags" label="Tags" hint="Comma-separated.">
          <Input value={tagsInput} onChange={(e) => setTagsInput(e.target.value)} placeholder="billing, invoices" />
        </Field>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </FormSection>
    </FormPage>
  )
}
