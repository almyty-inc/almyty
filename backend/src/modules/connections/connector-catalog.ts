import { LlmProvider, LlmProviderType } from '../../entities/llm-provider.entity';
import { CredentialType } from '../../entities/credential.entity';
import { getProviderDescription, getProviderDisplayName, getProviderDocsUrl, getProviderKeyUrl } from '../llm-providers/llm-provider-catalog';
import { ConnectMethod, ConnectorDefinition, HttpProbe, JsonSchemaObject } from './connector.types';

/**
 * The built-in connector catalog, as data. Endpoints were verified on
 * 2026-09-08 (see docs/design/connections.md, "Verified connector
 * facts"). Inference entries reuse the LLM provider catalog for names,
 * key pages and docs, and the LlmProvider entity for base URLs, so a
 * vendor is described in one place.
 */

const API_KEY_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: { apiKey: { type: 'string', title: 'API key', 'x-secret': true, minLength: 8 } },
  required: ['apiKey'],
};

function providerBaseUrl(type: LlmProviderType): string {
  const p = new LlmProvider();
  p.type = type;
  p.configuration = {} as any;
  return p.getApiUrl().replace(/\/$/, '');
}

function bearerProbe(url: string, extra: Partial<HttpProbe> = {}): HttpProbe {
  return { kind: 'http', url, method: 'GET', auth: 'bearer', ...extra };
}

/** An inference vendor that takes a plain API key and lists models at <base>/models. */
function inference(type: LlmProviderType, options: { validation?: HttpProbe; extraMethods?: ConnectMethod[]; capabilities?: string[]; pricingSource?: string } = {}): ConnectorDefinition {
  const keyPageUrl = getProviderKeyUrl(type) ?? null;
  return {
    key: type,
    kind: 'inference',
    providerType: type,
    displayName: getProviderDisplayName(type),
    description: getProviderDescription(type),
    connect: [
      ...(options.extraMethods ?? []),
      { type: 'api_key', label: 'API key', schema: API_KEY_SCHEMA, keyPageUrl: keyPageUrl ?? undefined },
    ],
    capabilities: options.capabilities ?? ['chat', 'models'],
    validation: options.validation ?? bearerProbe(`${providerBaseUrl(type)}/models`),
    pricingSource: options.pricingSource ?? 'vendor_list',
    keyPageUrl,
    docsUrl: getProviderDocsUrl(type) ?? null,
  };
}

const OPENROUTER_PKCE: ConnectMethod = {
  type: 'oauth2_pkce',
  label: 'Sign in with OpenRouter',
  description: 'Creates an OpenRouter API key scoped to almyty; no client registration needed.',
  credentialType: CredentialType.API_KEY,
  secretField: 'apiKey',
  oauth: {
    authorizeUrl: 'https://openrouter.ai/auth',
    tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
    pkce: true,
    stateVia: 'callback_query',
    callbackParam: 'callback_url',
    clientId: 'none',
    tokenRequest: 'json',
    tokenField: 'key',
    headlessCode: true,
  },
};

export const OPENROUTER_CONNECTOR: ConnectorDefinition = {
  ...inference(LlmProviderType.OPENROUTER, {
    validation: bearerProbe('https://openrouter.ai/api/v1/key', { accountLabelPath: 'data.label' }),
    capabilities: ['chat', 'models', 'usage'],
  }),
  connect: [OPENROUTER_PKCE, { type: 'api_key', label: 'API key', schema: API_KEY_SCHEMA, keyPageUrl: 'https://openrouter.ai/keys' }],
};

const HUGGINGFACE_WHOAMI = bearerProbe('https://huggingface.co/api/whoami-v2', { accountLabelPath: 'name' });

const OLLAMA_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    baseUrl: { type: 'string', title: 'Ollama URL', format: 'uri', default: 'https://ollama.com', description: 'Your Ollama host; ollama.com for Ollama Cloud, http://localhost:11434 for a local daemon when OLLAMA_ALLOW_PRIVATE_URLS is on.' },
    apiKey: { type: 'string', title: 'API key', 'x-secret': true, description: 'Optional; only for Ollama Cloud or an authenticating proxy.' },
  },
  required: ['baseUrl'],
};

