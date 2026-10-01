/**
 * tools/tool-form -- the Create tool page body (`/tools/new`).
 *
 * A hand-built tool: HTTP request, GraphQL, SOAP, gRPC, custom
 * JavaScript, a model prompt, or a method on an SDK package. The
 * execution method is in the URL (`?type=http`), so a refresh or a shared
 * link keeps the same form. After creating, the tool's own page opens.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react'
import CodeMirror from '@uiw/react-codemirror'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { githubLight } from '@uiw/codemirror-theme-github'

import { Field, FormPage, FormSection } from '@/components/layout/form-page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SecretInput } from '@/components/ui/secret-input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { JsonSchemaBuilder } from '@/components/JsonSchemaBuilder'
import { OTHER_SERVICE_KEY } from '@/components/connections/connect-flow'
import { CredentialPicker } from '@/components/credentials/credential-picker'
import { SdkToolForm } from '@/components/tools/sdk-tool-form'
import { VisibilityField, type VisibilityValue } from '@/components/ui/visibility-field'
import { ModelPicker } from '@/components/model-picker'
import { useLeaveGuard } from '@/hooks/use-leave-guard'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { apisApi, toolsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { ApiType } from '@/types'
import type { SdkMap } from '@/types'

import { createToolSchema, type CreateToolForm } from './schema'
import {
  isProtocolMethod,
  protocolConfigPayload,
  protocolProblems,
  type GraphqlFormState,
  type GrpcFormState,
  type SoapFormState,
} from './protocol-config'

export const EXECUTION_METHODS = ['http', 'graphql', 'soap', 'grpc', 'custom', 'llm', 'sdk'] as const
export type ExecutionMethod = (typeof EXECUTION_METHODS)[number]

const METHOD_HINTS: Record<ExecutionMethod, string> = {
  http: 'Make HTTP/REST requests to any API endpoint.',
  graphql: 'Run one GraphQL query or mutation against an endpoint.',
  soap: 'Call one operation on a SOAP web service.',
  grpc: 'Call one method on a gRPC service, described by its .proto.',
  custom: 'Write custom JavaScript code for transformations and logic.',
  llm: 'Prompt a model and return the response.',
  sdk: 'Call methods on an npm package class (from an SDK API).',
}

const EMPTY_PARAMETERS = { type: 'object', properties: {} }

/** `{param}` completions inside a JSON template. */
function braceParamCompletion(paramNames: () => string[]) {
  return autocompletion({
    override: [
      (context: CompletionContext) => {
        const word = context.matchBefore(/\{\w*/)
        if (!word) return null
        return {
          from: word.from,
          options: paramNames().map((name) => ({
            label: `{${name}}`,
            type: 'variable',
            detail: 'parameter',
            apply: `{${name}}`,
          })),
        }
      },
    ],
  })
}

function isExecutionMethod(v: string | null): v is ExecutionMethod {
  return !!v && (EXECUTION_METHODS as readonly string[]).includes(v)
}

export function ToolForm() {
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const { currentOrganization } = useOrganizationStore()
  const [searchParams, setSearchParams] = useSearchParams()
  const typeParam = searchParams.get('type')
  const executionMethod: ExecutionMethod = isExecutionMethod(typeParam) ? typeParam : 'http'
  const setExecutionMethod = (next: string) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('type', next)
        return params
      },
      { replace: true },
    )

  const createForm = useForm<CreateToolForm>({
    resolver: zodResolver(createToolSchema),
    defaultValues: { name: '', description: '' },
  })
  const { errors } = createForm.formState

  const [toolParameters, setToolParameters] = useState<any>(EMPTY_PARAMETERS)
  const [toolCode, setToolCode] = useState('')
  const [sdkConfig, setSdkConfig] = useState<any>(null)
  const [sdkApiId, setSdkApiId] = useState<string>('')
  const [llmConfig, setLlmConfig] = useState({
    providerId: '',
    promptTemplate: '',
    systemPrompt: '',
    model: '',
    maxTokens: 1024,
    temperature: 0.7,
    outputMode: 'text' as 'text' | 'json',
    outputSchema: '',
  })
  const [outputSchemaError, setOutputSchemaError] = useState<string | undefined>()
  const [httpConfig, setHttpConfig] = useState({ method: 'GET', url: '', body: '' })
  const [graphqlConfig, setGraphqlConfig] = useState<GraphqlFormState>({ endpoint: '', query: '', variables: '' })
  const [soapConfig, setSoapConfig] = useState<SoapFormState>({ endpoint: '', operation: '', namespace: '', soapAction: '' })
  const [grpcConfig, setGrpcConfig] = useState<GrpcFormState>({ endpoint: '', serviceName: '', methodName: '', protoDefinition: '' })
  // Per-field messages for the GraphQL/SOAP/gRPC sections, keyed by field id.
  const [protocolErrors, setProtocolErrors] = useState<Record<string, string>>({})
  // How the tool signs its calls; the secret is always a credential it points at.
  const [authConfig, setAuthConfig] = useState<{ type: string; credentialId?: string }>({ type: 'none' })

  // HTTP structured config
  const [selectedApiId, setSelectedApiId] = useState<string>('')
  const [bodyEncoding, setBodyEncoding] = useState<string>('json')
  const [responseMappingOpen, setResponseMappingOpen] = useState(false)
  const [responseMapping, setResponseMapping] = useState({ dataPath: '', errorPath: '', successCondition: '' })
  const [paginationOpen, setPaginationOpen] = useState(false)
  const [paginationType, setPaginationType] = useState<string>('none')
  const [paginationConfig, setPaginationConfig] = useState({ cursorPath: '', cursorParam: '', offsetParam: '', limitParam: '', defaultLimit: 20, maxPages: 5 })
  const [customHeaders, setCustomHeaders] = useState<Array<{ key: string; value: string }>>([])
  const [visibility, setVisibility] = useState<VisibilityValue>({ visibility: 'org', teamId: null })

  const snapshot = JSON.stringify({
    toolParameters, toolCode, sdkConfig, sdkApiId, llmConfig, httpConfig, graphqlConfig, soapConfig,
    grpcConfig, authConfig, selectedApiId, responseMapping, paginationType, customHeaders, visibility,
  })
  const [initialSnapshot] = useState(snapshot)
  const guard = useLeaveGuard(createForm.formState.isDirty || snapshot !== initialSnapshot)

  // Available APIs, for linking an HTTP tool and for picking an SDK API.
  const { data: apisData } = useQuery({
    queryKey: ['apis', currentOrganization?.id],
    queryFn: () => apisApi.getAll(),
    enabled: !!currentOrganization,
  })
  const apisExtracted = (apisData as any)?.apis || apisData || []
  const availableApis: any[] = Array.isArray(apisExtracted) ? apisExtracted : []
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

  const paramNames = () => Object.keys(toolParameters.properties || {})
  const linkedApi = selectedApiId && selectedApiId !== 'none'

  const createToolMutation = useMutation({
    mutationFn: (data: any) => {
      // Custom JavaScript: the user's own code, no generation.
      const code: string | undefined = executionMethod === 'custom' ? toolCode : undefined

      // Auto-assign tool type based on execution method
      let type = 'function'
      if (executionMethod === 'http') {
        type = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(httpConfig.method) ? 'action' : 'query'
      } else if (executionMethod === 'graphql') {
        type = graphqlConfig.query.trim().startsWith('mutation') ? 'mutation' : 'query'
      }

      let llmConfigPayload = undefined
      if (executionMethod === 'llm') {
        llmConfigPayload = {
          providerId: llmConfig.providerId,
          promptTemplate: llmConfig.promptTemplate,
          systemPrompt: llmConfig.systemPrompt || undefined,
          model: llmConfig.model || undefined,
          maxTokens: llmConfig.maxTokens,
          temperature: llmConfig.temperature,
          outputMode: llmConfig.outputMode,
          outputSchema: llmConfig.outputMode === 'json' && llmConfig.outputSchema
            ? JSON.parse(llmConfig.outputSchema)
            : undefined,
        }
      }

      // Structured HTTP config, no code. Headers, body encoding, response
      // mapping and pagination were collected by the old dialog and then
      // dropped; the backend's HttpConfig takes all of them.
      let httpConfigPayload = undefined
      if (executionMethod === 'http') {
        const headers = Object.fromEntries(
          customHeaders.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value]),
        )
        const hasBody = ['POST', 'PUT', 'PATCH'].includes(httpConfig.method)
        const mapping = Object.fromEntries(
          Object.entries(responseMapping).filter(([, v]) => v.trim() !== ''),
        )
        httpConfigPayload = {
          method: httpConfig.method,
          path: httpConfig.url,
          bodyEncoding: hasBody ? bodyEncoding : undefined,
          bodyTemplate: hasBody ? httpConfig.body || undefined : undefined,
          headers: Object.keys(headers).length > 0 ? headers : undefined,
          responseMapping: Object.keys(mapping).length > 0 ? mapping : undefined,
          pagination:
            paginationType !== 'none'
              ? {
                  type: paginationType,
                  ...(paginationType === 'cursor'
                    ? { cursorPath: paginationConfig.cursorPath || undefined, cursorParam: paginationConfig.cursorParam || undefined }
                    : {}),
                  ...(paginationType === 'offset'
                    ? {
                        offsetParam: paginationConfig.offsetParam || undefined,
                        limitParam: paginationConfig.limitParam || undefined,
                        defaultLimit: paginationConfig.defaultLimit,
                      }
                    : {}),
                  maxPages: paginationConfig.maxPages,
                }
              : undefined,
        }
      }

      // The backend stores auth nested (`{ type, config }`), while the
      // form holds it flat, hence the reshape. A key, token or username and
      // password is a credential the tool points at (picked or created in
      // the form, so it lives on the Credentials page); none is typed here.
      const inlineAuth =
        authConfig.type === 'none' || !authConfig.credentialId
          ? null
          : authConfig.type === 'apiKey'
            ? { type: 'apiKey', config: { credentialId: authConfig.credentialId, headerName: 'X-API-Key' } }
            : { type: authConfig.type, config: { credentialId: authConfig.credentialId } }

      const payload: any = {
        ...data,
        type,
        parameters: toolParameters,
        executionMethod,
        llmConfig: llmConfigPayload,
        ...(inlineAuth ? { authConfig: inlineAuth } : {}),
      }

      if (executionMethod === 'http') {
        payload.httpConfig = httpConfigPayload
      } else if (executionMethod === 'sdk') {
        payload.sdkConfig = sdkConfig
      } else if (isProtocolMethod(executionMethod)) {
        // A GraphQL, SOAP or gRPC tool is stored as its protocol's config,
        // which the backend's protocol executor runs. Never as generated
        // code: the sandbox has no GraphQL, SOAP or gRPC client to run it.
        Object.assign(payload, protocolConfigPayload(executionMethod, { graphqlConfig, soapConfig, grpcConfig }))
      } else {
        payload.code = code
      }

      return toolsApi.create(payload, currentOrganization?.id)
    },
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      notifications.success('Tool created', 'It is ready to assign to a gateway.')
      guard.leave(created?.id ? `/tools/${created.id}` : '/tools')
    },
    onError: (error: any) => {
      notifications.error('Error', getApiErrorMessage(error, 'Failed to create tool'))
    },
  })

  const onSubmit = createForm.handleSubmit((data) => {
    if (executionMethod === 'llm' && llmConfig.outputMode === 'json' && llmConfig.outputSchema.trim()) {
      try {
        JSON.parse(llmConfig.outputSchema)
      } catch {
        setOutputSchemaError('The output schema is not valid JSON.')
        return
      }
    }
    setOutputSchemaError(undefined)
    const problems = protocolProblems(executionMethod, { graphqlConfig, soapConfig, grpcConfig })
    setProtocolErrors(problems)
    if (Object.keys(problems).length > 0) return
    // selectedApiId used to be local state whose only effects were the
    // field label and helper text, so a "linked" tool saved apiId null and
    // its relative path failed at execution. It is sent now.
    createToolMutation.mutate({
      ...data,
      visibility: visibility.visibility,
      teamId: visibility.teamId,
      apiId: executionMethod === 'http' && linkedApi ? selectedApiId : undefined,
    })
  })

  return (
    <FormPage
      title="Create tool"
      description="Create a custom tool with JavaScript code or link it to an API operation."
      back={{ to: '/tools', label: 'Tools' }}
      guard={guard}
      onSubmit={onSubmit}
      submitLabel="Create tool"
      submitting={createToolMutation.isPending}
      width="wide"
    >
      <FormSection title="Tool">
        <Field id="execution-method" label="Execution method" hint={METHOD_HINTS[executionMethod]}>
          <Select value={executionMethod} onValueChange={setExecutionMethod}>
            <SelectTrigger id="execution-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="http">HTTP REST API</SelectItem>
              <SelectItem value="graphql">GraphQL</SelectItem>
              <SelectItem value="soap">SOAP</SelectItem>
              <SelectItem value="grpc">gRPC</SelectItem>
              <SelectItem value="custom">Custom JavaScript</SelectItem>
              <SelectItem value="llm">Model prompt</SelectItem>
              <SelectItem value="sdk">SDK / npm package</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field id="tool-name" label="Tool name" error={errors.name?.message} required>
          <Input placeholder="my_custom_tool" {...createForm.register('name')} />
        </Field>
        <Field id="tool-description" label="Description" error={errors.description?.message}>
          <Textarea placeholder="What does this tool do?" {...createForm.register('description')} />
        </Field>
      </FormSection>

      {executionMethod === 'http' && (
        <FormSection title="HTTP request">
          {availableApis.length > 0 && (
            <Field
              id="tool-link-to-api"
              label="Link to API (optional)"
              hint={linkedApi ? 'The path is relative to the API base URL.' : 'Enter a full URL below.'}
            >
              <Select value={selectedApiId} onValueChange={setSelectedApiId}>
                <SelectTrigger id="tool-link-to-api"><SelectValue placeholder="None - use full URL" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None - use full URL</SelectItem>
                  {availableApis.map((api: any) => (
                    <SelectItem key={api.id} value={api.id}>{api.name} ({api.baseUrl})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field id="http-method" label="Method">
              <Select value={httpConfig.method} onValueChange={(value) => setHttpConfig({ ...httpConfig, method: value })}>
                <SelectTrigger id="http-method"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="GET">GET</SelectItem>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="PUT">PUT</SelectItem>
                  <SelectItem value="PATCH">PATCH</SelectItem>
                  <SelectItem value="DELETE">DELETE</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="http-path" label={linkedApi ? 'Path' : 'URL'} className="sm:col-span-2">
              <Input
                value={httpConfig.url}
                onChange={(e) => setHttpConfig({ ...httpConfig, url: e.target.value })}
                placeholder={linkedApi ? '/users/{id}' : 'https://api.example.com/users/{id}'}
              />
            </Field>
          </div>

          {['POST', 'PUT', 'PATCH'].includes(httpConfig.method) && (
            <>
              <Field id="tool-body-encoding" label="Body encoding">
                <Select value={bodyEncoding} onValueChange={setBodyEncoding}>
                  <SelectTrigger id="tool-body-encoding"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="json">JSON</SelectItem>
                    <SelectItem value="form-urlencoded">Form URL-encoded</SelectItem>
                    <SelectItem value="multipart">Multipart</SelectItem>
                    <SelectItem value="raw">Raw</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <div className="space-y-1.5">
                <Label>Body template</Label>
                <CodeMirror
                  theme={githubLight}
                  value={httpConfig.body}
                  height="100px"
                  extensions={[json(), braceParamCompletion(paramNames)]}
                  onChange={(value) => setHttpConfig({ ...httpConfig, body: value })}
                  className="rounded-md border"
                />
                <p className="text-xs text-muted-foreground">
                  Use <code>{'{paramName}'}</code> to inject parameters.
                </p>
              </div>
            </>
          )}

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Custom headers</Label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setCustomHeaders([...customHeaders, { key: '', value: '' }])}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
            {customHeaders.length === 0 && (
              <p className="text-xs text-muted-foreground">No custom headers</p>
            )}
            {customHeaders.map((header, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  aria-label={`Header ${idx + 1} name`}
                  placeholder="Header name"
                  value={header.key}
                  onChange={(e) => {
                    const updated = [...customHeaders]
                    updated[idx] = { ...updated[idx], key: e.target.value }
                    setCustomHeaders(updated)
                  }}
                  className="min-w-0 flex-1"
                />
                <SecretInput
                  masked={false}
                  aria-label={`Header ${idx + 1} value`}
                  placeholder="Value"
                  value={header.value}
                  onChange={(e) => {
                    const updated = [...customHeaders]
                    updated[idx] = { ...updated[idx], value: e.target.value }
                    setCustomHeaders(updated)
                  }}
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Remove header"
                  onClick={() => setCustomHeaders(customHeaders.filter((_, i) => i !== idx))}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>

          <div className="rounded-md border">
            <button
              type="button"
              className="flex w-full items-center justify-between p-3 text-sm font-medium hover:bg-muted/50"
              aria-expanded={responseMappingOpen}
              onClick={() => setResponseMappingOpen(!responseMappingOpen)}
            >
              <span>Response mapping</span>
              {responseMappingOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {responseMappingOpen && (
              <div className="grid grid-cols-1 gap-3 p-3 pt-0 sm:grid-cols-3">
                <Field id="tool-data-path" label="Data path">
                  <Input
                    value={responseMapping.dataPath}
                    onChange={(e) => setResponseMapping({ ...responseMapping, dataPath: e.target.value })}
                    placeholder="e.g. data.results, value"
                  />
                </Field>
                <Field id="tool-error-path" label="Error path">
                  <Input
                    value={responseMapping.errorPath}
                    onChange={(e) => setResponseMapping({ ...responseMapping, errorPath: e.target.value })}
                    placeholder="e.g. error.message"
                  />
                </Field>
                <Field id="tool-success-condition" label="Success condition">
                  <Input
                    value={responseMapping.successCondition}
                    onChange={(e) => setResponseMapping({ ...responseMapping, successCondition: e.target.value })}
                    placeholder="e.g. data.ok === true"
                  />
                </Field>
              </div>
            )}
          </div>

          <div className="rounded-md border">
            <button
              type="button"
              className="flex w-full items-center justify-between p-3 text-sm font-medium hover:bg-muted/50"
              aria-expanded={paginationOpen}
              onClick={() => setPaginationOpen(!paginationOpen)}
            >
              <span>Pagination</span>
              {paginationOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            {paginationOpen && (
              <div className="grid grid-cols-1 gap-3 p-3 pt-0 sm:grid-cols-2">
                <Field id="tool-pagination-type" label="Type">
                  <Select value={paginationType} onValueChange={setPaginationType}>
                    <SelectTrigger id="tool-pagination-type"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="cursor">Cursor</SelectItem>
                      <SelectItem value="offset">Offset</SelectItem>
                      <SelectItem value="link-header">Link header</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                {paginationType === 'cursor' && (
                  <>
                    <Field id="tool-cursor-path" label="Cursor path">
                      <Input
                        value={paginationConfig.cursorPath}
                        onChange={(e) => setPaginationConfig({ ...paginationConfig, cursorPath: e.target.value })}
                        placeholder="e.g. meta.next_cursor"
                      />
                    </Field>
                    <Field id="tool-cursor-param" label="Cursor param">
                      <Input
                        value={paginationConfig.cursorParam}
                        onChange={(e) => setPaginationConfig({ ...paginationConfig, cursorParam: e.target.value })}
                        placeholder="e.g. cursor"
                      />
                    </Field>
                  </>
                )}
                {paginationType === 'offset' && (
                  <>
                    <Field id="tool-offset-param" label="Offset param">
                      <Input
                        value={paginationConfig.offsetParam}
                        onChange={(e) => setPaginationConfig({ ...paginationConfig, offsetParam: e.target.value })}
                        placeholder="e.g. offset"
                      />
                    </Field>
                    <Field id="tool-limit-param" label="Limit param">
                      <Input
                        value={paginationConfig.limitParam}
                        onChange={(e) => setPaginationConfig({ ...paginationConfig, limitParam: e.target.value })}
                        placeholder="e.g. limit"
                      />
                    </Field>
                    <Field id="tool-default-limit" label="Default limit">
                      <Input
                        type="number"
                        value={paginationConfig.defaultLimit}
                        onChange={(e) => setPaginationConfig({ ...paginationConfig, defaultLimit: parseInt(e.target.value) || 20 })}
                      />
                    </Field>
                  </>
                )}
                {paginationType !== 'none' && (
                  <Field id="tool-max-pages" label="Max pages">
                    <Input
                      type="number"
                      value={paginationConfig.maxPages}
                      onChange={(e) => setPaginationConfig({ ...paginationConfig, maxPages: parseInt(e.target.value) || 5 })}
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        </FormSection>
      )}

      {executionMethod === 'graphql' && (
        <FormSection title="GraphQL">
          <Field
            id="graphql-endpoint"
            label="GraphQL endpoint"
            required
            error={protocolErrors['graphql-endpoint']}
            hint="The URL the query is posted to."
          >
            <Input value={graphqlConfig.endpoint} onChange={(e) => setGraphqlConfig({ ...graphqlConfig, endpoint: e.target.value })} placeholder="https://api.example.com/graphql" />
          </Field>
          <div className="space-y-1.5">
            <Label>Query or mutation</Label>
            <CodeMirror
              aria-label="GraphQL query"
              theme={githubLight}
              value={graphqlConfig.query}
              height="150px"
              onChange={(value) => setGraphqlConfig({ ...graphqlConfig, query: value })}
              className="rounded-md border font-mono"
            />
            {protocolErrors['graphql-query'] && (
              <p className="text-xs text-destructive">{protocolErrors['graphql-query']}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Variables (JSON, optional)</Label>
            <CodeMirror
              aria-label="GraphQL variables"
              theme={githubLight}
              value={graphqlConfig.variables}
              height="80px"
              extensions={[json(), braceParamCompletion(paramNames)]}
              onChange={(value) => setGraphqlConfig({ ...graphqlConfig, variables: value })}
              className="rounded-md border"
            />
            {protocolErrors['graphql-variables'] ? (
              <p className="text-xs text-destructive">{protocolErrors['graphql-variables']}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Map each query variable to a parameter, e.g. <code>{'{ "id": "{userId}" }'}</code>. Leave empty to send the
                parameters as the variables.
              </p>
            )}
          </div>
        </FormSection>
      )}

      {executionMethod === 'soap' && (
        <FormSection title="SOAP">
          <Field
            id="soap-endpoint"
            label="Service URL"
            required
            error={protocolErrors['soap-endpoint']}
            hint="Where the request is posted: usually the WSDL address without ?wsdl."
          >
            <Input value={soapConfig.endpoint} onChange={(e) => setSoapConfig({ ...soapConfig, endpoint: e.target.value })} placeholder="https://api.example.com/TempConvert.asmx" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="soap-operation" label="Operation" required error={protocolErrors['soap-operation']}>
              <Input value={soapConfig.operation} onChange={(e) => setSoapConfig({ ...soapConfig, operation: e.target.value })} placeholder="CelsiusToFahrenheit" />
            </Field>
            <Field id="soap-namespace" label="Namespace" hint="The service's targetNamespace, from the WSDL.">
              <Input value={soapConfig.namespace} onChange={(e) => setSoapConfig({ ...soapConfig, namespace: e.target.value })} placeholder="https://www.w3schools.com/xml/" />
            </Field>
          </div>
          <Field id="soap-action" label="SOAPAction (optional)" hint="Defaults to the namespace followed by the operation name.">
            <Input value={soapConfig.soapAction} onChange={(e) => setSoapConfig({ ...soapConfig, soapAction: e.target.value })} />
          </Field>
          <p className="text-xs text-muted-foreground">
            Each parameter below becomes an element inside the operation, so name them as the WSDL does.
          </p>
        </FormSection>
      )}

      {executionMethod === 'grpc' && (
        <FormSection title="gRPC">
          <Field
            id="grpc-endpoint"
            label="Server address"
            required
            error={protocolErrors['grpc-endpoint']}
            hint="https:// for a TLS server, http:// for a plaintext one, with the port."
          >
            <Input value={grpcConfig.endpoint} onChange={(e) => setGrpcConfig({ ...grpcConfig, endpoint: e.target.value })} placeholder="https://api.example.com:443" />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field id="grpc-service" label="Service" required error={protocolErrors['grpc-service']}>
              <Input value={grpcConfig.serviceName} onChange={(e) => setGrpcConfig({ ...grpcConfig, serviceName: e.target.value })} placeholder="UserService" />
            </Field>
            <Field id="grpc-method" label="Method" required error={protocolErrors['grpc-method']}>
              <Input value={grpcConfig.methodName} onChange={(e) => setGrpcConfig({ ...grpcConfig, methodName: e.target.value })} placeholder="GetUser" />
            </Field>
          </div>
          <Field
            id="grpc-proto"
            label="Proto definition"
            required
            error={protocolErrors['grpc-proto']}
            hint="Paste the .proto that defines the service, or upload the file. The tool keeps it and builds each call from it."
          >
            <Textarea value={grpcConfig.protoDefinition} onChange={(e) => setGrpcConfig({ ...grpcConfig, protoDefinition: e.target.value })} placeholder={'syntax = "proto3";\n\nservice UserService {\n  rpc GetUser (GetUserRequest) returns (User);\n}'} className="font-mono text-xs" rows={8} />
          </Field>
          <Field id="grpc-proto-file" label="Upload a .proto file">
            <Input
              type="file"
              accept=".proto,text/plain"
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (file) setGrpcConfig({ ...grpcConfig, protoDefinition: await file.text() })
              }}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            The parameters below are the fields of the method's request message.
          </p>
        </FormSection>
      )}

      {executionMethod === 'custom' && (
        <FormSection title="JavaScript code">
          <CodeMirror
            theme={githubLight}
            value={toolCode}
            height="300px"
            extensions={[
              javascript(),
              autocompletion({
                override: [
                  (context: CompletionContext) => {
                    const word = context.matchBefore(/\w+/)
                    if (!word) return null
                    return {
                      from: word.from,
                      options: paramNames().map((name) => ({
                        label: name,
                        type: 'variable',
                        detail: toolParameters.properties[name]?.type,
                      })),
                    }
                  },
                ],
              }),
            ]}
            onChange={(value) => setToolCode(value)}
            className="rounded-md border text-sm"
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
          <p className="text-xs text-muted-foreground">
            Access via <code className="rounded bg-muted px-1">params.name</code> or directly as <code className="rounded bg-muted px-1">name</code>. Available: <code className="rounded bg-muted px-1">{paramNames().join(', ') || 'none - add below'}</code>
          </p>
        </FormSection>
      )}

      {executionMethod === 'llm' && (
        <FormSection title="Model">
          <ModelPicker
            idPrefix="tool"
            activeOnly
            modelOptional
            value={{ providerId: llmConfig.providerId, model: llmConfig.model }}
            onChange={(next) => setLlmConfig({ ...llmConfig, providerId: next.providerId ?? '', model: next.model ?? '' })}
          />

          <Field id="tool-system-prompt" label="System prompt (optional)">
            <Textarea
              placeholder="You are a helpful assistant that..."
              value={llmConfig.systemPrompt}
              onChange={(e) => setLlmConfig({ ...llmConfig, systemPrompt: e.target.value })}
              rows={2}
            />
          </Field>

          <Field
            id="tool-prompt-template"
            label="Prompt template"
            hint={`Use {{paramName}} to inject parameters. Available: ${paramNames().map((k) => `{{${k}}}`).join(', ') || 'add parameters below'}`}
          >
            <Textarea
              placeholder="Analyze the following data: {{input}}&#10;&#10;Use {{parameter}} placeholders for tool parameters."
              value={llmConfig.promptTemplate}
              onChange={(e) => setLlmConfig({ ...llmConfig, promptTemplate: e.target.value })}
              rows={4}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field id="tool-output-mode" label="Output mode">
              <Select value={llmConfig.outputMode} onValueChange={(v: 'text' | 'json') => setLlmConfig({ ...llmConfig, outputMode: v })}>
                <SelectTrigger id="tool-output-mode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="text">Raw text</SelectItem>
                  <SelectItem value="json">Structured JSON</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="tool-temperature" label={`Temperature (${llmConfig.temperature})`}>
              <Input
                type="range"
                min="0"
                max="2"
                step="0.1"
                value={llmConfig.temperature}
                onChange={(e) => setLlmConfig({ ...llmConfig, temperature: parseFloat(e.target.value) })}
              />
            </Field>
            <Field id="tool-max-tokens" label="Max tokens">
              <Input
                type="number"
                value={llmConfig.maxTokens}
                onChange={(e) => setLlmConfig({ ...llmConfig, maxTokens: parseInt(e.target.value) || 1024 })}
              />
            </Field>
          </div>

          {llmConfig.outputMode === 'json' && (
            <Field id="tool-output-json-schema" label="Output JSON schema" error={outputSchemaError}>
              <Textarea
                placeholder={'{\n  "type": "object",\n  "properties": {\n    "summary": { "type": "string" }\n  }\n}'}
                value={llmConfig.outputSchema}
                onChange={(e) => setLlmConfig({ ...llmConfig, outputSchema: e.target.value })}
                rows={5}
                className="font-mono text-sm"
              />
            </Field>
          )}
        </FormSection>
      )}

      {executionMethod === 'sdk' && (
        <FormSection title="SDK">
          <Field id="tool-sdk-api" label="SDK API" hint="An API of type SDK / npm library.">
            <Select value={sdkApiId} onValueChange={setSdkApiId}>
              <SelectTrigger id="tool-sdk-api">
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
          </Field>

          {sdkApiId && sdkMapsLoading && (
            <div className="py-4 text-center text-sm text-muted-foreground">Loading SDK maps...</div>
          )}

          {sdkApiId && !sdkMapsLoading && (
            <SdkToolForm
              sdkMaps={sdkMaps}
              onConfigChange={(config) => setSdkConfig(config)}
              onParamsChange={(params) => setToolParameters(params)}
            />
          )}
        </FormSection>
      )}

      {executionMethod !== 'custom' && executionMethod !== 'llm' && executionMethod !== 'sdk' && (
        <FormSection title="Authentication">
          <Field id="tool-authentication" label="Authentication">
            <Select value={authConfig.type} onValueChange={(value) => setAuthConfig({ type: value })}>
              <SelectTrigger id="tool-authentication">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No authentication</SelectItem>
                <SelectItem value="apiKey">API key</SelectItem>
                <SelectItem value="bearer">Bearer token</SelectItem>
                <SelectItem value="basic">Basic auth</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {authConfig.type !== 'none' && (
            <CredentialPicker
              key={authConfig.type}
              id="tool-auth-credential"
              label={authConfig.type === 'apiKey' ? 'API key' : authConfig.type === 'bearer' ? 'Bearer token' : 'Username and password'}
              value={authConfig.credentialId || ''}
              onChange={(credential) => setAuthConfig({ ...authConfig, credentialId: credential?.id })}
              connectorKey={authConfig.type === 'basic' ? 'basic-auth' : OTHER_SERVICE_KEY}
              defaultName={createForm.watch('name') ? `${createForm.watch('name')} key` : undefined}
              hint={`${authConfig.type === 'apiKey' ? 'Sent in the X-API-Key header' : authConfig.type === 'bearer' ? 'Sent as a bearer token' : 'Sent as basic auth'}${executionMethod === 'grpc' ? ', as gRPC metadata' : ''}.`}
            />
          )}
        </FormSection>
      )}

      {/* SDK tools derive their parameters from the method; the rest use the builder. */}
      {executionMethod !== 'sdk' && (
        <FormSection title="Parameters">
          <JsonSchemaBuilder value={toolParameters} onChange={setToolParameters} />
        </FormSection>
      )}

      <FormSection title="Visibility">
        <VisibilityField
          organizationId={currentOrganization?.id ?? ''}
          value={visibility}
          onChange={setVisibility}
          noun="this tool"
        />
      </FormSection>
    </FormPage>
  )
}
