import React, { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import * as z from 'zod'
import { Globe, Loader2, Check, AlertTriangle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
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

import { externalAgentsApi, credentialsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'
import type { VaultCredential } from '@/types'

const previewSchema = z.object({
  url: z.string().url('Must be a valid URL'),
})

type PreviewForm = z.infer<typeof previewSchema>

interface ImportExternalA2ADialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ImportExternalA2ADialog({ open, onOpenChange }: ImportExternalA2ADialogProps) {
  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [previewData, setPreviewData] = useState<any>(null)
  const [credentialId, setCredentialId] = useState<string>('')

  const form = useForm<PreviewForm>({
    resolver: zodResolver(previewSchema),
    defaultValues: { url: '' },
  })

  // Fetch credentials for optional auth
  const { data: credentialsData } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.getAll(),
    enabled: open,
  })
  const credentials: VaultCredential[] = (() => {
    const raw = credentialsData?.credentials || (Array.isArray(credentialsData) ? credentialsData : [])
    return Array.isArray(raw) ? raw : []
  })()

  const previewMutation = useMutation({
    mutationFn: (url: string) => externalAgentsApi.preview(url),
    onSuccess: (data) => {
      setPreviewData(data)
    },
    onError: (err: any) => {
      errorNotif('Preview Failed', err?.response?.data?.message || err?.message || 'Could not fetch agent card')
    },
  })

  const importMutation = useMutation({
    mutationFn: () => {
      const url = form.getValues('url')
      return externalAgentsApi.create({
        agentCardUrl: url,
        credentialId: credentialId || undefined,
      })
    },
    onSuccess: () => {
      success('Agent Imported', 'External A2A agent has been imported successfully.')
      queryClient.invalidateQueries({ queryKey: ['external-agents'] })
      handleClose()
    },
    onError: (err: any) => {
      errorNotif('Import Failed', err?.response?.data?.message || err?.message || 'Failed to import agent')
    },
  })

  const handleClose = () => {
    onOpenChange(false)
    form.reset()
    setPreviewData(null)
    setCredentialId('')
  }

  const handlePreview = (data: PreviewForm) => {
    previewMutation.mutate(data.url)
  }

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) handleClose(); else onOpenChange(val) }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Import External A2A Agent
          </DialogTitle>
          <DialogDescription>
            Enter the URL of an A2A agent card to preview and import an external agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* URL input + preview button */}
          <form onSubmit={form.handleSubmit(handlePreview)} className="space-y-3">
            <div>
              <Label htmlFor="agent-card-url">Agent Card URL</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  id="agent-card-url"
                  placeholder="https://example.com/.well-known/agent.json"
                  {...form.register('url')}
                  className="flex-1"
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={previewMutation.isPending}
                >
                  {previewMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    'Preview'
                  )}
                </Button>
              </div>
              {form.formState.errors.url && (
                <p className="text-sm text-red-500 mt-1">
                  {form.formState.errors.url.message}
                </p>
              )}
            </div>
          </form>

          {/* Preview card */}
          {previewData && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <h4 className="font-semibold text-sm">{previewData.name || 'Unknown Agent'}</h4>
                  {previewData.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{previewData.description}</p>
                  )}
                </div>
                <Badge variant="outline" className="text-[10px] border-cyan-300 text-cyan-600 dark:border-cyan-500/40 dark:text-cyan-400">
                  A2A
                </Badge>
              </div>
              {previewData.version && (
                <div className="text-xs text-muted-foreground">
                  Version: {previewData.version}
                </div>
              )}
              {previewData.capabilities && (
                <div className="text-xs text-muted-foreground">
                  Capabilities: {Object.keys(previewData.capabilities).join(', ') || 'none listed'}
                </div>
              )}
              {previewData.skills && previewData.skills.length > 0 && (
                <div className="text-xs">
                  <span className="text-muted-foreground">Skills: </span>
                  {previewData.skills.map((s: any) => s.name || s.id).join(', ')}
                </div>
              )}
              <div className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                <Check className="h-3 w-3" />
                Agent card fetched successfully
              </div>
            </div>
          )}

          {/* Credential picker */}
          {previewData && (
            <div>
              <Label>Credential (optional)</Label>
              <Select value={credentialId} onValueChange={setCredentialId}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="No authentication" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No authentication</SelectItem>
                  {credentials.map((cred) => (
                    <SelectItem key={cred.id} value={cred.id}>
                      {cred.name} ({cred.type})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                If the remote agent requires authentication, pick a credential to use for requests.
              </p>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            {previewData && (
              <Button
                onClick={() => importMutation.mutate()}
                disabled={importMutation.isPending}
              >
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Importing...
                  </>
                ) : (
                  <>
                    <Globe className="h-4 w-4 mr-2" />
                    Import Agent
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
