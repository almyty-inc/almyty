import React, { useState, useMemo } from 'react'
import { UseFormReturn } from 'react-hook-form'
import { UseMutationResult } from '@tanstack/react-query'

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
}: CreateToolDialogProps) {
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
      <DialogContent className="max-w-2xl">
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
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {executionMethod === 'http' && 'Make HTTP/REST requests to any API endpoint'}
              {executionMethod === 'graphql' && 'Execute GraphQL queries and mutations'}
              {executionMethod === 'soap' && 'Call SOAP web services'}
              {executionMethod === 'grpc' && 'Invoke gRPC service methods'}
              {executionMethod === 'custom' && 'Write custom JavaScript code for transformations and logic'}
              {executionMethod === 'llm' && 'Prompt an LLM provider and return the response'}
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

          {/* Configuration based on execution method */}
          {executionMethod === 'http' && (
            <div className="space-y-3 border rounded-lg p-4 bg-muted/30">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label htmlFor="http-method">HTTP Method</Label>
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
                <div>
                  <Label htmlFor="http-url">URL</Label>
                  <Input id="http-url" value={httpConfig.url} onChange={(e) => onHttpConfigChange({ ...httpConfig, url: e.target.value })} placeholder="https://api.example.com/endpoint" />
                </div>
              </div>
              <div>
                <Label htmlFor="http-body">Request Body (JSON)</Label>
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

          {/* Authentication Configuration */}
          {executionMethod !== 'custom' && executionMethod !== 'llm' && (
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
                <div>
                  <Label htmlFor="auth-apikey">API Key</Label>
                  <Input id="auth-apikey" type="password" value={authConfig.apiKey} onChange={(e) => onAuthConfigChange({ ...authConfig, apiKey: e.target.value })} placeholder="your-api-key" />
                </div>
              )}

              {authConfig.type === 'bearer' && (
                <div>
                  <Label htmlFor="auth-bearer">Bearer Token</Label>
                  <Input id="auth-bearer" type="password" value={authConfig.bearerToken} onChange={(e) => onAuthConfigChange({ ...authConfig, bearerToken: e.target.value })} placeholder="eyJhbGc..." />
                </div>
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

          <div>
            <JsonSchemaBuilder
              value={toolParameters}
              onChange={onToolParametersChange}
            />
          </div>

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
