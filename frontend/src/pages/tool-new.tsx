/**
 * pages/tool-new — create a manual tool (/tools/new). HTTP, GraphQL,
 * SOAP, gRPC, custom JavaScript, model-backed or SDK. This used to be a
 * dialog on the Tools list; create flows live on their own pages.
 */
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowLeft } from 'lucide-react'

import { Card, CardContent } from '@/components/ui/card'
import { ToolForm } from '@/components/tools/tool-form'
import { createToolSchema, type CreateToolForm } from '@/components/tools/schema'
import { toolsApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'

export function ToolNewPage() {
  const { currentOrganization } = useOrganizationStore()
  const queryClient = useQueryClient()
  const notifications = useNotifications()
  const navigate = useNavigate()

  useEffect(() => {
    document.title = 'Create tool | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const [toolParameters, setToolParameters] = useState<any>({ type: 'object', properties: {} })
  const [toolCode, setToolCode] = useState('')
  const [executionMethod, setExecutionMethod] = useState<'http' | 'graphql' | 'soap' | 'grpc' | 'custom' | 'llm' | 'sdk'>('http')
  const [sdkConfig, setSdkConfig] = useState<any>(null)
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
  const [httpConfig, setHttpConfig] = useState({
    method: 'GET',
    url: '',
    headers: {},
    body: '',
  })
  const [graphqlConfig, setGraphqlConfig] = useState({
    endpoint: '',
    query: '',
    variables: '',
  })
  const [soapConfig, setSoapConfig] = useState({
    wsdlUrl: '',
    operation: '',
  })
  const [grpcConfig, setGrpcConfig] = useState({
    serviceUrl: '',
    method: '',
    protoFile: '',
  })
  const [authConfig, setAuthConfig] = useState({
    type: 'none',
    apiKey: '',
    bearerToken: '',
    username: '',
    password: '',
  })

  const createForm = useForm<CreateToolForm>({
    resolver: zodResolver(createToolSchema),
    defaultValues: {
      name: '',
      description: '',
    },
  })
  // Fetch available APIs for linking HTTP tools
  const { data: apisData } = useQuery({
    queryKey: ['apis', currentOrganization?.id],
    queryFn: () => import('@/lib/api').then(m => m.apisApi.getAll()),
    enabled: !!currentOrganization,
  })
  const apisExtracted = apisData?.apis || apisData || []
  const availableApis = Array.isArray(apisExtracted) ? apisExtracted : []
  const createToolMutation = useMutation({
    mutationFn: (data: any) => {
      let code = undefined;

      if (executionMethod === 'custom') {
        // Custom JavaScript: user writes their own code, no auto-generation
        code = toolCode;
      } else if (executionMethod === 'graphql') {
        code = `
// axios is available as a global — no require needed
// Parameters available as variables
const response = await axios.post('${graphqlConfig.endpoint}', {
  query: \`${graphqlConfig.query}\`,
  variables: parameters
});
return response;
`;
      } else if (executionMethod === 'soap') {
        code = `
// soap is available as a global — no require needed
const client = await soap.createClientAsync('${soapConfig.wsdlUrl}');
// Parameters available as variables
const result = await client.${soapConfig.operation}Async(parameters);
return result;
`;
      } else if (executionMethod === 'grpc') {
        code = `
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

// Load proto definition
const packageDefinition = protoLoader.loadSync('${grpcConfig.protoFile}', {});
const protoDescriptor = grpc.loadPackageDefinition(packageDefinition);

// Create client
const client = new protoDescriptor.${grpcConfig.method.split('/')[0]}('${grpcConfig.serviceUrl}', grpc.credentials.createInsecure());

// Call method
return new Promise((resolve, reject) => {
  client.${grpcConfig.method.split('/')[1]}(parameters, (error, response) => {
    if (error) reject(error);
    else resolve(response);
  });
});
`;
      }
      // HTTP: no code generation — uses httpConfig instead

      // Auto-assign tool type based on execution method
      let type = 'function';
      if (executionMethod === 'http') {
        type = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(httpConfig.method) ? 'action' : 'query';
      } else if (executionMethod === 'graphql') {
        type = graphqlConfig.query.trim().startsWith('mutation') ? 'mutation' : 'query';
      } else if (executionMethod === 'sdk') {
        type = 'function';
      }

      // Build LLM config if LLM execution method
      let llmConfigPayload = undefined;
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
        };
      }

      // Build httpConfig payload for HTTP tools (structured, no code)
      let httpConfigPayload = undefined;
      if (executionMethod === 'http') {
        httpConfigPayload = {
          method: httpConfig.method,
          path: httpConfig.url,
          bodyEncoding: ['POST', 'PUT', 'PATCH'].includes(httpConfig.method) ? undefined : undefined,
          bodyTemplate: httpConfig.body || undefined,
          headers: httpConfig.headers && Object.keys(httpConfig.headers).length > 0 ? httpConfig.headers : undefined,
        };
      }

      // The Authentication block was collected, rendered, and never
      // sent, so every hand-built HTTP tool executed unauthenticated --
      // and there is no tool edit UI, so it could not be added later
      // either. The backend stores it nested (`{ type, config }`), while
      // the form holds it flat, hence the reshape.
      const inlineAuth =
        authConfig.type === 'bearer' && authConfig.bearerToken
          ? { type: 'bearer', config: { token: authConfig.bearerToken } }
          : authConfig.type === 'apiKey' && authConfig.apiKey
            ? { type: 'apiKey', config: { key: authConfig.apiKey, headerName: 'X-API-Key' } }
            : authConfig.type === 'basic' && authConfig.username
              ? { type: 'basic', config: { username: authConfig.username, password: authConfig.password } }
              : null;

      const payload: any = {
        ...data,
        type,
        parameters: toolParameters,
        executionMethod,
        llmConfig: llmConfigPayload,
        ...(inlineAuth ? { authConfig: inlineAuth } : {}),
      };

      // HTTP tools: send httpConfig, no code
      if (executionMethod === 'http') {
        payload.httpConfig = httpConfigPayload;
      } else if (executionMethod === 'sdk') {
        // SDK tools: send sdkConfig, no code
        payload.sdkConfig = sdkConfig;
      } else {
        // All other methods that generate code
        payload.code = code;
      }

      return toolsApi.create(payload, currentOrganization?.id);
    },
    onSuccess: (created: any) => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      notifications.success('Tool created', 'It is ready to assign to a gateway.')
      navigate(created?.id ? `/tools/${created.id}` : '/tools')
    },
    onError: (error: any) => {
      const msg = getApiErrorMessage(error, 'Failed to create tool')
      notifications.error('Error', msg)
    },
  })

  return (
    <div className="space-y-6">
      <div>
        <Link to="/tools" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Tools
        </Link>
      </div>

      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>Create manual tool</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Create a custom tool with JavaScript code or link to an API operation.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <ToolForm
            onCancel={() => navigate('/tools')}
            createForm={createForm}
            createToolMutation={createToolMutation}
            executionMethod={executionMethod}
            onExecutionMethodChange={(v) => setExecutionMethod(v as 'http' | 'graphql' | 'soap' | 'grpc' | 'custom' | 'llm' | 'sdk')}
            toolParameters={toolParameters}
            onToolParametersChange={setToolParameters}
            toolCode={toolCode}
            onToolCodeChange={setToolCode}
            httpConfig={httpConfig}
            onHttpConfigChange={setHttpConfig}
            graphqlConfig={graphqlConfig}
            onGraphqlConfigChange={setGraphqlConfig}
            soapConfig={soapConfig}
            onSoapConfigChange={setSoapConfig}
            grpcConfig={grpcConfig}
            onGrpcConfigChange={setGrpcConfig}
            authConfig={authConfig}
            onAuthConfigChange={setAuthConfig}
            llmConfig={llmConfig}
            onLlmConfigChange={setLlmConfig}
            availableApis={availableApis}
            sdkConfig={sdkConfig}
            onSdkConfigChange={setSdkConfig}
          />
        </CardContent>
      </Card>
    </div>
  )
}