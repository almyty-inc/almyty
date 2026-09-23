/* /agents/import -- create an agent from an exported agent JSON.
 *
 * Was a dialog on the Agents list. As a page it has a URL the Import menu
 * links to, and a pasted export survives an accidental click elsewhere.
 */
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FileUp } from 'lucide-react'

import { Field, FormPage } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { agentsApi } from '@/lib/api'
import { useNotifications } from '@/store/app'

/** Parse an export, or say in one line why it is not one. */
export function parseAgentExport(text: string): { data?: unknown; error?: string } {
  if (!text.trim()) return { error: 'Choose a file or paste the exported JSON.' }
  try {
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { error: 'An agent export is a JSON object, like {"name": ..., "pipeline": {...}}.' }
    }
    return { data }
  } catch {
    return { error: "This isn't valid JSON. Paste the whole file the export produced." }
  }
}

export function AgentImportPage() {
  useEffect(() => {
    document.title = 'Import agent | almyty'
    return () => {
      document.title = 'almyty'
    }
  }, [])

  const queryClient = useQueryClient()
  const { success, error: errorNotif } = useNotifications()
  const [json, setJson] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | undefined>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const guard = useLeaveGuard(json.trim() !== '')

  const importMutation = useMutation({
    mutationFn: (data: unknown) => agentsApi.importAgent(data),
    onSuccess: async (result: { id?: string } | undefined) => {
      success('Agent imported', 'Review the pipeline, then activate it.')
      await queryClient.invalidateQueries({ queryKey: ['agents'] })
      guard.leave(result?.id ? `/agents/${result.id}/edit` : '/agents')
    },
    onError: (err: Error) => {
      errorNotif('Import failed', err?.message || 'The server rejected this export.')
    },
  })

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      const text = evt.target?.result
      if (typeof text === 'string') {
        setJson(text)
        setFileName(file.name)
        setError(undefined)
      }
    }
    reader.onerror = () => errorNotif('Could not read the file', 'Choose the file again.')
    reader.readAsText(file)
    // Let the same file be chosen again after an edit.
    e.target.value = ''
  }

  return (
    <FormPage
      title="Import agent"
      description="Create an agent from a JSON export of another agent."
      back={{ to: '/agents', label: 'Agents' }}
      guard={guard}
      submitLabel="Import agent"
      submitting={importMutation.isPending}
      onSubmit={() => {
        const parsed = parseAgentExport(json)
        setError(parsed.error)
        if (parsed.data) importMutation.mutate(parsed.data)
      }}
    >
      <div className="space-y-2">
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={onFile}
          data-testid="agent-import-file"
        />
        <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
          <FileUp className="mr-2 h-4 w-4" aria-hidden="true" />
          Choose .json file
        </Button>
        {fileName && <p className="text-sm text-muted-foreground">Loaded {fileName}.</p>}
      </div>
      <Field
        id="agent-import-json"
        label="Agent JSON"
        hint="An agent's detail page exports this file (Export). Choosing a file fills this in; you can also paste it."
        error={error}
      >
        <Textarea
          className="min-h-[16rem] font-mono text-xs"
          placeholder='{"name": "My agent", "pipeline": { ... }}'
          value={json}
          onChange={(e) => {
            setJson(e.target.value)
            if (error) setError(undefined)
          }}
        />
      </Field>
    </FormPage>
  )
}
