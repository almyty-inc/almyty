/**
 * apis/schema-import-form -- import a schema into an API, as a page.
 *
 * Lives at `/apis/:id/import`. It is step 2 of connecting an API
 * (`?created=1` says so and offers "Skip for now") and also where
 * "Import schema" / "Update schema" on the API detail page lead.
 *
 * The import runs as a background job. Its id goes into the URL
 * (`?job=<id>`) the moment the server accepts the import, so a refresh,
 * or coming back to the same link, picks the job up and keeps waiting
 * for it instead of losing track of it.
 */
import React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { Cloud, Database, FileCode, FileText, Link, Loader2, Server, Upload, Zap } from 'lucide-react'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useLeaveGuard } from '@/hooks/use-leave-guard'

import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { Api, ApiType } from '@/types'

type Method = 'file' | 'url' | 'paste'

export function getSchemaInfo(apiType: ApiType) {
  switch (apiType) {
    case ApiType.OPENAPI:
      return {
        icon: FileCode,
        title: 'OpenAPI/Swagger schema',
        description: 'JSON or YAML OpenAPI 3.0 or Swagger 2.0 specification',
        formats: ['JSON', 'YAML'],
        extensions: ['.json', '.yaml', '.yml'],
        example: 'https://api.example.com/swagger.json',
      }
    case ApiType.GRAPHQL:
      return {
        icon: Database,
        title: 'GraphQL schema',
        description: 'GraphQL Schema Definition Language (SDL)',
        formats: ['SDL'],
        extensions: ['.graphql', '.gql'],
        example: 'https://api.example.com/schema.graphql',
      }
    case ApiType.SOAP:
      return {
        icon: Cloud,
        title: 'SOAP/WSDL schema',
        description: 'Web Service Description Language XML file',
        formats: ['XML'],
        extensions: ['.wsdl', '.xml'],
        example: 'https://api.example.com/service.wsdl',
      }
    case ApiType.GRPC:
      return {
        icon: Server,
        title: 'Protocol Buffers schema',
        description: 'Protocol Buffer definition file',
        formats: ['Proto'],
        extensions: ['.proto'],
        example: 'https://api.example.com/service.proto',
      }
    default:
      return {
        icon: FileText,
        title: 'API schema',
        description: 'API schema or definition file',
        formats: ['JSON', 'XML', 'YAML'],
        extensions: ['.json', '.xml', '.yaml'],
        example: 'https://api.example.com/schema',
      }
  }
}

