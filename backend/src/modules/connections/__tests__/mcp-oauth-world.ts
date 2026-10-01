import { createHash } from 'crypto';

import { FixtureRoute } from './test-support';

/**
 * A scripted OAuth-protected MCP server and its authorization server, for
 * the MCP sign-in specs. Not a `.spec.ts`: jest collects only those.
 */
export const SERVER = 'https://mcp.example.com/mcp';
export const ISSUER = 'https://auth.example.com';

export interface WorldOptions {
  cimd?: boolean;
  issParameter?: boolean;
  registration?: boolean;
  challenge?: boolean;
  /** What the server's metadata says about itself. */
  resource?: string;
  asIssuer?: string;
  pkce?: string[];
  authMethods?: string[];
}

/** A scripted MCP server and its authorization server. */
export function world(opts: WorldOptions = {}) {
  const codes = new Map<string, { challenge: string; clientId: string; redirectUri: string; resource: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Map<string, string>(); // refresh -> client id
  const registrations: any[] = [];
  const tokenRequests: Array<{ fields: URLSearchParams; headers: Record<string, string> }> = [];
  let issued = 0;

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, body, headers });
  const exact = (url: string) => new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

  const mint = (clientId: string) => {
    issued += 1;
    const access = `at-${issued}`;
    const refresh = `rt-${issued}`;
    accessTokens.add(access);
    refreshTokens.set(refresh, clientId);
    return json(200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: 'files:read' });
  };

  const routes: FixtureRoute[] = [
    {
      method: 'POST',
      url: exact(SERVER),
      handle: (_url, init) => {
        const auth = String((init.headers as Record<string, string>)?.Authorization ?? '');
        if (accessTokens.has(auth.replace(/^Bearer /, ''))) {
          return json(200, { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'Docs MCP', version: '1' } } });
        }
        return json(401, { error: 'unauthorized' }, opts.challenge === false ? {} : {
          'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="files:read"`,
        });
      },
    },
    {
      url: exact('https://mcp.example.com/.well-known/oauth-protected-resource/mcp'),
      handle: () => json(200, { resource: opts.resource ?? SERVER, authorization_servers: [ISSUER], scopes_supported: ['files:read', 'files:write'] }),
    },
    { url: /^https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource$/, handle: () => json(404, {}) },
    {
      url: exact(`${ISSUER}/.well-known/oauth-authorization-server`),
      handle: () => json(200, {
        issuer: opts.asIssuer ?? ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        revocation_endpoint: `${ISSUER}/revoke`,
        ...(opts.registration === false ? {} : { registration_endpoint: `${ISSUER}/register` }),
        code_challenge_methods_supported: opts.pkce ?? ['S256'],
        token_endpoint_auth_methods_supported: opts.authMethods ?? ['none', 'client_secret_basic'],
        client_id_metadata_document_supported: opts.cimd === true,
        authorization_response_iss_parameter_supported: opts.issParameter !== false,
      }),
    },
    {
      method: 'POST',
      url: exact(`${ISSUER}/register`),
      handle: (_url, init) => {
        const body = JSON.parse(String(init.body));
        registrations.push(body);
        return json(201, { client_id: `dcr-client-${registrations.length}`, ...body });
      },
    },
    {
      method: 'POST',
      url: exact(`${ISSUER}/token`),
      handle: (_url, init) => {
        const fields = new URLSearchParams(String(init.body));
        const headers = (init.headers ?? {}) as Record<string, string>;
        tokenRequests.push({ fields, headers });
        const basic = headers.Authorization?.startsWith('Basic ')
          ? Buffer.from(headers.Authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent)
          : null;
        const clientId = basic?.[0] ?? fields.get('client_id');
        if (fields.get('resource') !== SERVER) return json(400, { error: 'invalid_target' });
        if (fields.get('grant_type') === 'authorization_code') {
          const code = codes.get(fields.get('code') ?? '');
          if (!code || code.clientId !== clientId || code.redirectUri !== fields.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
          const challenge = createHash('sha256').update(fields.get('code_verifier') ?? '').digest('base64url');
          if (challenge !== code.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
          codes.delete(fields.get('code')!);
          return mint(clientId!);
        }
        if (fields.get('grant_type') === 'refresh_token') {
          const owner = refreshTokens.get(fields.get('refresh_token') ?? '');
          if (!owner || owner !== clientId) return json(400, { error: 'invalid_grant' });
          refreshTokens.delete(fields.get('refresh_token')!);
          return mint(owner);
        }
        return json(400, { error: 'unsupported_grant_type' });
      },
    },
    { method: 'POST', url: exact(`${ISSUER}/revoke`), handle: () => json(200, {}) },
    // Any other metadata path: not found, as on a real server.
    { url: /\/\.well-known\//, handle: () => json(404, {}) },
  ];

  return {
    routes,
    registrations,
    tokenRequests,
    accessTokens,
    /** The person approves at the authorization server; the browser comes back with a code (and iss). */
    approve(authorizeUrl: string, iss: string | null = ISSUER) {
      const u = new URL(authorizeUrl);
      const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2)}`;
      codes.set(code, {
        challenge: u.searchParams.get('code_challenge')!,
        clientId: u.searchParams.get('client_id')!,
        redirectUri: u.searchParams.get('redirect_uri')!,
        resource: u.searchParams.get('resource')!,
      });
      return { code, state: u.searchParams.get('state')!, ...(iss ? { iss } : {}) };
    },
  };
}

