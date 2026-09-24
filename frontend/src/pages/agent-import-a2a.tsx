/* /agents/import?source=a2a -- add an external agent from its A2A agent card.
 *
 * Was a dialog on the Agents list. Two steps on one page: fetch the card to
 * see what the remote agent says it is, then import it. Editing the URL
 * after a preview drops the preview, so what is imported is always the card
 * that was shown.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2 } from 'lucide-react'
import * as z from 'zod'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { credentialsApi, externalAgentsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import type { VaultCredential } from '@/types'

const NO_CREDENTIAL = '__none'
const urlSchema = z.string().url('Enter the full URL of the agent card, starting with https://.')

interface AgentCardPreview {
  name?: string
  description?: string
  version?: string
  capabilities?: Record<string, unknown>
  skills?: Array<{ id?: string; name?: string }>
}

export function ExternalA2AImport() {
  useEffect(() => {
    document.title = 'Import external A2A agent | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [url, setUrl] = useState('')
  const [urlError, setUrlError] = useState<string | undefined>()
  const [preview, setPreview] = useState<AgentCardPreview | null>(null)
  const [credentialId, setCredentialId] = useState<string>(NO_CREDENTIAL)
  const guard = useLeaveGuard(url.trim() !== '')

  const { data: credentialsData } = useQuery({
    queryKey: ['credentials'],
    queryFn: () => credentialsApi.getAll(),
  })
  const credentials: VaultCredential[] = (() => {
    const raw =
      credentialsData?.credentials || (Array.isArray(credentialsData) ? credentialsData : [])
    return Array.isArray(raw) ? raw : []
  })()

  const previewMutation = useMutation({
    mutationFn: (cardUrl: string) => externalAgentsApi.preview(cardUrl),
    onSuccess: (data: AgentCardPreview) => setPreview(data || {}),
    onError: (err: unknown) => {
      const message = getApiErrorMessage(err, 'Could not fetch agent card')
      setUrlError(message)
      errorNotif('Preview failed', message)
    },
  })

  const importMutation = useMutation({
    mutationFn: () =>
      externalAgentsApi.create({
        agentCardUrl: url.trim(),
        credentialId: credentialId && credentialId !== NO_CREDENTIAL ? credentialId : undefined,
      }),
    onSuccess: async () => {
      success('Agent imported', 'The external A2A agent is on your agents list.')
      await queryClient.invalidateQueries({ queryKey: ['external-agents'] })
      guard.leave('/agents')
    },
    onError: (err: unknown) => {
      errorNotif('Import failed', getApiErrorMessage(err, 'Failed to import agent'))
    },
  })

  const runPreview = () => {
    const parsed = urlSchema.safeParse(url.trim())
    if (!parsed.success) {
      setUrlError(parsed.error.issues[0]?.message)
      return
    }
    setUrlError(undefined)
    previewMutation.mutate(parsed.data)
  }

  return (
    <FormPage
      title="Import external A2A agent"
      description="Enter the URL of an A2A agent card, check what it describes, then import the agent."
      back={{ to: '/agents', label: 'Agents' }}
      guard={guard}
      width="narrow"
      submitLabel={preview ? 'Import agent' : 'Fetch agent card'}
      submitting={preview ? importMutation.isPending : previewMutation.isPending}
      onSubmit={() => (preview ? importMutation.mutate() : runPreview())}
    >
      <Field
        id="agent-card-url"
        label="Agent card URL"
        hint="Usually served at /.well-known/agent.json on the agent's host."
        error={urlError}
      >
        <Input
          type="url"
          placeholder="https://example.com/.well-known/agent.json"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            // A preview belongs to the URL it was fetched from.
            setPreview(null)
            if (urlError) setUrlError(undefined)
          }}
        />
      </Field>

      {previewMutation.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Fetching the agent card...
        </p>
      )}

      {preview && (
        <>
          <FormSection>
            <div className="flex items-start justify-between gap-3" data-testid="a2a-preview">
              <div className="min-w-0">
                <h2 className="break-words text-base font-semibold">
                  {preview.name || 'Unnamed agent'}
                </h2>
                {preview.description && (
                  <p className="mt-0.5 break-words text-sm text-muted-foreground">
                    {preview.description}
                  </p>
                )}
              </div>
              <Badge
                variant="outline"
                className="shrink-0 border-cyan-300 text-[10px] text-cyan-600 dark:border-cyan-500/40 dark:text-cyan-400"
              >
                A2A
              </Badge>
            </div>
            <dl className="space-y-1 text-sm">
              {preview.version && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Version</dt>
                  <dd>{preview.version}</dd>
                </div>
              )}
              {preview.capabilities && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Capabilities</dt>
                  <dd className="min-w-0 break-words">
                    {Object.keys(preview.capabilities).join(', ') || 'none listed'}
                  </dd>
                </div>
              )}
              {preview.skills && preview.skills.length > 0 && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground">Skills</dt>
                  <dd className="min-w-0 break-words">
                    {preview.skills.map((s) => s.name || s.id).join(', ')}
                  </dd>
                </div>
              )}
            </dl>
            <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
              <Check className="h-3 w-3" aria-hidden="true" />
              Agent card fetched
            </p>
          </FormSection>

          <Field
            id="a2a-import-credential"
            label="Credential (optional)"
            hint="If the remote agent requires authentication, pick the credential its requests should use."
          >
            <Select value={credentialId} onValueChange={setCredentialId}>
              <SelectTrigger id="a2a-import-credential">
                <SelectValue placeholder="No authentication" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_CREDENTIAL}>No authentication</SelectItem>
                {credentials.map((cred) => (
                  <SelectItem key={cred.id} value={cred.id}>
                    {cred.name} ({cred.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      )}
    </FormPage>
  )
}
