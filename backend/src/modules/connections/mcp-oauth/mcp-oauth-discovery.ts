/**
 * The pure half of signing in to a remote MCP server (MCP 2025-06-18 and
 * later, "Authorization"): where its metadata lives and what a usable
 * answer looks like. The service (mcp-oauth-client.service.ts) does the
 * fetching; everything here is a function of strings and JSON, so the
 * rules are tested without a network.
 *
 *  1. The server answers an unauthenticated request with 401 and
 *     `WWW-Authenticate: Bearer resource_metadata="..."` (RFC 9728 §5.1).
 *  2. Its Protected Resource Metadata names the resource and the
 *     authorization servers that issue tokens for it (RFC 9728).
 *  3. The authorization server's metadata (RFC 8414, or OpenID Connect
 *     Discovery) names the endpoints, and whether it takes a client
 *     metadata document as client id and sends `iss` back.
 */

export interface WwwAuthenticateBearer {
  resourceMetadata?: string;
  scope?: string;
  error?: string;
}

/**
 * The Bearer challenge's parameters. Tolerant of several challenges in one
 * header and of quoted or bare values; only the Bearer one is read. A
 * plain scan rather than a regex: the header is the remote's to choose.
 */
export function parseWwwAuthenticate(header: string | null | undefined): WwwAuthenticateBearer | null {
  if (!header) return null;
  const at = header.search(/\bbearer\b/i);
  if (at < 0) return null;
  const text = header.slice(at + 'bearer'.length);
  const out: WwwAuthenticateBearer = {};
  const isNameChar = (c: string) => /[A-Za-z0-9_-]/.test(c);
  let i = 0;
  while (i < text.length) {
    while (i < text.length && (text[i] === ' ' || text[i] === ',' || text[i] === '\t')) i++;
    const start = i;
    while (i < text.length && isNameChar(text[i])) i++;
    const name = text.slice(start, i).toLowerCase();
    while (i < text.length && text[i] === ' ') i++;
    // A bare word is the next challenge's scheme: this one ends here.
    if (text[i] !== '=') {
      if (name) break;
      i++;
      continue;
    }
    i++;
    while (i < text.length && text[i] === ' ') i++;
    let value = '';
    if (text[i] === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) i++;
        value += text[i];
        i++;
      }
      i++;
    } else {
      const from = i;
      while (i < text.length && text[i] !== ',' && text[i] !== ' ') i++;
      value = text.slice(from, i);
    }
    if (name === 'resource_metadata') out.resourceMetadata = value;
    else if (name === 'scope') out.scope = value;
    else if (name === 'error') out.error = value;
  }
  return out;
}

/** The URL or path without trailing slashes (a loop: no backtracking on remote input). */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

function trimSlash(path: string): string {
  return stripTrailingSlashes(path);
}

/** Where a server's Protected Resource Metadata may be, most specific first (RFC 9728 §3.1). */
export function protectedResourceMetadataUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = trimSlash(u.pathname);
  const urls = path ? [`${u.origin}/.well-known/oauth-protected-resource${path}`] : [];
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/**
 * Where an authorization server's metadata may be (MCP "Authorization
 * Server Metadata Discovery"): RFC 8414 with the path inserted, OpenID
 * Connect with the path inserted, OpenID Connect with the path appended;
 * an issuer without a path has the two root forms.
 */
export function authorizationServerMetadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = trimSlash(u.pathname);
  if (!path) {
    return [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

export interface ProtectedResource {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * A Protected Resource Metadata document for `serverUrl`, or why it is not
 * one. Its `resource` must be the server itself: the same origin, and the
 * server's path inside the resource's (RFC 9728 §3.3 forbids using metadata
 * that names another resource, which would let one server collect tokens
 * meant for another).
 */
export function checkProtectedResource(doc: unknown, serverUrl: string): ProtectedResource | string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'the protected resource metadata is not a JSON object';
  const d = doc as Record<string, unknown>;
  if (!isHttpUrl(d.resource)) return 'the protected resource metadata names no resource';
  const resource = new URL(d.resource);
  const server = new URL(serverUrl);
  const resourcePath = trimSlash(resource.pathname);
  const serverPath = trimSlash(server.pathname);
  if (resource.origin !== server.origin || !(serverPath === resourcePath || serverPath.startsWith(`${resourcePath}/`))) {
    return `the protected resource metadata is for ${resource.origin}${resourcePath || '/'}, not for this server`;
  }
  const servers = Array.isArray(d.authorization_servers) ? d.authorization_servers.filter(isHttpUrl) : [];
  if (!servers.length) return 'the protected resource metadata names no authorization server';
  const scopes = Array.isArray(d.scopes_supported) ? d.scopes_supported.filter((s): s is string => typeof s === 'string') : [];
  return { resource: d.resource, authorizationServers: servers, scopesSupported: scopes };
}

export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  /** The server takes a client metadata document URL as client_id (CIMD). */
  clientIdMetadataDocumentSupported: boolean;
  /** RFC 9207: the server sends `iss` with the authorization response. */
  issParameterSupported: boolean;
  tokenEndpointAuthMethods: string[];
  scopesSupported: string[];
}

/**
 * Authorization server metadata for `issuer`, or why it is unusable. The
 * issuer must be the one asked for (RFC 8414 §3.3: metadata naming another
 * issuer is an impersonation attempt), and PKCE with S256 must be offered:
 * MCP clients must not sign in without it.
 */
export function checkAuthorizationServer(doc: unknown, issuer: string): AuthorizationServer | string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'the authorization server metadata is not a JSON object';
  const d = doc as Record<string, unknown>;
  if (typeof d.issuer !== 'string' || stripTrailingSlashes(d.issuer) !== stripTrailingSlashes(issuer)) {
    return `the authorization server metadata is for issuer ${String(d.issuer)}, not ${issuer}`;
  }
  if (!isHttpUrl(d.authorization_endpoint) || !isHttpUrl(d.token_endpoint)) {
    return 'the authorization server metadata has no authorization or token endpoint';
  }
  const pkce = Array.isArray(d.code_challenge_methods_supported) ? d.code_challenge_methods_supported : [];
  if (!pkce.includes('S256')) return 'the authorization server does not offer PKCE with S256, which signing in requires';
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
  return {
    issuer: d.issuer,
    authorizationEndpoint: d.authorization_endpoint,
    tokenEndpoint: d.token_endpoint,
    registrationEndpoint: isHttpUrl(d.registration_endpoint) ? d.registration_endpoint : null,
    revocationEndpoint: isHttpUrl(d.revocation_endpoint) ? d.revocation_endpoint : null,
    clientIdMetadataDocumentSupported: d.client_id_metadata_document_supported === true,
    issParameterSupported: d.authorization_response_iss_parameter_supported === true,
    tokenEndpointAuthMethods: list(d.token_endpoint_auth_methods_supported),
    scopesSupported: list(d.scopes_supported),
  };
}

/** The scope to ask for: what the server's challenge named, else what its metadata lists. */
export function scopeToRequest(challenge: WwwAuthenticateBearer | null, resource: ProtectedResource, explicit?: string): string | null {
  const chosen = (explicit ?? '').trim() || challenge?.scope?.trim() || resource.scopesSupported.join(' ');
  return chosen || null;
}