const INFERENCE_CONNECTORS: ConnectorDefinition[] = [
  OPENROUTER_CONNECTOR,
  inference(LlmProviderType.OPENAI),
  inference(LlmProviderType.ANTHROPIC, {
    validation: { kind: 'http', url: 'https://api.anthropic.com/v1/models', auth: 'header', headerName: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' } },
  }),
  inference(LlmProviderType.GOOGLE, {
    validation: { kind: 'http', url: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'header', headerName: 'x-goog-api-key' },
  }),
  inference(LlmProviderType.MISTRAL),
  inference(LlmProviderType.GROQ),
  inference(LlmProviderType.TOGETHER),
  inference(LlmProviderType.XAI),
  inference(LlmProviderType.DEEPSEEK),
  inference(LlmProviderType.COHERE, { validation: bearerProbe('https://api.cohere.com/v1/models') }),
  inference(LlmProviderType.HUGGINGFACE, { validation: HUGGINGFACE_WHOAMI, capabilities: ['chat', 'models', 'hub'] }),
  {
    ...inference(LlmProviderType.OLLAMA, {
      validation: { kind: 'http', url: '{{baseUrl}}/api/tags', auth: 'bearer', privateUrlsEnv: 'OLLAMA_ALLOW_PRIVATE_URLS' },
      capabilities: ['chat', 'models', 'local'],
      pricingSource: 'free',
    }),
    connect: [{ type: 'api_key', label: 'Ollama host', schema: OLLAMA_SCHEMA, keyPageUrl: 'https://ollama.com/settings/keys' }],
  },
  inference(LlmProviderType.FIREWORKS),
  inference(LlmProviderType.CEREBRAS),
  inference(LlmProviderType.DEEPINFRA),
  inference(LlmProviderType.PERPLEXITY),
  inference(LlmProviderType.ZAI),
  inference(LlmProviderType.NEBIUS),
  {
    key: 'openai-compatible',
    kind: 'inference',
    providerType: LlmProviderType.CUSTOM,
    displayName: 'OpenAI-compatible endpoint',
    description: 'Any server that speaks the OpenAI chat and models API.',
    connect: [{
      type: 'api_key',
      label: 'Endpoint and key',
      schema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'Base URL', format: 'uri', description: 'Ends with /v1 for most servers.' },
          apiKey: { type: 'string', title: 'API key', 'x-secret': true },
        },
        required: ['baseUrl'],
      },
    }],
    capabilities: ['chat', 'models'],
    validation: bearerProbe('{{baseUrl}}/models'),
    pricingSource: 'unpriced',
    keyPageUrl: null,
    docsUrl: null,
  },
];

const DEPLOYMENT_CONNECTORS: ConnectorDefinition[] = [
  {
    key: 'modal',
    kind: 'deployment',
    adapterKey: 'modal',
    displayName: 'Modal',
    description: 'Serverless GPU containers; tokens are an id and secret pair.',
    connect: [{
      type: 'api_key',
      label: 'Modal token',
      schema: {
        type: 'object',
        properties: {
          tokenId: { type: 'string', title: 'Token id', 'x-secret': true, pattern: '^ak-' },
          tokenSecret: { type: 'string', title: 'Token secret', 'x-secret': true, pattern: '^as-' },
          workspace: { type: 'string', title: 'Workspace' },
        },
        required: ['tokenId', 'tokenSecret'],
      },
      keyPageUrl: 'https://modal.com/settings/tokens',
    }],
    capabilities: ['deploy', 'scale_to_zero'],
    // Modal exposes no REST endpoint that answers to a token alone; the
    // adapter's first deploy is the live check.
    validation: { kind: 'format', fields: { tokenId: '^ak-', tokenSecret: '^as-' }, accountLabelFrom: 'workspace' },
    keyPageUrl: 'https://modal.com/settings/tokens',
    docsUrl: 'https://modal.com/docs',
  },
  {
    key: 'baseten',
    kind: 'deployment',
    adapterKey: 'baseten',
    displayName: 'Baseten',
    description: 'Dedicated model deployments through the Baseten management API.',
    connect: [{ type: 'api_key', label: 'API key', schema: API_KEY_SCHEMA, keyPageUrl: 'https://app.baseten.co/settings/api_keys' }],
    capabilities: ['deploy', 'inference'],
    validation: bearerProbe('https://api.baseten.co/v1/models'),
    keyPageUrl: 'https://app.baseten.co/settings/api_keys',
    docsUrl: 'https://docs.baseten.co',
  },
  {
    key: 'runpod',
    kind: 'deployment',
    displayName: 'RunPod',
    description: 'GPU pods and serverless endpoints.',
    connect: [{ type: 'api_key', label: 'API key', schema: API_KEY_SCHEMA, keyPageUrl: 'https://www.console.runpod.io/user/settings' }],
    capabilities: ['deploy'],
    validation: bearerProbe('https://rest.runpod.io/v1/pods'),
    keyPageUrl: 'https://www.console.runpod.io/user/settings',
    docsUrl: 'https://docs.runpod.io',
  },
];

