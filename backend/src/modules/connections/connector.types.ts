/**
 * The Connections layer: one sign-in and key-management surface for
 * every third party (inference vendors, deployment providers, memory
 * backends, MCP servers, channels, clouds, registries).
 *
 * A Connector is catalog data describing HOW to connect to a party.
 * A Connection is a Credential row that carries a connectorKey plus the
 * account it resolves to and its health. Secrets live only in the
 * Credential row, envelope-encrypted; nothing here holds a secret.
 */

export type ConnectorKind =
  | 'inference'
  | 'deployment'
  | 'memory'
  | 'mcp'
  | 'tool_source'
  | 'channel'
  | 'cloud'
  | 'registry';

export const CONNECTOR_KINDS: readonly ConnectorKind[] = [
  'inference', 'deployment', 'memory', 'mcp', 'tool_source', 'channel', 'cloud', 'registry',
];

export type ConnectMethodType =
  | 'oauth2_pkce'
  | 'oauth2_code'
  | 'oauth2_client_credentials'
  | 'api_key'
  | 'cloud_iam'
  | 'service_account'
  | 'installation';

export const CONNECT_METHOD_TYPES: readonly ConnectMethodType[] = [
  'oauth2_pkce', 'oauth2_code', 'oauth2_client_credentials', 'api_key', 'cloud_iam', 'service_account', 'installation',
];

/** Methods that redirect the user to the provider and finish on the callback. */
export const REDIRECT_METHODS: readonly ConnectMethodType[] = ['oauth2_pkce', 'oauth2_code', 'installation'];

export type ConnectionHealthStatus = 'valid' | 'failed' | 'expired' | 'revoked' | 'quota' | 'unknown';

export const CONNECTION_HEALTH_STATUSES: readonly ConnectionHealthStatus[] = [
  'valid', 'failed', 'expired', 'revoked', 'quota', 'unknown',
];

export type ConnectionOwner = 'org' | 'user';

export interface JsonSchemaProperty {
  type: 'string' | 'integer' | 'number' | 'boolean';
  title?: string;
  description?: string;
  /** Encrypted at rest, never returned by the API. */
  'x-secret'?: boolean;
  format?: string;
  default?: unknown;
  enum?: unknown[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface JsonSchemaObject {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * OAuth2 endpoints for a redirect method. Everything provider-specific
 * is expressed as data so OpenRouter's non-standard flow (no client id,
 * `callback_url` instead of `redirect_uri`, JSON token exchange that
 * returns `key`) fits the same code path as an RFC 6749 provider.
 */
export interface OAuth2Config {
  authorizeUrl: string;
  tokenUrl: string;
  scopes?: string[];
  /** PKCE S256; the verifier is kept server-side keyed by state. */
  pkce?: boolean;
  /** Where the state travels: a `state` query param (default) or inside the callback URL's query. */
  stateVia?: 'param' | 'callback_query';
  /** Query param carrying our callback URL (default `redirect_uri`). */
  callbackParam?: string;
  /**
   * `none`: a public flow with no client registration (OpenRouter).
   * `platform`: reads CONNECTIONS_OAUTH_<KEY>_CLIENT_ID / _CLIENT_SECRET.
   */
  clientId?: 'none' | 'platform';
  /** Token exchange body encoding (default `form`). */
  tokenRequest?: 'form' | 'json';
  /** Field of the token response holding the secret (default `access_token`). */
  tokenField?: string;
  refreshField?: string;
  /** Provider prints the code on-screen when no callback URL is sent (headless / CLI mode). */
  headlessCode?: boolean;
  /** Extra static query params for the authorize URL. */
  extraAuthorizeParams?: Record<string, string>;
}

export interface CloudQuickCreate {
  /** CloudFormation quick-create link template; `{{externalId}}` and `{{stackName}}` are filled in per org. */
  templateUrl: string;
  stackName: string;
  params?: Record<string, string>;
}

export interface ConnectMethod {
  type: ConnectMethodType;
  label?: string;
  description?: string;
  /** What the user must supply; secret fields carry `x-secret`. */
  schema?: JsonSchemaObject;
  oauth?: OAuth2Config;
  quickCreate?: CloudQuickCreate;
  /** Deep link to where the user creates the key. Falls back to the connector's keyPageUrl. */
  keyPageUrl?: string;
  /** The Credential.type the stored row gets (default `api_key`). */
  credentialType?: string;
  /** Config field the OAuth token lands in (default `apiKey` for PKCE key flows, `accessToken` otherwise). */
  secretField?: string;
}

export type HttpAuthStyle = 'bearer' | 'header' | 'query' | 'basic' | 'none';

export interface HttpProbe {
  kind: 'http';
  /** May reference non-secret form values as `{{field}}`. */
  url: string;
  method?: 'GET' | 'POST' | 'DELETE';
  auth?: HttpAuthStyle;
  headerName?: string;
  queryParam?: string;
  /** Config field holding the secret (default `apiKey`). */
  secretField?: string;
  /** Second config field for basic auth (default `apiSecret`). */
  usernameField?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Dot path into the JSON response that names the account, e.g. `data.label`. */
  accountLabelPath?: string;
  /** Environment variable that, when `true`, allows private/loopback URLs (Ollama on localhost). */
  privateUrlsEnv?: string;
}

export interface FormatValidation {
  kind: 'format';
  /** Field name to regex source; every listed field present must match. */
  fields?: Record<string, string>;
  /** Config field used as the account label. */
  accountLabelFrom?: string;
  /** URL fields that must be public http(s). */
  urlFields?: string[];
}

export type ValidationSpec =
  | HttpProbe
  | FormatValidation
  | { kind: 'aws_caller_identity' }
  | { kind: 'aws_assume_role' }
  | { kind: 'gcp_service_account' }
  | { kind: 'oauth2_client_credentials'; tokenUrl: string; scope: string }
  | { kind: 's3_bucket' }
  | { kind: 'mcp_initialize' };

export const VALIDATION_KINDS = [
  'http', 'format', 'aws_caller_identity', 'aws_assume_role', 'gcp_service_account',
  'oauth2_client_credentials', 's3_bucket', 'mcp_initialize',
] as const;

export interface ConnectorDefinition {
  key: string;
  kind: ConnectorKind;
  displayName: string;
  description?: string;
  /** Ranked best-first. */
  connect: ConnectMethod[];
  capabilities?: string[];
  scopesNeeded?: string[];
  validation: ValidationSpec;
  /** Provider-side revoke called on disconnect when declared. */
  revoke?: HttpProbe;
  pricingSource?: string;
  keyPageUrl?: string | null;
  docsUrl?: string | null;
  /** Deployment adapter this connector feeds (kind `deployment`). */
  adapterKey?: string;
  /** LlmProviderType this connector feeds (kind `inference`). */
  providerType?: string;
  /** Set on org-defined connectors. */
  organizationId?: string;
}

export interface ValidationResult {
  ok: boolean;
  status: ConnectionHealthStatus;
  accountLabel?: string;
  scopesGranted?: string[];
  error?: string;
}

export interface ConnectionView {
  id: string;
  connectorKey: string;
  connectorDisplayName: string;
  kind: ConnectorKind | null;
  name: string;
  owner: ConnectionOwner;
  ownerUserId: string | null;
  method: ConnectMethodType | null;
  accountLabel: string | null;
  health: { status: ConnectionHealthStatus; checkedAt: Date | null; error: string | null };
  scopesGranted: string[];
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