function isUrl(value: string) {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function SchemaImportForm({ api }: { api: Api }) {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const [searchParams, setSearchParams] = useSearchParams()
  const jobId = searchParams.get('job')
  const created = searchParams.get('created') === '1'

  const [method, setMethod] = React.useState<Method>('file')
  const [file, setFile] = React.useState<File | null>(null)
  const [schemaUrl, setSchemaUrl] = React.useState('')
  const [schemaContent, setSchemaContent] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [generateTools, setGenerateTools] = React.useState(true)
  const [errors, setErrors] = React.useState<Partial<Record<Method, string>>>({})
  const [failure, setFailure] = React.useState<string | null>(null)

  const dirty = !!file || schemaUrl !== '' || schemaContent !== '' || description !== ''
  const guard = useLeaveGuard(dirty)

  const info = getSchemaInfo(api.type)
  const Icon = info.icon
  const detailPath = `/apis/${api.id}`

  const finish = (result: any) => {
    queryClient.invalidateQueries({ queryKey: ['api', api.id] })
    // The overview panel's "Schema" row reads this separate query, not
    // api.schemas (which the detail endpoint does not eager-load), so
    // leaving it out made a successful import read as "Not uploaded" on
    // the one panel meant to confirm it.
    queryClient.invalidateQueries({ queryKey: ['api-schemas', api.id] })
    queryClient.invalidateQueries({ queryKey: ['api-operations', api.id] })
    queryClient.invalidateQueries({ queryKey: ['apis'] })
    queryClient.invalidateQueries({ queryKey: ['tools'] })
    // Async jobs return { status, result }; a direct import returns the result.
    const jobResult = result?.result || result
    const opCount = jobResult?.operations?.length || jobResult?.operationCount || 0
    const toolCount = jobResult?.tools?.length || jobResult?.toolCount || 0
    success('Schema imported', `${opCount} operations found, ${toolCount} tools generated.`)
    guard.leave(detailPath)
  }

  const fail = (err: unknown) => {
    const message = getApiErrorMessage(err, 'Please try again.')
    setFailure(message)
    error('Failed to import schema', message)
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

  const handleSubmit = () => {
    setFailure(null)
    const nextErrors: Partial<Record<Method, string>> = {}
    if (method === 'file' && !file) nextErrors.file = 'Choose a schema file.'
    if (method === 'url' && !isUrl(schemaUrl.trim())) nextErrors.url = 'Enter the http(s) URL the schema is served from.'
    if (method === 'paste' && !schemaContent.trim()) nextErrors.paste = 'Paste the schema content.'
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return

    const data: { schemaUrl?: string; schemaContent?: string; description?: string; generateTools: boolean } = {
      generateTools,
    }
    if (description.trim()) data.description = description.trim()
    if (method === 'url') data.schemaUrl = schemaUrl.trim()
    if (method === 'paste') data.schemaContent = schemaContent
    importMutation.mutate({ data, file: method === 'file' ? file ?? undefined : undefined })
  }

  return (
    <FormPage
      title={
        <span className="flex items-center gap-2">
          <Icon className="h-6 w-6 shrink-0" aria-hidden="true" />
          Import schema
        </span>
      }
      description={`${info.description}. The schema is parsed into ${api.name}'s operations, and each operation can become a tool.`}
      back={{ to: detailPath, label: api.name }}
      guard={guard}
      onSubmit={handleSubmit}
      submitLabel={running ? 'Importing...' : 'Import schema'}
      submitting={running}
      footerStart={
        created ? (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Step 2 of 2</span>
            <Button type="button" variant="ghost" onClick={() => guard.navigate(detailPath)} disabled={running}>
              Skip for now
            </Button>
          </div>
        ) : undefined
      }
    >
      {created && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-500/30 dark:bg-green-500/10">
          <p className="font-medium">API "{api.name}" created</p>
          <p className="text-xs text-muted-foreground">
            Import a schema to generate its operations and tools, or skip this and import one later from the API's page.
          </p>
        </div>
      )}

      {running && (
        <div
          role="status"
          className="flex items-start gap-3 rounded-lg border bg-muted/40 p-3 text-sm"
          data-testid="schema-import-running"
        >
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
          <div>
            <p className="font-medium">Importing the schema...</p>
            <p className="text-xs text-muted-foreground">
              Large schemas take a minute. The import keeps running on the server if you leave; this page's link
              picks it up again.
            </p>
          </div>
        </div>
      )}

      {failure && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          The import failed: {failure}
        </div>
      )}

      <FormSection title={info.title}>
        <div className="flex flex-wrap gap-2">
          {info.formats.map((format) => (
            <Badge key={format} variant="secondary">{format}</Badge>
          ))}
        </div>

        <Tabs value={method} onValueChange={(v) => setMethod(v as Method)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="file" className="flex items-center gap-2">
              <Upload className="h-4 w-4" aria-hidden="true" />
              File
            </TabsTrigger>
            <TabsTrigger value="url" className="flex items-center gap-2">
              <Link className="h-4 w-4" aria-hidden="true" />
              URL
            </TabsTrigger>
            <TabsTrigger value="paste" className="flex items-center gap-2">
              <FileText className="h-4 w-4" aria-hidden="true" />
              Paste
            </TabsTrigger>
          </TabsList>

          <TabsContent value="file" className="mt-4">
            <Field
              id="schema-file"
              label="Schema file"
              hint={
                file
                  ? `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`
                  : `Supported formats: ${info.extensions.join(', ')}`
              }
              error={errors.file}
            >
              <Input
                type="file"
                accept={info.extensions.join(',')}
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null)
                  setErrors((prev) => ({ ...prev, file: undefined }))
                }}
              />
            </Field>
          </TabsContent>

          <TabsContent value="url" className="mt-4">
            <Field id="schema-url" label="Schema URL" hint="Where the API publishes its schema." error={errors.url}>
              <Input
                type="url"
                placeholder={info.example}
                value={schemaUrl}
                onChange={(e) => setSchemaUrl(e.target.value)}
              />
            </Field>
          </TabsContent>

          <TabsContent value="paste" className="mt-4">
            <Field id="schema-content" label="Schema content" error={errors.paste}>
              <Textarea
                rows={12}
                className="font-mono text-xs"
                placeholder={`Paste your ${info.title.toLowerCase()} here...`}
                value={schemaContent}
                onChange={(e) => setSchemaContent(e.target.value)}
              />
            </Field>
          </TabsContent>
        </Tabs>

        <Field id="schema-description" label="Description (optional)">
          <Input
            placeholder="Describe this schema import..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="flex items-center justify-between gap-4 rounded-lg bg-muted p-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4" aria-hidden="true" />
              <Label htmlFor="schema-generate-tools" className="font-medium">
                Generate tools
              </Label>
            </div>
            <p className="text-sm text-muted-foreground">Create a tool for every operation in the schema.</p>
          </div>
          <Switch id="schema-generate-tools" checked={generateTools} onCheckedChange={setGenerateTools} />
        </div>
      </FormSection>
    </FormPage>
  )
}
