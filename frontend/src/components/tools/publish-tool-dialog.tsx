import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Store } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

interface PublishToolDialogProps {
  tool: PublishableTool | null
  onOpenChange: (open: boolean) => void
}

/** Only an HTTP tool round-trips through a template and back into a working tool. */
export function isPublishable(tool: { executionMethod?: string | null }): boolean {
  return tool.executionMethod === 'http'
}

/**
 * Publish a tool into this organization's tool hub.
 *
 * What leaves is a shape, not a configured request: the backend copies the
 * method, path, parameters and examples and drops every header, credential
 * and API key on the way. The template lands in your organization's hub
 * only -- there is no way to publish into another tenant's, or into the
 * public catalogue.
 */
export function PublishToolDialog({ tool, onOpenChange }: PublishToolDialogProps) {
  const queryClient = useQueryClient()
  const notifications = useNotifications()

  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [provider, setProvider] = useState('')
  const [description, setDescription] = useState('')
  const [tagsInput, setTagsInput] = useState('')

  useEffect(() => {
    if (!tool) return
    setName(tool.name)
    setCategory('')
    setProvider(tool.metadata?.sourceApi?.name ?? '')
    setDescription(tool.description ?? '')
    setTagsInput('')
  }, [tool])

  const tags = tagsInput
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)

  const publishMutation = useMutation({
    mutationFn: () => {
      if (!tool) return Promise.reject(new Error('No tool selected'))
      return toolHubApi.publishTemplate({
        toolId: tool.id,
        category: category.trim(),
        ...(name.trim() && name.trim() !== tool.name ? { name: name.trim() } : {}),
        ...(provider.trim() ? { provider: provider.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tool-hub-templates'] })
      queryClient.invalidateQueries({ queryKey: ['tool-hub-providers'] })
      queryClient.invalidateQueries({ queryKey: ['tool-hub-categories'] })
      notifications.success('Published', `${name.trim() || tool?.name} is now in your tool hub.`)
      onOpenChange(false)
    },
    onError: (error: any) => {
      notifications.error('Publish failed', getApiErrorMessage(error, 'Failed to publish tool'))
    },
  })

  const canSubmit =
    !!tool && name.trim().length > 0 && category.trim().length > 0 && !publishMutation.isPending

  return (
    <Dialog open={!!tool} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Store className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
            Publish to Tool Hub
          </DialogTitle>
          <DialogDescription>
            Shares the request shape with your organization. Headers, API keys and
            credentials are stripped before the template is saved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="publish-name">Template name</Label>
            <Input
              id="publish-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="List widgets"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="publish-category">Category</Label>
              <Input
                id="publish-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="commerce"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="publish-provider">Provider</Label>
              <Input
                id="publish-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="Stripe"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="publish-description">Description</Label>
            <Textarea
              id="publish-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this tool does, and when to reach for it."
              rows={3}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="publish-tags">Tags</Label>
            <Input
              id="publish-tags"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="billing, invoices"
            />
            {tags.length > 0 && (
              <div className="flex gap-1 flex-wrap pt-1">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => publishMutation.mutate()} disabled={!canSubmit}>
            {publishMutation.isPending ? 'Publishing…' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
