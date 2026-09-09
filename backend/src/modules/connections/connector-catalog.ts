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
];

// ---------------------------------------------------------------------------
// Chat channels
//
// One connector per chat channel type, keyed `channel-<type>` with the
// gateway type dasherized, exactly what ChannelCredentialService writes
// on a managed row (`channelConnectorKey`). Every form field is spelled
// the way the matching adapter under gateways/channels/adapters reads it
// (snake_case), so a connection made in the connect sheet drops straight
// into `ChannelCredentialService.resolveConfig` with no translation.
//
// Endpoints and auth shapes below were verified on 2026-09-09; the table
// in docs/connections.md ("Chat channels") records what each probe was
// checked against.
// ---------------------------------------------------------------------------

/** `channel-<type>` with the gateway type's underscores dasherized (connector keys are `[a-z0-9-]`). */
function channelKey(type: string): string {
  return `channel-${type.replace(/_/g, '-')}`;
}

/**
 * Verified 2026-09-09: POST https://slack.com/api/auth.test with
 * `Authorization: Bearer <bot token>` answers HTTP 200 for a rejected
 * token too, carrying `{"ok": false, "error": "invalid_auth"}`, so the
 * probe reads `ok` rather than trusting the status. `team` is the
 * workspace name.
 */
const SLACK_AUTH_TEST: HttpProbe = {
  kind: 'http',
  url: 'https://slack.com/api/auth.test',
  method: 'POST',
  auth: 'bearer',
  secretField: 'bot_token',
  okPath: 'ok',
  errorPath: 'error',
  accountLabelPath: 'team',
};

/**
 * Slack sends scopes comma separated on the authorize URL; the redirect
 * builder joins `scopes` with spaces, so the comma list travels as one
 * entry. `scopesNeeded` carries them individually for display.
 */
const SLACK_SCOPES = ['chat:write', 'app_mentions:read', 'im:history'];

const TWILIO_CONSOLE = 'https://console.twilio.com/';

/**
 * Verified 2026-09-09: GET
 * https://api.twilio.com/2010-04-01/Accounts/<AccountSid>.json with HTTP
 * basic auth (Account SID as the user, auth token as the password)
 * returns the account, `friendly_name` included.
 */
const TWILIO_ACCOUNT_PROBE: HttpProbe = {
  kind: 'http',
  url: 'https://api.twilio.com/2010-04-01/Accounts/{{twilio_account_sid}}.json',
  method: 'GET',
  auth: 'basic',
  usernameField: 'twilio_account_sid',
  secretField: 'twilio_auth_token',
  accountLabelPath: 'friendly_name',
};

/** The Twilio form both the WhatsApp and the SMS channel adapters read. */
function twilioMethod(numberTitle: string, numberDescription: string): ConnectMethod {
  return {
    type: 'api_key',
    label: 'Twilio account',
    description: 'Account SID and auth token from the Twilio console home.',
    schema: {
      type: 'object',
      properties: {
        twilio_account_sid: { type: 'string', title: 'Account SID', pattern: '^AC[0-9a-fA-F]{32}$' },
        twilio_auth_token: { type: 'string', title: 'Auth token', 'x-secret': true, minLength: 16 },
        phone_number: { type: 'string', title: numberTitle, description: numberDescription },
      },
      required: ['twilio_account_sid', 'twilio_auth_token', 'phone_number'],
    },
    credentialType: CredentialType.API_KEY,
    keyPageUrl: TWILIO_CONSOLE,
  };
}

