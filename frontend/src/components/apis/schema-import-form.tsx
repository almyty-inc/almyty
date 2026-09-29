/**
 * apis/schema-import-form -- update an API's description, as a page.
 *
 * Lives at `/apis/:id/import`, where "Update the description" on the API's
 * page leads. The same one box as connecting an API: a link (a GraphQL
 * endpoint's own link included), a file, or pasted text. A description of
 * another kind than the API is refused in words by the server.
 *
 * The import runs as a background job. Its id goes into the URL
 * (`?job=<id>`) the moment the server accepts the import, so a refresh,
 * or coming back to the same link, picks the job up and keeps waiting
 * for it instead of losing track of it.
 */
import React from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Disclosure } from '@/components/ui/disclosure'
import { Label } from '@/components/ui/label'
import { PageHeader } from '@/components/layout/page-header'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { Api } from '@/types'

import { SourceBox, readSource } from './source-box'

export function SchemaImportForm({ api }: { api: Api }) {
  const queryClient = useQueryClient()
  const { success } = useNotifications()
  const [searchParams, setSearchParams] = useSearchParams()
  const jobId = searchParams.get('job')

  const [text, setText] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [makeTools, setMakeTools] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const detailPath = `/apis/${api.id}`
  const guard = useLeaveGuard(!!file || text.trim() !== '')

  const finish = (result: any) => {
    queryClient.invalidateQueries({ queryKey: ['api', api.id] })
    // The overview panel's "Schema" row reads this separate query, not
    // api.schemas (which the detail endpoint does not eager-load).
    queryClient.invalidateQueries({ queryKey: ['api-schemas', api.id] })
    queryClient.invalidateQueries({ queryKey: ['api-operations', api.id] })
    queryClient.invalidateQueries({ queryKey: ['apis'] })
    queryClient.invalidateQueries({ queryKey: ['tools'] })
    // Async jobs return { status, result }; a direct import returns the result.
    const jobResult = result?.result || result
    const opCount = jobResult?.operations?.length || jobResult?.operationCount || 0
    const toolCount = jobResult?.tools?.length || jobResult?.toolCount || 0
    success('Description updated', `${opCount} operations found, ${toolCount} tools made.`)
    guard.leave(detailPath)
  }

  const fail = (err: unknown) => {
    setError(getApiErrorMessage(err, 'Please try again.'))
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('job')
        return next
      },
      { replace: true },
    )
  }

  // Waits for a background import job, whether this page started it or
  // the URL carried it in from before a refresh.
  const startedJob = React.useRef<string | null>(null)
  const pollMutation = useMutation({
    mutationFn: (job: string) => apisApi.pollImportStatus(api.id, job),
    onSuccess: finish,
    onError: fail,
  })
  const poll = (job: string) => {
    startedJob.current = job
    pollMutation.mutate(job)
  }

  React.useEffect(() => {
    if (jobId && startedJob.current !== jobId) poll(jobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  const importMutation = useMutation({
    mutationFn: (vars: { data: Parameters<typeof apisApi.importSchema>[1]; file?: File }) =>
      apisApi.importSchema(api.id, vars.data, vars.file),
    onSuccess: (result: any) => {
      if (result?.jobId) {
        poll(result.jobId)
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev)
            next.set('job', result.jobId)
            return next
          },
          { replace: true },
        )
        return
      }
      finish(result)
    },
    onError: fail,
  })

  const running = importMutation.isPending || pollMutation.isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    const source = readSource(text, file)
    if (!source) {
      setError('Paste a link, drop a file, or paste the description first.')
      document.getElementById('api-source')?.focus()
      return
    }
    importMutation.mutate({
      data: {
        generateTools: makeTools,
        ...(source.url ? { schemaUrl: source.url } : {}),
        ...(source.content ? { schemaContent: source.content } : {}),
      },
      file: source.file,
    })
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to={detailPath} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        {api.name}
      </Link>
      <PageHeader title="Update the description" description={`Its operations are read again. Tools made from ${api.name} keep working.`} />

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-label="Update the description">
            {running && (
              <p role="status" className="flex items-center gap-2 text-sm" data-testid="schema-import-running">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Reading the description. Big ones take a minute; it keeps going if you leave.
              </p>
            )}
            <SourceBox
              id="api-source"
              text={text}
              file={file}
              onTextChange={(next) => {
                setText(next)
                setError(null)
              }}
              onFileChange={(next) => {
                setFile(next)
                setError(null)
              }}
              error={error}
              disabled={running}
            />
            <Disclosure title="Advanced">
              <div className="flex items-center gap-2">
                <Checkbox id="api-make-tools" checked={makeTools} onCheckedChange={(v) => setMakeTools(v === true)} />
                <Label htmlFor="api-make-tools" className="cursor-pointer font-normal">
                  Make a tool for every operation
                </Label>
              </div>
            </Disclosure>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={running}>
                {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
                {running ? 'Reading it...' : 'Import'}
              </Button>
              <Button type="button" variant="ghost" onClick={() => guard.navigate(detailPath)} disabled={running}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {guard.element}
    </div>
  )
}