const AWS_ROLE_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    roleArn: { type: 'string', title: 'Role ARN', pattern: '^arn:aws(-[a-z]+)?:iam::\\d{12}:role/.+' },
    region: { type: 'string', title: 'Default region', default: 'us-east-1' },
  },
  required: ['roleArn'],
};

const AWS_KEY_SCHEMA: JsonSchemaObject = {
  type: 'object',
  properties: {
    accessKeyId: { type: 'string', title: 'Access key id', 'x-secret': true, pattern: '^[A-Z0-9]{16,128}$' },
    secretAccessKey: { type: 'string', title: 'Secret access key', 'x-secret': true, minLength: 16 },
    sessionToken: { type: 'string', title: 'Session token', 'x-secret': true },
    region: { type: 'string', title: 'Default region', default: 'us-east-1' },
  },
  required: ['accessKeyId', 'secretAccessKey'],
};

const CLOUD_CONNECTORS: ConnectorDefinition[] = [
  {
    key: 'aws',
    kind: 'cloud',
    displayName: 'Amazon Web Services',
    description: 'Bedrock, SageMaker and S3 through a cross-account role or an access key pair.',
    connect: [
      {
        type: 'cloud_iam',
        label: 'Cross-account role',
        description: 'Creates an IAM role in your account that trusts almyty with an external id.',
        schema: AWS_ROLE_SCHEMA,
        credentialType: CredentialType.AWS_SIGV4,
        quickCreate: {
          templateUrl: 'https://console.aws.amazon.com/cloudformation/home#/stacks/create/review?templateURL={{cfnTemplateUrl}}&stackName={{stackName}}&param_ExternalId={{externalId}}&param_TrustedAccountId={{trustedAccountId}}',
          stackName: 'almyty-access',
        },
      },
      { type: 'api_key', label: 'Access key pair', schema: AWS_KEY_SCHEMA, credentialType: CredentialType.AWS_SIGV4, keyPageUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials' },
    ],
    capabilities: ['bedrock', 'sagemaker', 's3'],
    validation: { kind: 'aws_caller_identity' },
    keyPageUrl: 'https://console.aws.amazon.com/iam/home#/security_credentials',
    docsUrl: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-user_externalid.html',
  },
  {
    key: 'gcp',
    kind: 'cloud',
    displayName: 'Google Cloud',
    description: 'Vertex AI and Cloud Storage through a service account key.',
    connect: [{
      type: 'service_account',
      label: 'Service account JSON',
      schema: {
        type: 'object',
        properties: {
          serviceAccountJson: { type: 'string', title: 'Service account key (JSON)', 'x-secret': true, minLength: 20 },
          project: { type: 'string', title: 'Project id', description: 'Defaults to the key file project_id.' },
          location: { type: 'string', title: 'Region', default: 'us-central1' },
        },
        required: ['serviceAccountJson'],
      },
      credentialType: CredentialType.GOOGLE_SERVICE_ACCOUNT,
      keyPageUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    }],
    capabilities: ['vertex', 'gcs'],
    validation: { kind: 'gcp_service_account' },
    keyPageUrl: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    docsUrl: 'https://cloud.google.com/iam/docs/keys-create-delete',
  },
  {
    key: 'azure',
    kind: 'cloud',
    displayName: 'Microsoft Azure',
    description: 'Azure OpenAI and AI Foundry through an app registration (client credentials).',
    connect: [{
      type: 'oauth2_client_credentials',
      label: 'App registration',
      schema: {
        type: 'object',
        properties: {
          tenantId: { type: 'string', title: 'Directory (tenant) id' },
          clientId: { type: 'string', title: 'Application (client) id' },
          clientSecret: { type: 'string', title: 'Client secret', 'x-secret': true },
          subscriptionId: { type: 'string', title: 'Subscription id' },
        },
        required: ['tenantId', 'clientId', 'clientSecret'],
      },
      credentialType: CredentialType.OAUTH2,
      keyPageUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    }],
    capabilities: ['azure_openai', 'foundry'],
    validation: { kind: 'oauth2_client_credentials', tokenUrl: 'https://login.microsoftonline.com/{{tenantId}}/oauth2/v2.0/token', scope: 'https://management.azure.com/.default' },
    keyPageUrl: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    docsUrl: 'https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow',
  },
  {
    key: 'digitalocean',
    kind: 'cloud',
    displayName: 'DigitalOcean',
    description: 'Droplets, GPU droplets and Spaces through a personal access token.',
    connect: [{ type: 'api_key', label: 'Personal access token', schema: API_KEY_SCHEMA, keyPageUrl: 'https://cloud.digitalocean.com/account/api/tokens' }],
    capabilities: ['compute', 'spaces'],
    validation: bearerProbe('https://api.digitalocean.com/v2/account', { accountLabelPath: 'account.email' }),
    keyPageUrl: 'https://cloud.digitalocean.com/account/api/tokens',
    docsUrl: 'https://docs.digitalocean.com/reference/api/',
  },
];

export const REGISTRY_S3_CONNECTOR: ConnectorDefinition = {
  key: 'registry-s3',
  kind: 'registry',
  displayName: 'S3-compatible registry',
  description: 'Model weights and manifests in your own bucket (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces).',
  connect: [{
    type: 'api_key',
    label: 'Bucket and access keys',
    schema: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', title: 'Endpoint', format: 'uri', description: 'Leave empty for AWS S3.' },
        region: { type: 'string', title: 'Region', default: 'us-east-1' },
        bucket: { type: 'string', title: 'Bucket', pattern: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$' },
        prefix: { type: 'string', title: 'Key prefix' },
        accessKeyId: { type: 'string', title: 'Access key id', 'x-secret': true },
        secretAccessKey: { type: 'string', title: 'Secret access key', 'x-secret': true },
      },
      required: ['region', 'bucket', 'accessKeyId', 'secretAccessKey'],
    },
    credentialType: CredentialType.S3_COMPATIBLE,
  }],
  capabilities: ['objects'],
  validation: { kind: 's3_bucket' },
  keyPageUrl: null,
  docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html',
};

