import React, { useState, useMemo, useEffect } from 'react'
import { UseFormReturn } from 'react-hook-form'
import { UseMutationResult, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { JsonSchemaBuilder } from '@/components/JsonSchemaBuilder'
import { CredentialPicker } from '@/components/credential-picker'
import { SdkToolForm } from '@/components/tools/sdk-tool-form'
import { apisApi } from '@/lib/api'
import { ApiType } from '@/types'
import type { SdkMap } from '@/types'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { autocompletion } from '@codemirror/autocomplete'
import { githubLight } from '@uiw/codemirror-theme-github'

interface CreateToolDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  createForm: UseFormReturn<any>
  createToolMutation: UseMutationResult<any, any, any, any>
  executionMethod: string
  onExecutionMethodChange: (value: string) => void
  toolParameters: any
  onToolParametersChange: (value: any) => void
  toolCode: string
  onToolCodeChange: (value: string) => void
  httpConfig: { method: string; url: string; headers: Record<string, string>; body: string }
  onHttpConfigChange: (value: any) => void
  graphqlConfig: { endpoint: string; query: string; variables: string }
  onGraphqlConfigChange: (value: any) => void
  soapConfig: { wsdlUrl: string; operation: string }
  onSoapConfigChange: (value: any) => void
  grpcConfig: { serviceUrl: string; method: string; protoFile: string }
  onGrpcConfigChange: (value: any) => void
  authConfig: { type: string; apiKey: string; bearerToken: string; username: string; password: string }
  onAuthConfigChange: (value: any) => void
  llmConfig: {
    providerId: string
    promptTemplate: string
    systemPrompt: string
    model: string
    maxTokens: number
    temperature: number
    outputMode: 'text' | 'json'
    outputSchema: string
  }
  onLlmConfigChange: (value: any) => void
  activeProviders: any[]
  availableApis?: any[]
  sdkConfig?: any
  onSdkConfigChange?: (value: any) => void
}