const CHANNEL_CONNECTORS: ConnectorDefinition[] = [
  {
    key: channelKey('slack'),
    kind: 'channel',
    displayName: 'Slack',
    description: 'A Slack app that posts as a bot and receives events; installed through Slack OAuth or with a bot token pasted from the app config page.',
    connect: [
      {
        type: 'oauth2_code',
        label: 'Install the Slack app',
        description: 'Redirects to Slack, asks the workspace to approve the bot scopes, and stores the bot token it returns.',
        credentialType: CredentialType.API_KEY,
        secretField: 'bot_token',
        keyPageUrl: 'https://api.slack.com/apps',
        oauth: {
          authorizeUrl: 'https://slack.com/oauth/v2/authorize',
          tokenUrl: 'https://slack.com/api/oauth.v2.access',
          scopes: [SLACK_SCOPES.join(',')],
          clientId: 'platform',
          tokenField: 'access_token',
        },
      },
      {
        type: 'api_key',
        label: 'Bot token',
        description: 'From the Slack app config page: OAuth & Permissions for the bot token, Basic Information for the signing secret.',
        schema: {
          type: 'object',
          properties: {
            bot_token: { type: 'string', title: 'Bot user OAuth token', 'x-secret': true, pattern: '^xox[bp]-', description: 'Starts with xoxb-.' },
            signing_secret: { type: 'string', title: 'Signing secret', 'x-secret': true, description: 'Needed to verify inbound Slack events.' },
          },
          required: ['bot_token'],
        },
        credentialType: CredentialType.API_KEY,
        keyPageUrl: 'https://api.slack.com/apps',
      },
    ],
    capabilities: ['send', 'receive'],
    scopesNeeded: SLACK_SCOPES,
    validation: SLACK_AUTH_TEST,
    keyPageUrl: 'https://api.slack.com/apps',
    docsUrl: 'https://docs.slack.dev/authentication/installing-with-oauth',
  },
  {
    key: channelKey('discord'),
    kind: 'channel',
    displayName: 'Discord',
    description: 'A Discord bot that replies in servers and DMs.',
    // Verified 2026-09-09: GET https://discord.com/api/v10/users/@me answers
    // 401 with no credential; the bot token goes in `Authorization: Bot <token>`.
    connect: [{
      type: 'api_key',
      label: 'Bot token',
      description: 'Developer portal, your application, Bot, Reset Token.',
      schema: {
        type: 'object',
        properties: {
          bot_token: { type: 'string', title: 'Bot token', 'x-secret': true, minLength: 20 },
        },
        required: ['bot_token'],
      },
      credentialType: CredentialType.API_KEY,
      keyPageUrl: 'https://discord.com/developers/applications',
    }],
    capabilities: ['send', 'receive'],
    validation: {
      kind: 'http',
      url: 'https://discord.com/api/v10/users/@me',
      method: 'GET',
      auth: 'header',
      headerName: 'Authorization',
      headerPrefix: 'Bot ',
      secretField: 'bot_token',
      accountLabelPath: 'username',
    },
    keyPageUrl: 'https://discord.com/developers/applications',
    docsUrl: 'https://docs.discord.com/developers/resources/user',
  },
  {
    key: channelKey('telegram'),
    kind: 'channel',
    displayName: 'Telegram',
    description: 'A Telegram bot created with BotFather.',
    // Verified 2026-09-09: the token is a path segment,
    // https://api.telegram.org/bot<token>/getMe, and the User sits under
    // `result`. A bad token answers `{"ok": false, ...}`.
    connect: [{
      type: 'api_key',
      label: 'Bot token',
      description: 'Message @BotFather, /newbot or /token, and paste what it prints.',
      schema: {
        type: 'object',
        properties: {
          bot_token: { type: 'string', title: 'Bot token', 'x-secret': true, pattern: '^\\d+:[A-Za-z0-9_-]{20,}$' },
          webhook_secret_token: { type: 'string', title: 'Webhook secret token', 'x-secret': true, description: 'Optional; Telegram echoes it on every inbound update so almyty can reject forgeries.' },
        },
        required: ['bot_token'],
      },
      credentialType: CredentialType.API_KEY,
      keyPageUrl: 'https://t.me/botfather',
    }],
    capabilities: ['send', 'receive'],
    validation: {
      kind: 'http',
      url: 'https://api.telegram.org/bot{{bot_token}}/getMe',
      method: 'GET',
      auth: 'none',
      okPath: 'ok',
      errorPath: 'description',
      accountLabelPath: 'result.username',
    },
    keyPageUrl: 'https://t.me/botfather',
    docsUrl: 'https://core.telegram.org/bots/api#getme',
  },
  {
    key: channelKey('whatsapp'),
    kind: 'channel',
    displayName: 'WhatsApp (Twilio)',
    description: 'WhatsApp through a Twilio sender; the same account credentials as SMS.',
    connect: [twilioMethod('WhatsApp sender', 'The WhatsApp-enabled Twilio number, in whatsapp:+E.164 form.')],
    capabilities: ['send', 'receive'],
    validation: TWILIO_ACCOUNT_PROBE,
    keyPageUrl: TWILIO_CONSOLE,
    docsUrl: 'https://www.twilio.com/docs/whatsapp',
  },
  {
    key: channelKey('sms'),
    kind: 'channel',
    displayName: 'SMS (Twilio)',
    description: 'Text messages through a Twilio phone number.',
    connect: [twilioMethod('Twilio number', 'The sending phone number in E.164 form.')],
    capabilities: ['send', 'receive'],
    validation: TWILIO_ACCOUNT_PROBE,
    keyPageUrl: TWILIO_CONSOLE,
    docsUrl: 'https://www.twilio.com/docs/messaging',
  },
  {
    key: channelKey('whatsapp_cloud'),
    kind: 'channel',
    displayName: 'WhatsApp Cloud API (Meta)',
    description: 'WhatsApp straight from Meta, no Twilio in between.',
    // Verified 2026-09-09: GET https://graph.facebook.com/<version>/<phone
    // number id> with `Authorization: Bearer <access token>` returns
    // display_phone_number, verified_name, quality_rating and id. v23.0 is
    // available until 2027-10-08; v21.0 expires 2027-01-21.
    connect: [{
      type: 'api_key',
      label: 'Cloud API credentials',
      description: 'Meta app dashboard, WhatsApp, API Setup.',
      schema: {
        type: 'object',
        properties: {
          phone_number_id: { type: 'string', title: 'Phone number ID', pattern: '^\\d{5,}$' },
          access_token: { type: 'string', title: 'Access token', 'x-secret': true, minLength: 20 },
          app_secret: { type: 'string', title: 'App secret', 'x-secret': true, description: 'Verifies the X-Hub-Signature-256 on inbound webhooks.' },
          verify_token: { type: 'string', title: 'Webhook verify token', 'x-secret': true, description: 'The string you also type into the Meta webhook setup form.' },
        },
        required: ['phone_number_id', 'access_token'],
      },
      credentialType: CredentialType.API_KEY,
      keyPageUrl: 'https://developers.facebook.com/apps',
    }],
    capabilities: ['send', 'receive'],
    validation: {
      kind: 'http',
      url: 'https://graph.facebook.com/v23.0/{{phone_number_id}}',
      method: 'GET',
      auth: 'bearer',
      secretField: 'access_token',
      accountLabelPath: 'display_phone_number',
    },
    keyPageUrl: 'https://developers.facebook.com/apps',
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers',
  },
  {
    key: channelKey('microsoft_teams'),
    kind: 'channel',
    displayName: 'Microsoft Teams',
    description: 'A Bot Framework bot registered as an Azure Bot resource.',
    // Verified 2026-09-09: the bot exchanges its app id and password at
    // POST https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token,
    // grant_type=client_credentials, scope https://api.botframework.com/.default,
    // form encoded. Multi-tenant bots use the literal tenant `botframework.com`.
    connect: [{
      type: 'api_key',
      label: 'Bot registration',
      description: 'Azure Bot resource, Configuration: the Microsoft App ID, its client secret, and the tenant the app lives in.',
      schema: {
        type: 'object',
        properties: {
          bot_id: { type: 'string', title: 'Microsoft App ID' },
          bot_password: { type: 'string', title: 'Client secret', 'x-secret': true, minLength: 8 },
          tenant_id: { type: 'string', title: 'Tenant', default: 'botframework.com', description: 'The directory (tenant) id for a single-tenant bot; botframework.com for a multi-tenant one.' },
          service_url: { type: 'string', title: 'Service URL', format: 'uri', description: 'Optional; learned from the first inbound activity when left empty.' },
        },
        required: ['bot_id', 'bot_password', 'tenant_id'],
      },
      credentialType: CredentialType.OAUTH2,
      keyPageUrl: 'https://portal.azure.com/',
    }],
    capabilities: ['send', 'receive'],
    validation: {
      kind: 'oauth2_client_credentials',
      tokenUrl: 'https://login.microsoftonline.com/{{tenant_id}}/oauth2/v2.0/token',
      scope: 'https://api.botframework.com/.default',
      clientIdField: 'bot_id',
      clientSecretField: 'bot_password',
    },
    keyPageUrl: 'https://portal.azure.com/',
    docsUrl: 'https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication',
  },
  {
    key: channelKey('google_chat'),
    kind: 'channel',
    displayName: 'Google Chat',
    description: 'Posts into a Google Chat space through an incoming webhook.',
    // The webhook URL already carries its own `key` and `token` query
    // params, so calling it is the only way to test it and that would
    // post a message into the space. Checked for shape instead. The URL
    // is never used as the account label: its `token` is a secret.
    connect: [{
      type: 'api_key',
      label: 'Incoming webhook',
      description: 'In the Chat space: Apps & integrations, Webhooks, Add webhook, then copy the URL.',
      schema: {
        type: 'object',
        properties: {
          webhook_url: { type: 'string', title: 'Webhook URL', format: 'uri', description: 'https://chat.googleapis.com/v1/spaces/.../messages?key=...&token=... The token in it is a secret.' },
          verification_token: { type: 'string', title: 'Verification token', 'x-secret': true, description: 'Optional; checked on inbound events from the Chat app.' },
        },
        required: ['webhook_url'],
      },
      credentialType: CredentialType.CUSTOM,
      keyPageUrl: 'https://console.cloud.google.com/workspace-api',
    }],
    capabilities: ['send', 'receive'],
    validation: { kind: 'format', fields: { webhook_url: '^https://chat\\.googleapis\\.com/v1/spaces/' }, urlFields: ['webhook_url'] },
    keyPageUrl: 'https://console.cloud.google.com/workspace-api',
    docsUrl: 'https://developers.google.com/workspace/chat/quickstart/webhooks',
  },
  {
    key: channelKey('signal'),
    kind: 'channel',
    displayName: 'Signal',
    description: 'Signal through a signal-cli REST bridge you run yourself.',
    // The bridge is your own host, usually on a private network the SSRF
    // guard refuses, and it has no credential to check beyond the shared
    // inbound token. Shape check only.
    connect: [{
      type: 'api_key',
      label: 'Bridge',
      description: 'The signal-cli-rest-api instance and the number it is registered as.',
      schema: {
        type: 'object',
        properties: {
          api_url: { type: 'string', title: 'Bridge URL', format: 'uri', description: 'Base URL of your signal-cli-rest-api, e.g. https://signal.internal.example.com.' },
          phone_number: { type: 'string', title: 'Registered number', pattern: '^\\+[1-9]\\d{6,14}$' },
          inbound_token: { type: 'string', title: 'Inbound token', 'x-secret': true, description: 'Shared secret the bridge sends on inbound posts.' },
        },
        required: ['api_url', 'phone_number'],
      },
      credentialType: CredentialType.CUSTOM,
    }],
    capabilities: ['send', 'receive'],
    validation: { kind: 'format', fields: { phone_number: '^\\+[1-9]\\d{6,14}$' }, accountLabelFrom: 'phone_number' },
    keyPageUrl: null,
    docsUrl: 'https://github.com/bbernhard/signal-cli-rest-api',
  },
  {
    key: channelKey('matrix'),
    kind: 'channel',
    displayName: 'Matrix',
    description: 'A Matrix bot user on any homeserver.',
    // Verified 2026-09-09 against the client-server spec: GET
    // <homeserver>/_matrix/client/v3/account/whoami with
    // `Authorization: Bearer <access token>` returns { user_id, device_id?,
    // is_guest? }; an unknown token is 401 M_UNKNOWN_TOKEN.
    connect: [{
      type: 'api_key',
      label: 'Access token',
      description: 'Log the bot user in once (or use Element, Settings, Help & About) and copy its access token.',
      schema: {
        type: 'object',
        properties: {
          homeserver_url: { type: 'string', title: 'Homeserver URL', format: 'uri', default: 'https://matrix.org' },
          access_token: { type: 'string', title: 'Access token', 'x-secret': true, minLength: 16 },
          room_id: { type: 'string', title: 'Default room id', description: 'Optional; the room replies go to when a message names none.' },
          inbound_token: { type: 'string', title: 'Inbound token', 'x-secret': true, description: 'Optional; shared secret on the inbound webhook.' },
        },
        required: ['homeserver_url', 'access_token'],
      },
      credentialType: CredentialType.BEARER_TOKEN,
    }],
    capabilities: ['send', 'receive'],
    validation: {
      kind: 'http',
      url: '{{homeserver_url}}/_matrix/client/v3/account/whoami',
      method: 'GET',
      auth: 'bearer',
      secretField: 'access_token',
      accountLabelPath: 'user_id',
    },
    keyPageUrl: null,
    docsUrl: 'https://spec.matrix.org/latest/client-server-api/#get_matrixclientv3accountwhoami',
  },
  {
    key: channelKey('irc'),
    kind: 'channel',
    displayName: 'IRC',
    description: 'IRC through a bridge that speaks HTTP on almyty side.',
    // The bridge is yours; there is no vendor endpoint to ask. The
    // outbound webhook URL is shape-checked and the bearer token is
    // stored for the adapter to send.
    connect: [{
      type: 'api_key',
      label: 'Bridge',
      schema: {
        type: 'object',
        properties: {
          webhook_url: { type: 'string', title: 'Bridge webhook URL', format: 'uri', description: 'Where almyty POSTs outbound lines.' },
          bridge_token: { type: 'string', title: 'Bridge token', 'x-secret': true, description: 'Sent as a bearer token on outbound posts.' },
          inbound_token: { type: 'string', title: 'Inbound token', 'x-secret': true, description: 'Shared secret the bridge sends on inbound posts.' },
          channel: { type: 'string', title: 'Default channel', description: '#channel, or a nick for private messages.' },
          nick: { type: 'string', title: 'Relay nick', default: 'bot' },
        },
        required: ['webhook_url'],
      },
      credentialType: CredentialType.CUSTOM,
    }],
    capabilities: ['send', 'receive'],
    validation: { kind: 'format', urlFields: ['webhook_url'], accountLabelFrom: 'nick' },
    keyPageUrl: null,
    docsUrl: null,
  },
  {
    key: channelKey('email'),
    kind: 'channel',
    displayName: 'Email (Resend)',
    description: 'Sends and answers mail through Resend.',
    // Verified 2026-09-09: GET https://api.resend.com/api-keys answers 401
    // without an Authorization header and returns { object, has_more, data }
    // with a bearer key. Nothing in the response names the account, so the
    // reply address is the label.
    connect: [{
      type: 'api_key',
      label: 'Resend API key',
      description: 'Resend dashboard, API Keys.',
      schema: {
        type: 'object',
        properties: {
          resend_api_key: { type: 'string', title: 'API key', 'x-secret': true, pattern: '^re_' },
          reply_from: { type: 'string', title: 'From address', description: 'The verified sender replies go out as.' },
          inbound_address: { type: 'string', title: 'Inbound address', description: 'Optional; the address mail arrives on.' },
          resend_inbound_signing_secret: { type: 'string', title: 'Inbound signing secret', 'x-secret': true, description: 'Optional; verifies the Svix signature on inbound mail webhooks.' },
        },
        required: ['resend_api_key'],
      },
      credentialType: CredentialType.API_KEY,
      keyPageUrl: 'https://resend.com/api-keys',
    }],
    capabilities: ['send', 'receive'],
    validation: {
      kind: 'http',
      url: 'https://api.resend.com/api-keys',
      method: 'GET',
      auth: 'bearer',
      secretField: 'resend_api_key',
      accountLabelFrom: 'reply_from',
    },
    keyPageUrl: 'https://resend.com/api-keys',
    docsUrl: 'https://resend.com/docs/api-reference/api-keys/list-api-keys',
  },
  {
    key: channelKey('webhook'),
    kind: 'channel',
    displayName: 'Outbound webhook',
    description: 'An HTTPS endpoint of yours that receives channel events, signed with a shared secret.',
    // Your endpoint, not a vendor's: calling it would deliver a message.
    // Shape check only.
    connect: [{
      type: 'api_key',
      label: 'Webhook URL and secret',
      schema: {
        type: 'object',
        properties: {
          callback_url: { type: 'string', title: 'Webhook URL', format: 'uri' },
          secret: { type: 'string', title: 'Signing secret', 'x-secret': true, minLength: 16 },
        },
        required: ['callback_url', 'secret'],
      },
      credentialType: CredentialType.CUSTOM,
    }],
    capabilities: ['deliver'],
    validation: { kind: 'format', urlFields: ['callback_url'], accountLabelFrom: 'callback_url' },
    keyPageUrl: null,
    docsUrl: null,
  },
];

export const CHANNEL_CONNECTOR_KEYS: readonly string[] = CHANNEL_CONNECTORS.map((c) => c.key);

export { CHANNEL_CONNECTORS };

export const BUILTIN_CONNECTORS: readonly ConnectorDefinition[] = [
  ...INFERENCE_CONNECTORS,
  ...DEPLOYMENT_CONNECTORS,
  ...CLOUD_CONNECTORS,
  ...CHANNEL_CONNECTORS,
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