const OTHER_CONNECTORS: ConnectorDefinition[] = [
  REGISTRY_S3_CONNECTOR,
  {
    key: 'registry-huggingface',
    kind: 'registry',
    displayName: 'Hugging Face Hub',
    description: 'Read private repos and push weights with your own Hub token.',
    connect: [{ type: 'api_key', label: 'Access token', schema: API_KEY_SCHEMA, keyPageUrl: 'https://huggingface.co/settings/tokens' }],
    capabilities: ['hub_read', 'hub_write'],
    validation: HUGGINGFACE_WHOAMI,
    keyPageUrl: 'https://huggingface.co/settings/tokens',
    docsUrl: 'https://huggingface.co/docs/hub/security-tokens',
  },
  {
    key: 'memory-custom',
    kind: 'memory',
    displayName: 'Memory backend (HTTP)',
    description: 'A memory service reachable over HTTPS with a bearer token.',
    connect: [{
      type: 'api_key',
      label: 'Endpoint and key',
      schema: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string', title: 'Base URL', format: 'uri' },
          apiKey: { type: 'string', title: 'API key', 'x-secret': true },
          healthPath: { type: 'string', title: 'Health path', default: '/' },
        },
        required: ['baseUrl'],
      },
      credentialType: CredentialType.MEMORY_BACKEND,
    }],
    capabilities: ['store', 'recall'],
    validation: bearerProbe('{{baseUrl}}{{healthPath}}'),
    keyPageUrl: null,
    docsUrl: null,
  },
  {
    key: 'mcp-custom',
    kind: 'mcp',
    displayName: 'MCP server',
    description: 'A remote MCP server over streamable HTTP, optionally behind a bearer token.',
    connect: [{
      type: 'api_key',
      label: 'Server URL and token',
      schema: {
        type: 'object',
        properties: {
          serverUrl: { type: 'string', title: 'Server URL', format: 'uri' },
          apiKey: { type: 'string', title: 'Bearer token', 'x-secret': true },
        },
        required: ['serverUrl'],
      },
      credentialType: CredentialType.BEARER_TOKEN,
    }],
    capabilities: ['tools'],
    validation: { kind: 'mcp_initialize' },
    keyPageUrl: null,
    docsUrl: 'https://modelcontextprotocol.io/specification',
  },
  {
    key: 'toolsource-openapi',
    kind: 'tool_source',
    displayName: 'OpenAPI document',
    description: 'An OpenAPI spec URL whose operations become tools.',
    connect: [{
      type: 'api_key',
      label: 'Spec URL and key',
      schema: {
        type: 'object',
        properties: {
          specUrl: { type: 'string', title: 'Spec URL', format: 'uri' },
          apiKey: { type: 'string', title: 'API key', 'x-secret': true },
        },
        required: ['specUrl'],
      },
    }],
    capabilities: ['tools'],
    validation: bearerProbe('{{specUrl}}'),
    keyPageUrl: null,
    docsUrl: null,
  },
  {
    key: 'channel-webhook',
    kind: 'channel',
    displayName: 'Outbound webhook',
    description: 'An HTTPS endpoint that receives channel events, signed with a shared secret.',
    connect: [{
      type: 'api_key',
      label: 'Webhook URL and secret',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', title: 'Webhook URL', format: 'uri' },
          secret: { type: 'string', title: 'Signing secret', 'x-secret': true, minLength: 16 },
        },
        required: ['url', 'secret'],
      },
      credentialType: CredentialType.CUSTOM,
    }],
    capabilities: ['deliver'],
    validation: { kind: 'format', urlFields: ['url'], accountLabelFrom: 'url' },
    keyPageUrl: null,
    docsUrl: null,
  },
];

