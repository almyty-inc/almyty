import React, { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Upload, FileCode, Database, Cloud, Server, FileText, Link, Zap } from 'lucide-react'

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { ApiType } from '@/types'

const importSchemaSchema = z.object({
  schemaContent: z.string().optional(),
  schemaUrl: z.string().url().optional(),
  description: z.string().optional(),
  generateTools: z.boolean().optional(),
}).refine((data) => data.schemaContent || data.schemaUrl, {
  message: "Either schema content or URL must be provided",
  path: ["schemaContent"],
})

type ImportSchemaFormData = z.infer<typeof importSchemaSchema>

interface SchemaImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  apiType: ApiType
  onImport: (data: ImportSchemaFormData, file?: File) => void
  isLoading?: boolean
}

export function SchemaImportDialog({ 
  open, 
  onOpenChange, 
  apiType, 
  onImport, 
  isLoading = false 
}: SchemaImportDialogProps) {
  const [importMethod, setImportMethod] = useState<'file' | 'url' | 'paste'>('file')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  
  const form = useForm<ImportSchemaFormData>({
    resolver: zodResolver(importSchemaSchema),
    defaultValues: {
      generateTools: true,
    },
  })

  const handleSubmit = (data: ImportSchemaFormData) => {
    onImport(data, selectedFile || undefined)
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
      case ApiType.PROTOBUF:
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IconComponent className="h-5 w-5" />
            Import {schemaInfo.title}
          </DialogTitle>
          <DialogDescription>
            {schemaInfo.description}. The schema will be parsed to automatically generate operations and tools.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex gap-2">
            {schemaInfo.formats.map((format) => (
              <Badge key={format} variant="secondary">{format}</Badge>
            ))}
          </div>

          <Tabs value={importMethod} onValueChange={(value) => setImportMethod(value as any)}>
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="file" className="flex items-center gap-2">
                <Upload className="h-4 w-4" />
                Upload File
              </TabsTrigger>
              <TabsTrigger value="url" className="flex items-center gap-2">
                <Link className="h-4 w-4" />
                From URL
              </TabsTrigger>
              <TabsTrigger value="paste" className="flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Paste Content
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
                  variant="outline"
                  onClick={() => onOpenChange(false)}
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
        </div>
      </DialogContent>
    </Dialog>
  )
}