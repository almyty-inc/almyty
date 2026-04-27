// Universal Tool Calling Protocol (UTCP) Types
// Spec: https://utcp.io — RFC: https://github.com/universal-tool-calling-protocol/utcp-specification
//
// Field names are snake_case per the spec. UTCP clients (python-utcp,
// typescript-utcp, go-utcp) parse the manual against these exact fields,
// so renaming or wrapping them breaks SDK compatibility.

export interface UtcpManual {
  utcp_version: string;
  manual_version: string;
  tools: UtcpTool[];
}

export interface UtcpTool {
  name: string;
  description: string;
  inputs: any;  // JsonSchema
  outputs: any; // JsonSchema
  tags: string[];
  average_response_size?: number;
  tool_call_template: UtcpCallTemplate;
}

export type UtcpCallTemplate = UtcpHttpCallTemplate;

export interface UtcpHttpCallTemplate {
  call_template_type: 'http';
  url: string;
  http_method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  content_type?: string;
  headers?: Record<string, string>;
  body_field?: string;
  header_fields?: string[];
  auth?: UtcpAuth;
}

export type UtcpAuth = UtcpApiKeyAuth | UtcpBasicAuth | UtcpOAuth2Auth;

export interface UtcpApiKeyAuth {
  auth_type: 'api_key';
  api_key: string;
  var_name: string;
  location: 'header' | 'query' | 'cookie';
}

export interface UtcpBasicAuth {
  auth_type: 'basic';
  username: string;
  password: string;
}

export interface UtcpOAuth2Auth {
  auth_type: 'oauth2';
  client_id: string;
  client_secret: string;
  token_url: string;
  scope?: string;
}

// UTCP execution (proxy mode — almyty extension; not part of the spec)
export interface UtcpExecutionContext {
  toolId: string;
  parameters: Record<string, any>;
  options?: {
    timeout?: number;
    retries?: number;
    skipCache?: boolean;
  };
}

export interface UtcpExecutionResult {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  metadata: {
    executionTime: number;
    toolId: string;
    requestId: string;
    timestamp: string;
    cached?: boolean;
    retryCount?: number;
    httpStatus?: number;
  };
}

// Discovery descriptor served at /.well-known/utcp.
// almyty extension — the spec doesn't mandate a discovery endpoint, but
// SDKs and tooling expect a stable surface that points to the manual
// and surfaces the gateway's auth requirements.
export interface UtcpDiscoveryInfo {
  utcp_version: string;
  manual_version: string;
  manual_url: string;
  // Convenience hint so clients don't have to construct the URL by
  // string-replacing /manual → /execute. Not part of the spec; UTCP
  // SDKs ignore unknown fields, so this is purely additive.
  execute_url: string;
  auth?: UtcpAuth | UtcpAuth[];
  server: {
    name: string;
    version: string;
    description?: string;
  };
}
