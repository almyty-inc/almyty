import React, { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useNotifications } from '@/store/app'
import { agentAppsApi } from '@/lib/agent-apps'

/** Names an app cannot take, mirroring the backend list. */
const RESERVED = [
  'www', 'api', 'app', 'admin', 'docs', 'status', 'staging', 'dev',
  'chat', 'mail', 'assets', 'static', 'cdn', 'download', 'install',
]

const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

/** Why this name is unusable, or null. Same wording as the API. */
export function appSlugError(slug: string): string | null {
  const value = (slug || '').trim().toLowerCase()
  if (!value) return 'Pick a name for the product.'
  if (value.length < 3) return 'Must be at least 3 characters.'
  if (value.length > 63) return 'Must be 63 characters or fewer.'
  if (!SLUG_PATTERN.test(value)) {
    return 'Use lowercase letters, numbers and hyphens. It cannot start or end with a hyphen.'
  }
  if (RESERVED.includes(value)) return 'That name is reserved.'
  return null
}

/** Turn a display name into a usable address without making the user think. */
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
}

export interface CreateAppDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CreateAppDialog({ open, onOpenChange }: CreateAppDialogProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()

  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')

  // The address follows the name until someone edits it themselves,
  // after which it stays put: silently rewriting a slug someone chose
  // is the kind of thing that changes a URL out from under them.
  const effectiveSlug = slugTouched ? slug : slugify(name)
  const slugMessage = effectiveSlug ? appSlugError(effectiveSlug) : null

  const create = useMutation({
    mutationFn: () =>
      agentAppsApi.create({
        name: name.trim(),
        slug: effectiveSlug,
        description: description.trim() || null,
        agentIds: [],
      }),
    onSuccess: (app) => {
      success('App created', 'Add agents and choose where it ships.')
      queryClient.invalidateQueries({ queryKey: ['agent-apps'] })
      onOpenChange(false)
      setName('')
      setSlug('')
      setSlugTouched(false)
      setDescription('')
      navigate(`/apps/${app.slug}`)
    },
    onError: (err: any) =>
      errorNotif('Could not create', err?.response?.data?.message || 'Something went wrong.'),
  })

  const canSubmit = !!name.trim() && !!effectiveSlug && !slugMessage && !create.isPending

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New app</DialogTitle>
          <DialogDescription>
            An app is your agents under your own name. You choose where it ships next.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="app-name">Name</Label>
            <Input
              id="app-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Support"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="app-slug">Address</Label>
            <Input
              id="app-slug"
              value={effectiveSlug}
              onChange={(e) => {
                setSlugTouched(true)
                setSlug(e.target.value.toLowerCase())
              }}
              placeholder="acme-support"
              aria-invalid={!!slugMessage}
              aria-describedby={slugMessage ? 'app-slug-error' : undefined}
            />
            {slugMessage ? (
              <p id="app-slug-error" className="text-xs text-destructive">
                {slugMessage}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Used in the URL and as the name of anything you build from it.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="app-description">Description</Label>
            <Textarea
              id="app-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this app is for"
              rows={2}
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSubmit} onClick={() => create.mutate()}>
            {create.isPending ? 'Creating...' : 'Create app'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
