import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { cn } from '@/lib/utils'
/**
 * pages/api-schema-import — import a schema into an existing API
 * (/apis/:id/import). Used to be a dialog opened from the APIs list and
 * the API detail page.
 */
import React, { useState } from 'react'
import { Link as RouterLink, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ArrowLeft, Upload, FileCode, Database, Cloud, Server, FileText, Link, Zap } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { QueryError } from '@/components/ui/query-error'
import { apisApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useNotifications } from '@/store/app'
import { ApiType, type Api } from '@/types'

const importSchemaSchema = z.object({
  schemaContent: z.string().optional(),
  // An empty field is "not using the URL tab", not an invalid URL.
  schemaUrl: z.union([z.literal(''), z.string().url()]).optional(),
  description: z.string().optional(),
  generateTools: z.boolean().optional(),
})

type ImportSchemaFormData = z.infer<typeof importSchemaSchema>

export function ApiSchemaImportPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()
  const [importMethod, setImportMethod] = useState<'file' | 'url' | 'paste'>('file')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)

  const apiQuery = useQuery<Api>({
    queryKey: ['api', id],
    queryFn: () => apisApi.getById(id!),
    enabled: !!id,
  })
  const api = apiQuery.data
  const apiType = api?.type ?? ApiType.OPENAPI

  React.useEffect(() => {
    document.title = 'Import schema | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const leave = () => navigate(`/apis/${id}`)

  const importSchemaMutation = useMutation({
    mutationFn: async ({ data, file }: { data: ImportSchemaFormData; file?: File }) => {
      const importResult = await apisApi.importSchema(id!, data as any, file)
      if (importResult?.jobId) {
        return apisApi.pollImportStatus(id!, importResult.jobId)
      }
      return importResult
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['api', id] })
      // The overview panel's "Schema" row reads its own query, not api.schemas.
      queryClient.invalidateQueries({ queryKey: ['api-schemas', id] })
      queryClient.invalidateQueries({ queryKey: ['api-operations', id] })
      queryClient.invalidateQueries({ queryKey: ['apis'] })
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      const jobResult = result?.result || result
      const opCount = jobResult?.operations?.length || jobResult?.operationCount || 0
      const toolCount = jobResult?.tools?.length || jobResult?.toolCount || 0
      success('Schema imported', `${opCount} operations found, ${toolCount} tools generated.`)
      leave()
    },
    onError: (err: unknown) => {
      error('Failed to import schema', getApiErrorMessage(err, 'Please try again.'))
    },
  })
  const isLoading = importSchemaMutation.isPending

  const form = useForm<ImportSchemaFormData>({
    resolver: zodResolver(importSchemaSchema),
    defaultValues: {
      generateTools: true,
    },
  })

  // One of the three sources is required. Checked here rather than in the
  // schema: the file lives outside the form, and a file-only import used
  // to fail the schema's "content or URL" rule and never submit. The file
  // itself also never reached the request -- both pages that opened the
  // dialog dropped it.
  const handleSubmit = (data: ImportSchemaFormData) => {
    if (!selectedFile && !data.schemaContent && !data.schemaUrl) {
      form.setError('schemaContent', { message: 'Either schema content or URL must be provided' })
      return
    }
    const payload: ImportSchemaFormData = { ...data }
    if (!payload.schemaUrl) delete payload.schemaUrl
    if (!payload.schemaContent) delete payload.schemaContent
    importSchemaMutation.mutate({ data: payload, file: selectedFile || undefined })
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      setSelectedFile(file)
      // Clear other methods when file is selected
      form.setValue('schemaUrl', '')
      form.setValue('schemaContent', '')
    }
  }

  const getSchemaInfo = (apiType: ApiType) => {
    switch (apiType) {
      case ApiType.OPENAPI:
        return {
          icon: FileCode,
          title: 'OpenAPI/Swagger Schema',
          description: 'JSON or YAML format OpenAPI 3.0 or Swagger 2.0 specification',
          formats: ['JSON', 'YAML'],
          extensions: ['.json', '.yaml', '.yml'],
          example: 'https://api.example.com/swagger.json'
        }
      case ApiType.GRAPHQL:
        return {
          icon: Database,
          title: 'GraphQL Schema',
          description: 'GraphQL Schema Definition Language (SDL)',
          formats: ['SDL'],
          extensions: ['.graphql', '.gql'],
          example: 'https://api.example.com/schema.graphql'
        }
      case ApiType.SOAP:
        return {
          icon: Cloud,
          title: 'SOAP/WSDL Schema',
          description: 'Web Service Description Language XML file',
          formats: ['XML'],
          extensions: ['.wsdl', '.xml'],
          example: 'https://api.example.com/service.wsdl'
        }
      case ApiType.GRPC:
        return {
          icon: Server,
          title: 'Protocol Buffers Schema',
          description: 'Protocol Buffer definition file',
          formats: ['Proto'],
          extensions: ['.proto'],
          example: 'https://api.example.com/service.proto'
        }
      default:
        return {
          icon: FileText,
          title: 'API Schema',
          description: 'API schema or definition file',
          formats: ['JSON', 'XML', 'YAML'],
          extensions: ['.json', '.xml', '.yaml'],
          example: 'https://api.example.com/schema'
        }
    }
  }

  const schemaInfo = getSchemaInfo(apiType)
  const IconComponent = schemaInfo.icon

  if (apiQuery.isError) {
    return <QueryError error={apiQuery.error} onRetry={() => apiQuery.refetch()} title="Couldn't open that API" />
  }
  if (!api) {
    return (
      <div className="flex justify-center py-16">
        <LoadingSpinner />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <RouterLink
          to={`/apis/${id}`}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" />
          {api.name}
        </RouterLink>
      </div>

      <div>
        <h1 className={cn(DETAIL_TITLE_CLASSES, 'flex items-center gap-3')}>
          <IconComponent className="h-8 w-8" />
          Import {schemaInfo.title}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {schemaInfo.description}. The schema will be parsed to automatically generate operations and tools.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex gap-2">
            {schemaInfo.formats.map((format) => (
              <Badge key={format} variant="secondary">{format}</Badge>
            ))}
          </div>

          <Tabs value={importMethod} onValueChange={(value) => setImportMethod(value as any)}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="file" className="flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Upload file
              </TabsTrigger>
              <TabsTrigger value="url" className="flex items-center gap-2">
                <Link className="h-4 w-4" />
                From URL
              </TabsTrigger>
              <TabsTrigger value="paste" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Paste content
              </TabsTrigger>
            </TabsList>

            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
              <TabsContent value="file" className="space-y-4">
                <div>
                  <Label htmlFor="schemaFile">Schema File</Label>
                  <Input
                    id="schemaFile"
                    type="file"
                    accept={schemaInfo.extensions.join(',')}
                    onChange={handleFileChange}
                    className="mt-1"
                  />
                  {selectedFile && (
                    <p className="text-sm text-muted-foreground mt-1">
                      Selected: {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground mt-1">
                    Supported formats: {schemaInfo.extensions.join(', ')}
                  </p>
                </div>
              </TabsContent>

              <TabsContent value="url" className="space-y-4">
                <div>
                  <Label htmlFor="schemaUrl">Schema URL</Label>
                  <Input
                    id="schemaUrl"
                    type="url"
                    placeholder={schemaInfo.example}
                    {...form.register('schemaUrl')}
                    onChange={(e) => {
                      form.setValue('schemaUrl', e.target.value)
                      // Clear other methods
                      setSelectedFile(null)
                      form.setValue('schemaContent', '')
                    }}
                  />
                  {form.formState.errors.schemaUrl && (
                    <p className="text-sm text-destructive mt-1">
                      {form.formState.errors.schemaUrl.message}
                    </p>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="paste" className="space-y-4">
                <div>
                  <Label htmlFor="schemaContent">Schema Content</Label>
                  <Textarea
                    id="schemaContent"
                    placeholder={`Paste your ${schemaInfo.title.toLowerCase()} here...`}
                    rows={10}
                    {...form.register('schemaContent')}
                    onChange={(e) => {
                      form.setValue('schemaContent', e.target.value)
                      // Clear other methods
                      setSelectedFile(null)
                      form.setValue('schemaUrl', '')
                    }}
                  />
                  {form.formState.errors.schemaContent && (
                    <p className="text-sm text-destructive mt-1">
                      {form.formState.errors.schemaContent.message}
                    </p>
                  )}
                </div>
              </TabsContent>

              <div className="space-y-4 border-t pt-4">
                {/* General validation error message */}
                {(form.formState.errors.schemaContent || form.formState.errors.schemaUrl) && !selectedFile && (
                  <div role="alert" className="text-sm text-destructive bg-destructive/10 p-3 rounded-md">
                    {form.formState.errors.schemaContent?.message || form.formState.errors.schemaUrl?.message || 'Please provide a schema file, URL, or paste content'}
                  </div>
                )}

                <div>
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Input
                    id="description"
                    placeholder="Describe this schema import..."
                    {...form.register('description')}
                  />
                </div>

                <div className="flex items-center justify-between p-4 bg-muted rounded-lg">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4" />
                      <Label htmlFor="generateTools" className="font-medium">
                        Auto-generate Tools
                      </Label>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Automatically create AI tools from API operations
                    </p>
                  </div>
                  <Switch
                    id="generateTools"
                    checked={form.watch('generateTools') ?? true}
                    onCheckedChange={(checked) => form.setValue('generateTools', checked)}
                  />
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={leave}
                  disabled={isLoading}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isLoading}
                  className="min-w-32"
                >
                  {isLoading ? (
                    <>
                      <LoadingSpinner className="mr-2" />
                      Importing...
                    </>
                  ) : (
                    <>
                      <Upload className="mr-2 h-4 w-4" />
                      Import Schema
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