export function CreateToolDialog({
  open,
  onOpenChange,
  createForm,
  createToolMutation,
  executionMethod,
  onExecutionMethodChange,
  toolParameters,
  onToolParametersChange,
  toolCode,
  onToolCodeChange,
  httpConfig,
  onHttpConfigChange,
  graphqlConfig,
  onGraphqlConfigChange,
  soapConfig,
  onSoapConfigChange,
  grpcConfig,
  onGrpcConfigChange,
  authConfig,
  onAuthConfigChange,
  llmConfig,
  onLlmConfigChange,
  activeProviders,
  availableApis = [],
  sdkConfig,
  onSdkConfigChange,
}: CreateToolDialogProps) {
  // SDK tool state
  const [sdkApiId, setSdkApiId] = useState<string>('')
  const sdkApis = useMemo(() => availableApis.filter((api: any) => api.type === ApiType.SDK || api.type === 'sdk'), [availableApis])

  const { data: sdkMapsData, isLoading: sdkMapsLoading } = useQuery({
    queryKey: ['sdk-maps', sdkApiId],
    queryFn: () => apisApi.getSdkMaps(sdkApiId),
    enabled: !!sdkApiId && executionMethod === 'sdk',
  })

  const sdkMaps: Record<string, SdkMap> = useMemo(() => {
    if (!sdkMapsData) return {}
    // Backend may return an array or a record
    if (Array.isArray(sdkMapsData)) {
      const record: Record<string, SdkMap> = {}
      sdkMapsData.forEach((m: SdkMap) => { record[m.packageName] = m })
      return record
    }
    return sdkMapsData as Record<string, SdkMap>
  }, [sdkMapsData])

  // HTTP structured config local state
  const [selectedApiId, setSelectedApiId] = useState<string>('')
  const [bodyEncoding, setBodyEncoding] = useState<string>('json')
  const [responseMappingOpen, setResponseMappingOpen] = useState(false)
  const [responseMapping, setResponseMapping] = useState({ dataPath: '', errorPath: '', successCondition: '' })
  const [paginationOpen, setPaginationOpen] = useState(false)
  const [paginationType, setPaginationType] = useState<string>('none')
  const [paginationConfig, setPaginationConfig] = useState({ cursorPath: '', cursorParam: '', offsetParam: '', limitParam: '', defaultLimit: 20, maxPages: 5 })
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>([])

  // Create parameter autocomplete extension for CodeMirror
  const parameterAutocomplete = useMemo(() => {
    const paramNames = Object.keys(toolParameters.properties || {});
    return autocompletion({
      override: [
        (context) => {
          const word = context.matchBefore(/\w*/);
          if (!word || (word.from === word.to && !context.explicit)) return null;

          return {
            from: word.from,
            options: paramNames.map((name) => ({
              label: name,
              type: 'variable',
              detail: toolParameters.properties[name]?.type || 'parameter',
              info: toolParameters.properties[name]?.description || '',
            })),
          };
        },
      ],
    });
  }, [toolParameters])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Manual Tool</DialogTitle>
          <DialogDescription>
            Create a custom tool with JavaScript code or link to an API operation.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={createForm.handleSubmit((data: any) => createToolMutation.mutate(data))} className="space-y-4">
          <div>
            <Label htmlFor="execution-method">Execution Method</Label>
            <Select
              value={executionMethod}
              onValueChange={(value: any) => onExecutionMethodChange(value)}
            >
              <SelectTrigger id="execution-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP REST API</SelectItem>
                <SelectItem value="graphql">GraphQL</SelectItem>
                <SelectItem value="soap">SOAP</SelectItem>
                <SelectItem value="grpc">gRPC</SelectItem>
                <SelectItem value="custom">Custom JavaScript</SelectItem>
                <SelectItem value="llm">LLM Prompt</SelectItem>
                <SelectItem value="sdk">SDK / npm Package</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {executionMethod === 'http' && 'Make HTTP/REST requests to any API endpoint'}
              {executionMethod === 'graphql' && 'Execute GraphQL queries and mutations'}
              {executionMethod === 'soap' && 'Call SOAP web services'}
              {executionMethod === 'grpc' && 'Invoke gRPC service methods'}
              {executionMethod === 'custom' && 'Write custom JavaScript code for transformations and logic'}
              {executionMethod === 'llm' && 'Prompt an LLM provider and return the response'}
              {executionMethod === 'sdk' && 'Call methods on an npm package class (from an SDK API)'}
            </p>
          </div>
          <div>
            <Label htmlFor="tool-name">Tool Name</Label>
            <Input
              id="tool-name"
              placeholder="my_custom_tool"
              {...createForm.register('name')}
            />
            {createForm.formState.errors.name && (
              <p className="text-sm text-red-500 mt-1">{(createForm.formState.errors.name as any).message}</p>
            )}
          </div>

          <div>
            <Label htmlFor="tool-description">Description</Label>
            <Textarea
              id="tool-description"
              placeholder="What does this tool do?"
              {...createForm.register('description')}
            />
          </div>

          {/* HTTP REST API — Structured Config (no code generation) */}
          {executionMethod === 'http' && (
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
              {/* Link to API */}
              {availableApis.length > 0 && (
                <div>
                  <Label>Link to API (optional)</Label>
                  <Select value={selectedApiId} onValueChange={setSelectedApiId}>
                    <SelectTrigger><SelectValue placeholder="None - use full URL" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None - use full URL</SelectItem>
                      {availableApis.map((api: any) => (
                        <SelectItem key={api.id} value={api.id}>{api.name} ({api.baseUrl})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    {selectedApiId && selectedApiId !== 'none'
                      ? 'Path will be relative to the API base URL'
                      : 'Enter a full URL below'}
                  </p>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="http-method">Method</Label>
                  <Select value={httpConfig.method} onValueChange={(value) => onHttpConfigChange({ ...httpConfig, method: value })}>
                    <SelectTrigger id="http-method"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="GET">GET</SelectItem>
                      <SelectItem value="POST">POST</SelectItem>
                      <SelectItem value="PUT">PUT</SelectItem>
                      <SelectItem value="PATCH">PATCH</SelectItem>
                      <SelectItem value="DELETE">DELETE</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="col-span-2">
                  <Label htmlFor="http-path">
                    {selectedApiId && selectedApiId !== 'none' ? 'Path' : 'URL'}
                  </Label>
                  <Input
                    id="http-path"
                    value={httpConfig.url}
                    onChange={(e) => onHttpConfigChange({ ...httpConfig, url: e.target.value })}
                    placeholder={selectedApiId && selectedApiId !== 'none' ? '/users/{id}' : 'https://api.example.com/users/{id}'}
                  />
                </div>
              </div>

              {/* Body Encoding */}
              {['POST', 'PUT', 'PATCH'].includes(httpConfig.method) && (
                <>
                  <div>
                    <Label>Body Encoding</Label>
                    <Select value={bodyEncoding} onValueChange={setBodyEncoding}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="json">JSON</SelectItem>
                        <SelectItem value="form-urlencoded">Form URL-encoded</SelectItem>
                        <SelectItem value="multipart">Multipart</SelectItem>
                        <SelectItem value="raw">Raw</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Body Template</Label>
                    <CodeMirror theme={githubLight}
                      value={httpConfig.body}
                      height="100px"
                      extensions={[
                        json(),
                        autocompletion({
                          override: [
                            (context) => {
                              const word = context.matchBefore(/\{\w*/);
                              if (!word) return null;
                              const paramNames = Object.keys(toolParameters.properties || {});
                              return {
                                from: word.from,
                                options: paramNames.map((name) => ({
                                  label: `{${name}}`,
                                  type: 'variable',
                                  detail: 'parameter',
                                  apply: `{${name}}`,
                                })),
                              };
                            },
                          ],
                        }),
                      ]}
                      onChange={(value) => onHttpConfigChange({ ...httpConfig, body: value })}
                      className="border rounded-md"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Use <code>{'{paramName}'}</code> to inject parameters
                    </p>
                  </div>
                </>
              )}

              {/* Custom Headers */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>Custom Headers</Label>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setCustomHeaders([...customHeaders, { key: '', value: '' }])}
                  >
                    <Plus className="h-3 w-3 mr-1" />
                    Add
                  </Button>
                </div>
                {customHeaders.length === 0 && (
                  <p className="text-xs text-muted-foreground">No custom headers</p>
                )}
                {customHeaders.map((header, idx) => (
                  <div key={idx} className="flex items-center gap-2 mb-2">
                    <Input
                      placeholder="Header name"
                      value={header.key}
                      onChange={(e) => {
                        const updated = [...customHeaders]
                        updated[idx] = { ...updated[idx], key: e.target.value }
                        setCustomHeaders(updated)
                      }}
                      className="flex-1"
                    />
                    <Input
                      placeholder="Value"
                      value={header.value}
                      onChange={(e) => {
                        const updated = [...customHeaders]
                        updated[idx] = { ...updated[idx], value: e.target.value }
                        setCustomHeaders(updated)
                      }}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== idx))}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>

              {/* Response Mapping — collapsible */}
              <div className="border rounded-md">
                <button
                  type="button"
                  className="flex items-center justify-between w-full p-3 text-sm font-medium hover:bg-muted/50"
                  onClick={() => setResponseMappingOpen(!responseMappingOpen)}
                >
                  <span>Response Mapping</span>
                  {responseMappingOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                {responseMappingOpen && (
                  <div className="p-3 pt-0 space-y-2">
                    <div>
                      <Label className="text-xs">Data Path</Label>
                      <Input
                        value={responseMapping.dataPath}
                        onChange={(e) => setResponseMapping({ ...responseMapping, dataPath: e.target.value })}
                        placeholder="e.g. data.results, value"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Error Path</Label>
                      <Input
                        value={responseMapping.errorPath}
                        onChange={(e) => setResponseMapping({ ...responseMapping, errorPath: e.target.value })}
                        placeholder="e.g. error.message"
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Success Condition</Label>
                      <Input
                        value={responseMapping.successCondition}
                        onChange={(e) => setResponseMapping({ ...responseMapping, successCondition: e.target.value })}
                        placeholder="e.g. data.ok === true"
                        className="h-8 text-sm"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Pagination — collapsible */}
              <div className="border rounded-md">
                <button
                  type="button"
                  className="flex items-center justify-between w-full p-3 text-sm font-medium hover:bg-muted/50"
                  onClick={() => setPaginationOpen(!paginationOpen)}
                >
                  <span>Pagination</span>
                  {paginationOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </button>
                {paginationOpen && (
                  <div className="p-3 pt-0 space-y-2">
                    <div>
                      <Label className="text-xs">Type</Label>
                      <Select value={paginationType} onValueChange={setPaginationType}>
                        <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None</SelectItem>
                          <SelectItem value="cursor">Cursor</SelectItem>
                          <SelectItem value="offset">Offset</SelectItem>
                          <SelectItem value="link-header">Link Header</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {paginationType === 'cursor' && (
                      <>
                        <div>
                          <Label className="text-xs">Cursor Path</Label>
                          <Input
                            value={paginationConfig.cursorPath}
                            onChange={(e) => setPaginationConfig({ ...paginationConfig, cursorPath: e.target.value })}
                            placeholder="e.g. meta.next_cursor"
                            className="h-8 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Cursor Param</Label>
                          <Input
                            value={paginationConfig.cursorParam}
                            onChange={(e) => setPaginationConfig({ ...paginationConfig, cursorParam: e.target.value })}
                            placeholder="e.g. cursor"
                            className="h-8 text-sm"
                          />
                        </div>
                      </>
                    )}
                    {paginationType === 'offset' && (
                      <>
                        <div>
                          <Label className="text-xs">Offset Param</Label>
                          <Input
                            value={paginationConfig.offsetParam}
                            onChange={(e) => setPaginationConfig({ ...paginationConfig, offsetParam: e.target.value })}
                            placeholder="e.g. offset"
                            className="h-8 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Limit Param</Label>
                          <Input
                            value={paginationConfig.limitParam}
                            onChange={(e) => setPaginationConfig({ ...paginationConfig, limitParam: e.target.value })}
                            placeholder="e.g. limit"
                            className="h-8 text-sm"
                          />
                        </div>
                        <div>
                          <Label className="text-xs">Default Limit</Label>
                          <Input
                            type="number"
                            value={paginationConfig.defaultLimit}
                            onChange={(e) => setPaginationConfig({ ...paginationConfig, defaultLimit: parseInt(e.target.value) || 20 })}
                            className="h-8 text-sm"
                          />
                        </div>
                      </>
                    )}
                    {paginationType !== 'none' && (
                      <div>
                        <Label className="text-xs">Max Pages</Label>
                        <Input
                          type="number"
                          value={paginationConfig.maxPages}
                          onChange={(e) => setPaginationConfig({ ...paginationConfig, maxPages: parseInt(e.target.value) || 5 })}
                          className="h-8 text-sm"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {executionMethod === 'graphql' && (
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
              <div>
                <Label htmlFor="graphql-endpoint">GraphQL Endpoint</Label>
                <Input id="graphql-endpoint" value={graphqlConfig.endpoint} onChange={(e) => onGraphqlConfigChange({ ...graphqlConfig, endpoint: e.target.value })} placeholder="https://api.example.com/graphql" />
              </div>
              <div>
                <Label htmlFor="graphql-query">Query/Mutation</Label>
                <CodeMirror theme={githubLight} value={graphqlConfig.query} height="150px" onChange={(value) => onGraphqlConfigChange({ ...graphqlConfig, query: value })} className="border rounded-md font-mono" />
              </div>
              <div>
                <Label htmlFor="graphql-variables">Variables (JSON)</Label>
                <CodeMirror theme={githubLight}
                  value={graphqlConfig.variables}
                  height="80px"
                  extensions={[
                    json(),
                    autocompletion({
                      override: [
                        (context) => {
                          const word = context.matchBefore(/\{\w*/);
                          if (!word) return null;
                          const paramNames = Object.keys(toolParameters.properties || {});
                          return {
                            from: word.from,
                            options: paramNames.map((name) => ({
                              label: `{${name}}`,
                              type: 'variable',
                              detail: 'parameter',
                              apply: `{${name}}`,
                            })),
                          };
                        },
                      ],
                    }),
                  ]}
                  onChange={(value) => onGraphqlConfigChange({ ...graphqlConfig, variables: value })}
                  className="border rounded-md"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Use <code>{'{paramName}'}</code> to inject parameters
                </p>
              </div>
            </div>
          )}

          {executionMethod === 'soap' && (
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
              <div>
                <Label htmlFor="soap-wsdl">WSDL URL</Label>
                <Input id="soap-wsdl" value={soapConfig.wsdlUrl} onChange={(e) => onSoapConfigChange({ ...soapConfig, wsdlUrl: e.target.value })} placeholder="https://api.example.com/service?wsdl" />
              </div>
              <div>
                <Label htmlFor="soap-operation">Operation Name</Label>
                <Input id="soap-operation" value={soapConfig.operation} onChange={(e) => onSoapConfigChange({ ...soapConfig, operation: e.target.value })} placeholder="GetUserInfo" />
              </div>
            </div>
          )}

          {executionMethod === 'grpc' && (
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
              <div>
                <Label htmlFor="grpc-url">Service URL</Label>
                <Input id="grpc-url" value={grpcConfig.serviceUrl} onChange={(e) => onGrpcConfigChange({ ...grpcConfig, serviceUrl: e.target.value })} placeholder="grpc://api.example.com:50051" />
              </div>
              <div>
                <Label htmlFor="grpc-method">Method</Label>
                <Input id="grpc-method" value={grpcConfig.method} onChange={(e) => onGrpcConfigChange({ ...grpcConfig, method: e.target.value })} placeholder="UserService/GetUser" />
              </div>
              <div>
                <Label htmlFor="grpc-proto">Proto Definition</Label>
                <Textarea id="grpc-proto" value={grpcConfig.protoFile} onChange={(e) => onGrpcConfigChange({ ...grpcConfig, protoFile: e.target.value })} placeholder="syntax = proto3; ..." className="font-mono text-xs" rows={6} />
              </div>
            </div>
          )}

          {executionMethod === 'custom' && (
            <div>
              <Label>JavaScript Code</Label>
              <CodeMirror theme={githubLight}
                value={toolCode}
                height="300px"
                extensions={[
                  javascript(),
                  autocompletion({
                    override: [
                      (context) => {
                        const word = context.matchBefore(/\w+/);
                        if (!word) return null;
                        const paramNames = Object.keys(toolParameters.properties || {});
                        return {
                          from: word.from,
                          options: paramNames.map((name) => ({
                            label: name,
                            type: 'variable',
                            detail: toolParameters.properties[name]?.type,
                          })),
                        };
                      },
                    ],
                  }),
                ]}
                onChange={(value) => onToolCodeChange(value)}
                className="border rounded-md text-sm"
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLineGutter: true,
                  highlightSpecialChars: true,
                  foldGutter: false,
                  drawSelection: true,
                  dropCursor: true,
                  allowMultipleSelections: true,
                  indentOnInput: true,
                  bracketMatching: true,
                  closeBrackets: true,
                  autocompletion: true,
                  highlightActiveLine: true,
                }}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Access via <code className="bg-muted px-1 rounded">params.name</code> or directly as <code className="bg-muted px-1 rounded">name</code>. Available: <code className="bg-muted px-1 rounded">{Object.keys(toolParameters.properties || {}).join(', ') || 'none - add below'}</code>
              </p>
            </div>
          )}

          {executionMethod === 'llm' && (
            <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
              <Label className="text-base font-semibold">LLM Configuration</Label>

              <div>
                <Label>Provider</Label>
                <Select value={llmConfig.providerId} onValueChange={(v) => onLlmConfigChange({ ...llmConfig, providerId: v })}>
                  <SelectTrigger><SelectValue placeholder="Select LLM provider..." /></SelectTrigger>
                  <SelectContent>
                    {activeProviders.map((p: any) => (
                      <SelectItem key={p.id} value={p.id}>{p.name} ({p.provider})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>System Prompt (optional)</Label>
                <Textarea
                  placeholder="You are a helpful assistant that..."
                  value={llmConfig.systemPrompt}
                  onChange={(e) => onLlmConfigChange({ ...llmConfig, systemPrompt: e.target.value })}
                  rows={2}
                />
              </div>

              <div>
                <Label>Prompt Template</Label>
                <Textarea
                  placeholder="Analyze the following data: {{input}}&#10;&#10;Use {{parameter}} placeholders for tool parameters."
                  value={llmConfig.promptTemplate}
                  onChange={(e) => onLlmConfigChange({ ...llmConfig, promptTemplate: e.target.value })}
                  rows={4}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Use <code className="bg-muted px-1 rounded">{'{{paramName}}'}</code> to inject parameters. Available: {Object.keys(toolParameters.properties || {}).map(k => `{{${k}}}`).join(', ') || 'add parameters below'}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Output Mode</Label>
                  <Select value={llmConfig.outputMode} onValueChange={(v: 'text' | 'json') => onLlmConfigChange({ ...llmConfig, outputMode: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Raw Text</SelectItem>
                      <SelectItem value="json">Structured JSON</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Model Override (optional)</Label>
                  <Input
                    placeholder="e.g. gpt-4o"
                    value={llmConfig.model}
                    onChange={(e) => onLlmConfigChange({ ...llmConfig, model: e.target.value })}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Temperature ({llmConfig.temperature})</Label>
                  <Input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={llmConfig.temperature}
                    onChange={(e) => onLlmConfigChange({ ...llmConfig, temperature: parseFloat(e.target.value) })}
                  />
                </div>
                <div>
                  <Label>Max Tokens</Label>
                  <Input
                    type="number"
                    value={llmConfig.maxTokens}
                    onChange={(e) => onLlmConfigChange({ ...llmConfig, maxTokens: parseInt(e.target.value) || 1024 })}
                  />
                </div>
              </div>

              {llmConfig.outputMode === 'json' && (
                <div>
                  <Label>Output JSON Schema</Label>
                  <Textarea
                    placeholder={'{\n  "type": "object",\n  "properties": {\n    "summary": { "type": "string" }\n  }\n}'}
                    value={llmConfig.outputSchema}
                    onChange={(e) => onLlmConfigChange({ ...llmConfig, outputSchema: e.target.value })}
                    rows={5}
                    className="font-mono text-sm"
                  />
                </div>
              )}
            </div>
          )}

          {/* SDK Tool Configuration */}
          {executionMethod === 'sdk' && (
            <div className="space-y-4 border rounded-lg p-4 bg-muted/30">
              <Label className="text-base font-semibold">SDK Configuration</Label>

              <div>
                <Label>SDK API</Label>
                <Select value={sdkApiId} onValueChange={setSdkApiId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select an SDK API..." />
                  </SelectTrigger>
                  <SelectContent>
                    {sdkApis.length === 0 ? (
                      <SelectItem value="__none" disabled>No SDK APIs found - create one first</SelectItem>
                    ) : (
                      sdkApis.map((api: any) => (
                        <SelectItem key={api.id} value={api.id}>{api.name}</SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>

              {sdkApiId && sdkMapsLoading && (
                <div className="text-sm text-muted-foreground py-4 text-center">Loading SDK maps...</div>
              )}

              {sdkApiId && !sdkMapsLoading && (
                <SdkToolForm
                  sdkMaps={sdkMaps}
                  onConfigChange={(config) => onSdkConfigChange?.(config)}
                  onParamsChange={(params) => onToolParametersChange(params)}
                />
              )}
            </div>
          )}

          {/* Authentication Configuration */}
          {executionMethod !== 'custom' && executionMethod !== 'llm' && executionMethod !== 'sdk' && (
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
              <Label>Authentication</Label>
              <Select value={authConfig.type} onValueChange={(value) => onAuthConfigChange({ ...authConfig, type: value })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Authentication</SelectItem>
                  <SelectItem value="apiKey">API Key</SelectItem>
                  <SelectItem value="bearer">Bearer Token</SelectItem>
                  <SelectItem value="basic">Basic Auth</SelectItem>
                </SelectContent>
              </Select>

              {authConfig.type === 'apiKey' && (
                <CredentialPicker
                  label="API Key"
                  value={(authConfig as any).credentialId || ''}
                  onSelect={(id) => onAuthConfigChange({ ...authConfig, credentialId: id })}
                  onNewKey={(key) => onAuthConfigChange({ ...authConfig, apiKey: key })}
                  newKeyValue={authConfig.apiKey || ''}
                  filterType="api_key"
                />
              )}

              {authConfig.type === 'bearer' && (
                <CredentialPicker
                  label="Bearer Token"
                  value={(authConfig as any).credentialId || ''}
                  onSelect={(id) => onAuthConfigChange({ ...authConfig, credentialId: id })}
                  onNewKey={(key) => onAuthConfigChange({ ...authConfig, bearerToken: key })}
                  newKeyValue={authConfig.bearerToken || ''}
                  placeholder="eyJhbGc..."
                  filterType="bearer_token"
                />
              )}

              {authConfig.type === 'basic' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="auth-username">Username</Label>
                    <Input id="auth-username" value={authConfig.username} onChange={(e) => onAuthConfigChange({ ...authConfig, username: e.target.value })} placeholder="username" />
                  </div>
                  <div>
                    <Label htmlFor="auth-password">Password</Label>
                    <Input id="auth-password" type="password" value={authConfig.password} onChange={(e) => onAuthConfigChange({ ...authConfig, password: e.target.value })} placeholder="password" />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* SDK tools auto-generate parameters; other methods use the builder */}
          {executionMethod !== 'sdk' && (
            <div>
              <JsonSchemaBuilder
                value={toolParameters}
                onChange={onToolParametersChange}
              />
            </div>
          )}

          <div className="flex justify-end space-x-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={createToolMutation.isPending}>
              {createToolMutation.isPending ? 'Creating...' : 'Create Tool'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