export const BUILTIN_CONNECTORS: readonly ConnectorDefinition[] = [
  ...INFERENCE_CONNECTORS,
  ...DEPLOYMENT_CONNECTORS,
  ...CLOUD_CONNECTORS,
  ...OTHER_CONNECTORS,
];

/**
 * Deployment adapters that have no hand-written connector get one derived
 * from their configSchema: the `x-secret` fields become the api_key form.
 * Read from the registry at runtime; nothing is copied.
 */
export function connectorFromAdapter(adapter: { key: string; displayName: string; configSchema: Record<string, any> }): ConnectorDefinition | null {
  const props = (adapter.configSchema?.properties ?? {}) as Record<string, any>;
  const secretEntries = Object.entries(props).filter(([, p]) => p && p['x-secret'] === true);
  if (secretEntries.length === 0) return null;
  const properties: JsonSchemaObject['properties'] = {};
  for (const [name, p] of secretEntries) {
    properties[name] = { type: 'string', title: p.title ?? name, description: p.description, 'x-secret': true };
  }
  const required = (adapter.configSchema.required ?? []).filter((r: string) => r in properties);
  return {
    key: `deploy-${adapter.key}`,
    kind: 'deployment',
    adapterKey: adapter.key,
    displayName: adapter.displayName,
    description: `Credentials for the ${adapter.displayName} deployment adapter.`,
    connect: [{ type: 'api_key', label: 'Adapter credentials', schema: { type: 'object', properties, required } }],
    capabilities: ['deploy'],
    validation: { kind: 'format' },
    keyPageUrl: null,
    docsUrl: null,
  };
}
