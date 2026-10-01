import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Credential, CredentialType } from '../../../entities/credential.entity';
import { validateUrl, validateUrlAllowingPrivate } from '../../../common/security/url-validator';
import { ssrfSafeDispatcher } from '../../../common/security/safe-fetch';
import { dispatcherExempting } from '../../../common/security/exempt-dispatcher';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { mcpOAuthClientSettings } from './mcp-oauth-client.settings';
import {
  AuthorizationServer,
  ProtectedResource,
  WwwAuthenticateBearer,
  authorizationServerMetadataUrls,
  checkAuthorizationServer,
  checkProtectedResource,
  parseWwwAuthenticate,
  protectedResourceMetadataUrls,
  scopeToRequest,
  stripTrailingSlashes,
} from './mcp-oauth-discovery';

/** The outbound HTTP call; specs bind a fixture here. */
export type McpOAuthHttp = (url: string, init: RequestInit) => Promise<Response>;
export const MCP_OAUTH_CLIENT_HTTP = Symbol('MCP_OAUTH_CLIENT_HTTP');

/** The path the almyty client metadata document is served at, on the API origin. */
export const CLIENT_METADATA_PATH = '/credentials/oauth/client-metadata.json';

/** The connector this sign-in belongs to. */
export const MCP_CONNECTOR_KEY = 'mcp-custom';

/**
 * Every outbound call is pinned and follows no redirect: the URL string is
 * checked first (no private or loopback address unless
 * MCP_ALLOW_PRIVATE_URLS), and the dispatcher checks what the name resolves
 * to when it connects. The deadline is MCP_CLIENT_OAUTH_FETCH_TIMEOUT_MS.
 */
export function defaultMcpOAuthHttp(): McpOAuthHttp {
  return (url, init) => {
    const settings = mcpOAuthClientSettings();
    return fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(settings.fetchTimeoutMs),
      dispatcher: settings.allowPrivateUrls ? dispatcherExempting(new URL(url).hostname) : ssrfSafeDispatcher,
    } as RequestInit);
  };
}

/** How almyty is known to the authorization server. */
export type McpClientRegistration = 'pre_registered' | 'cimd' | 'dcr';

/**
 * What a sign-in needs between the authorize redirect and the callback.
 * Kept server-side in the connect state; the client secret (only for a
 * pre-registered client, or one a registration handed out) is encrypted.
 */
export interface McpOAuthPending {
  serverUrl: string;
  issuer: string;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
  clientId: string;
  /** Envelope-encrypted for the organization; null for a public client. */
  clientSecret: string | null;
  tokenAuthMethod: 'none' | 'client_secret_basic' | 'client_secret_post';
  /** The server says it sends `iss` back (RFC 9207), so a callback without it is refused. */
  requireIss: boolean;
  scope: string | null;
  registration: McpClientRegistration;
}

/** Tokens from a token endpoint. */
export interface McpOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

/** What `ensureFresh` found. */
export type McpOAuthFreshness =
  | { status: 'not_mcp_oauth' }
  | { status: 'fresh' }
  | { status: 'refreshed' }
  | { status: 'reconnect'; error: string }
  | { status: 'unavailable'; error: string };

function refuse(message: string): never {
  throw new BadRequestException({ code: 'MCP_SIGN_IN_FAILED', message });
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Signing in to a remote MCP server for an MCP source (owner decision 11,
 * docs/design/mcp-2026-07-28.md "Client side"):
 *
 *  - discovery: the server's 401 names its Protected Resource Metadata
 *    (else the well-known path), which names its authorization server,
 *    whose metadata (RFC 8414, else OpenID Connect) names the endpoints;
 *  - who almyty is: a client id entered on the connection, else the almyty
 *    client metadata document (CIMD) when the server accepts one, else a
 *    dynamic registration (application_type "web");
 *  - the sign-in: PKCE S256, `resource` (RFC 8707) on authorize and token
 *    requests, `iss` checked on the way back (RFC 9207);
 *  - the tokens: kept only in the connection's credential row, with the
 *    issuer that issued them. They are refreshed before they expire, and on a
 *    401 the server's metadata is read again: a server that now names
 *    another authorization server gets no token of the old one, and the
 *    connection asks to be signed in again (SEP-2352).
 */
@Injectable()
export class McpOAuthClientService {
  private readonly logger = new Logger(McpOAuthClientService.name);
  private readonly http: McpOAuthHttp;
  private readonly refreshing = new Map<string, Promise<McpOAuthFreshness>>();

  constructor(
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    private readonly envelope: EnvelopeCryptoService,
    @Optional() @Inject(MCP_OAUTH_CLIENT_HTTP) http?: McpOAuthHttp,
  ) {
    this.http = http ?? defaultMcpOAuthHttp();
  }

  // ------------------------------------------------------------------
  // The almyty client metadata document (CIMD)
  // ------------------------------------------------------------------

  /** The document's URL, which is also almyty's client id where a server takes one. */
  clientMetadataUrl(apiBase: string): string {
    return `${apiBase.replace(/\/$/, '')}${CLIENT_METADATA_PATH}`;
  }

  /** The document itself (draft-ietf-oauth-client-id-metadata-document): who almyty is and where it signs in. */
  clientMetadataDocument(apiBase: string, callbackUrl: string, frontendUrl?: string | null): Record<string, unknown> {
    const settings = mcpOAuthClientSettings();
    return {
      client_id: this.clientMetadataUrl(apiBase),
      client_name: settings.clientName,
      ...(frontendUrl ? { client_uri: frontendUrl.replace(/\/$/, '') } : {}),
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    };
  }

  // ------------------------------------------------------------------
  // Outbound calls
  // ------------------------------------------------------------------

  private guard(url: string): void {
    const check = mcpOAuthClientSettings().allowPrivateUrls ? validateUrlAllowingPrivate(url) : validateUrl(url);
    if (!check.valid) refuse(`${host(url)} cannot be reached from almyty: ${check.error ?? 'address refused'}`);
  }

  /** The body, read up to MCP_CLIENT_OAUTH_MAX_BYTES. */
  private async readCapped(res: Response): Promise<string> {
    const max = mcpOAuthClientSettings().maxBytes;
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        refuse(`${host(res.url || 'the server')} answered with more than ${max} bytes`);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  }

  private async call(url: string, init: RequestInit): Promise<{ status: number; headers: Headers; text: string; json: any }> {
    this.guard(url);
    let res: Response;
    try {
      res = await this.http(url, init);
    } catch (e: any) {
      refuse(`could not reach ${host(url)}: ${e?.message ?? e}`);
    }
    const text = await this.readCapped(res);
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  private async getJson(url: string): Promise<{ status: number; json: any }> {
    const res = await this.call(url, { method: 'GET', headers: { Accept: 'application/json' } });
    return { status: res.status, json: res.json };
  }

  // ------------------------------------------------------------------
  // Discovery
  // ------------------------------------------------------------------

  /**
   * Ask the server without a token, read its challenge, and follow it to
   * the authorization server. A server that does not ask for sign-in is
   * told apart from one whose sign-in is broken.
   */
  async discover(serverUrl: string): Promise<{ challenge: WwwAuthenticateBearer | null; resource: ProtectedResource; server: AuthorizationServer }> {
    const { challenge, resource } = await this.discoverResource(serverUrl);
    const server = await this.authorizationServer(resource.authorizationServers[0]);
    return { challenge, resource, server };
  }

  /** The server's challenge and its Protected Resource Metadata: who issues tokens for it. */
  async discoverResource(serverUrl: string): Promise<{ challenge: WwwAuthenticateBearer | null; resource: ProtectedResource }> {
    this.guard(serverUrl);
    const probe = await this.call(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: mcpOAuthClientSettings().clientName, version: '1' } } }),
    });
    const challenge = probe.status === 401 ? parseWwwAuthenticate(probe.headers.get('www-authenticate')) : null;
    if (probe.status !== 401 && probe.status !== 403) {
      refuse(`${host(serverUrl)} did not ask for sign-in (it answered ${probe.status}). Add it with a token, or without one.`);
    }
    return { challenge, resource: await this.protectedResource(serverUrl, challenge) };
  }

  private async protectedResource(serverUrl: string, challenge: WwwAuthenticateBearer | null): Promise<ProtectedResource> {
    const candidates = challenge?.resourceMetadata ? [challenge.resourceMetadata] : protectedResourceMetadataUrls(serverUrl);
    let why = 'it publishes no protected resource metadata';
    for (const url of candidates) {
      const { status, json } = await this.getJson(url);
      if (status !== 200) continue;
      const checked = checkProtectedResource(json, serverUrl);
      if (typeof checked !== 'string') return checked;
      why = checked;
    }
    refuse(`${host(serverUrl)} cannot be signed in to: ${why}.`);
  }

  private async authorizationServer(issuer: string): Promise<AuthorizationServer> {
    let why = 'it publishes no authorization server metadata';
    for (const url of authorizationServerMetadataUrls(issuer)) {
      const { status, json } = await this.getJson(url);
      if (status !== 200) continue;
      const checked = checkAuthorizationServer(json, issuer);
      if (typeof checked !== 'string') return checked;
      why = checked;
    }
    refuse(`the sign-in service ${host(issuer)} cannot be used: ${why}.`);
  }

  // ------------------------------------------------------------------
  // Registration and the sign-in
  // ------------------------------------------------------------------

  /**
   * Everything the sign-in needs, before the browser leaves: discovery, then
   * who almyty is at this authorization server, in order: the client id
   * entered on the connection, the almyty client metadata document when the
   * server takes one (and it is served over https), a dynamic registration.
   */
  async prepareSignIn(args: {
    organizationId: string;
    serverUrl: string;
    callbackUrl: string;
    apiBase: string;
    frontendUrl?: string | null;
    clientId?: string;
    clientSecret?: string;
    scope?: string;
  }): Promise<McpOAuthPending> {
    const { challenge, resource, server } = await this.discover(args.serverUrl);
    this.guard(server.authorizationEndpoint);
    this.guard(server.tokenEndpoint);
    const settings = mcpOAuthClientSettings();
    const scope = scopeToRequest(challenge, resource, args.scope);
    const base = {
      serverUrl: args.serverUrl,
      issuer: server.issuer,
      resource: resource.resource,
      authorizationEndpoint: server.authorizationEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      revocationEndpoint: server.revocationEndpoint,
      requireIss: server.issParameterSupported,
      scope,
    };

    const preId = (args.clientId ?? '').trim();
    if (preId) {
      const secret = (args.clientSecret ?? '').trim();
      return {
        ...base,
        clientId: preId,
        clientSecret: secret ? await this.envelope.encryptForOrg(args.organizationId, secret) : null,
        tokenAuthMethod: secret ? (server.tokenEndpointAuthMethods.includes('client_secret_post') && !server.tokenEndpointAuthMethods.includes('client_secret_basic') ? 'client_secret_post' : 'client_secret_basic') : 'none',
        registration: 'pre_registered',
      };
    }

    const metadataUrl = this.clientMetadataUrl(args.apiBase);
    if (settings.cimdEnabled && server.clientIdMetadataDocumentSupported && metadataUrl.startsWith('https://')) {
      return { ...base, clientId: metadataUrl, clientSecret: null, tokenAuthMethod: 'none', registration: 'cimd' };
    }

    if (server.registrationEndpoint) {
      this.guard(server.registrationEndpoint);
      const doc = this.clientMetadataDocument(args.apiBase, args.callbackUrl, args.frontendUrl);
      delete (doc as any).client_id;
      const res = await this.call(server.registrationEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ...doc, ...(scope ? { scope } : {}) }),
      });
      if ((res.status !== 200 && res.status !== 201) || typeof res.json?.client_id !== 'string') {
        const detail = res.json?.error_description ?? res.json?.error ?? res.text.slice(0, 160);
        refuse(`${host(server.issuer)} did not register almyty (${res.status}${detail ? `: ${detail}` : ''}). Enter a client id under Advanced.`);
      }
      const secret = typeof res.json.client_secret === 'string' && res.json.client_secret ? res.json.client_secret : null;
      return {
        ...base,
        clientId: res.json.client_id,
        clientSecret: secret ? await this.envelope.encryptForOrg(args.organizationId, secret) : null,
        tokenAuthMethod: secret ? (res.json.token_endpoint_auth_method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic') : 'none',
        registration: 'dcr',
      };
    }

    refuse(`${host(server.issuer)} needs almyty to be registered in advance. Enter the client id it gave you under Advanced.`);
  }

  /** The authorize URL the browser is sent to. */
  authorizeUrl(pending: McpOAuthPending, args: { state: string; codeChallenge: string; callbackUrl: string }): string {
    const url = new URL(pending.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', pending.clientId);
    url.searchParams.set('redirect_uri', args.callbackUrl);
    url.searchParams.set('state', args.state);
    url.searchParams.set('code_challenge', args.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('resource', pending.resource);
    if (pending.scope) url.searchParams.set('scope', pending.scope);
    return url.toString();
  }

  /**
   * The callback's `iss` against the issuer the sign-in started with (RFC
   * 9207): a different one is a mix-up attack; a missing one is refused when
   * the server said it sends it.
   */
  checkIssuer(pending: Pick<McpOAuthPending, 'issuer' | 'requireIss'>, iss: string | undefined | null): void {
    if (iss === undefined || iss === null || iss === '') {
      if (pending.requireIss) refuse('the sign-in came back without saying who issued it (iss), which this server promised to send');
      return;
    }
    if (stripTrailingSlashes(iss) !== stripTrailingSlashes(pending.issuer)) {
      refuse(`the sign-in came back from ${host(iss)}, not from ${host(pending.issuer)}, where it started`);
    }
  }

  /** Client authentication at the token and revocation endpoints; `secret` is plaintext. */
  private clientAuth(
    client: { clientId: string; secret: string | null; tokenAuthMethod: McpOAuthPending['tokenAuthMethod'] },
    fields: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    const secret = client.secret;
    if (secret && client.tokenAuthMethod === 'client_secret_basic') {
      headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(secret)}`).toString('base64')}`;
    } else {
      fields.client_id = client.clientId;
      if (secret) fields.client_secret = secret;
    }
    return headers;
  }

  private async tokenRequest(
    tokenEndpoint: string,
    client: { clientId: string; secret: string | null; tokenAuthMethod: McpOAuthPending['tokenAuthMethod'] },
    fields: Record<string, string>,
  ): Promise<McpOAuthTokens | { error: string; status: number; oauthError: string | null }> {
    const headers = this.clientAuth(client, fields);
    const res = await this.call(tokenEndpoint, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
    const data = res.json ?? {};
    if (res.status !== 200 || data.error || typeof data.access_token !== 'string' || !data.access_token) {
      const detail = data.error_description ?? data.error ?? res.text.slice(0, 160);
      return { error: `${res.status}${detail ? `: ${detail}` : ''}`, status: res.status, oauthError: typeof data.error === 'string' ? data.error : null };
    }
    if (typeof data.token_type === 'string' && data.token_type.toLowerCase() !== 'bearer') {
      return { error: `the token is of type ${data.token_type}, and only bearer tokens are supported`, status: res.status, oauthError: null };
    }
    const expiresIn = Number(data.expires_in);
    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : null,
      expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
      scope: typeof data.scope === 'string' ? data.scope : null,
    };
  }

  /** The code for tokens: PKCE verifier, the same redirect URI, and `resource`. */
  async exchangeCode(
    organizationId: string,
    pending: McpOAuthPending,
    args: { code: string; codeVerifier: string; callbackUrl: string },
  ): Promise<McpOAuthTokens> {
    const secret = pending.clientSecret ? await this.envelope.decryptForOrg(organizationId, pending.clientSecret) : null;
    const out = await this.tokenRequest(pending.tokenEndpoint, { clientId: pending.clientId, secret, tokenAuthMethod: pending.tokenAuthMethod }, {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.callbackUrl,
      code_verifier: args.codeVerifier,
      resource: pending.resource,
    });
    if ('error' in out) refuse(`${host(pending.issuer)} did not hand out a token (${out.error})`);
    return out;
  }

  /** The connection config a finished sign-in stores; secrets are encrypted by the caller (ConnectionsService.finalize). */
  connectionConfig(pending: McpOAuthPending, tokens: McpOAuthTokens): Record<string, unknown> {
    return {
      serverUrl: pending.serverUrl,
      accessToken: tokens.accessToken,
      ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
      tokenType: 'Bearer',
      tokenEndpoint: pending.tokenEndpoint,
      oauthIssuer: pending.issuer,
      oauthResource: pending.resource,
      oauthClientId: pending.clientId,
      ...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
      oauthTokenAuth: pending.tokenAuthMethod,
      oauthRegistration: pending.registration,
      ...(pending.revocationEndpoint ? { oauthRevocationEndpoint: pending.revocationEndpoint } : {}),
      ...(pending.scope ? { oauthScope: pending.scope } : {}),
    };
  }

  // ------------------------------------------------------------------
  // Using the tokens
  // ------------------------------------------------------------------

  /** Whether a credential row is an MCP server sign-in made here. */
  static isMcpSignIn(row: Pick<Credential, 'type' | 'connectorKey' | 'config'> | null | undefined): boolean {
    return !!row && row.type === CredentialType.OAUTH2 && row.connectorKey === MCP_CONNECTOR_KEY && typeof row.config?.oauthIssuer === 'string';
  }

  private async decrypted(row: Credential): Promise<Record<string, any>> {
    const out: Record<string, any> = { ...(row.config ?? {}) };
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && v.startsWith('encrypted:')) out[k] = await this.envelope.decryptForOrg(row.organizationId, v);
    }
    return out;
  }

  private async markReconnect(row: Credential, error: string): Promise<McpOAuthFreshness> {
    row.healthStatus = 'expired';
    row.healthCheckedAt = new Date();
    row.healthError = error;
    await this.credentials.save(row);
    this.logger.warn(`MCP sign-in ${row.id} needs signing in again: ${error}`);
    return { status: 'reconnect', error };
  }

  /**
   * Make sure the credential's access token is usable: refreshed when it
   * expires within MCP_CLIENT_OAUTH_REFRESH_SKEW_SECONDS, or now with
   * `force` (the server answered 401). With `force` the server's metadata is
   * read again first: a token is only ever sent to the authorization server
   * that issued it, so a server that moved to another one needs a new
   * sign-in. Concurrent calls for one credential share one refresh.
   */
  async ensureFresh(organizationId: string, credentialId: string | null | undefined, opts: { force?: boolean } = {}): Promise<McpOAuthFreshness> {
    if (!credentialId) return { status: 'not_mcp_oauth' };
    const key = `${organizationId}:${credentialId}:${opts.force ? 'force' : 'due'}`;
    const running = this.refreshing.get(key);
    if (running) return running;
    const work = this.refreshIfDue(organizationId, credentialId, opts).finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, work);
    return work;
  }

  private async refreshIfDue(organizationId: string, credentialId: string, opts: { force?: boolean }): Promise<McpOAuthFreshness> {
    const row = await this.credentials.findOne({ where: { id: credentialId, organizationId } });
    if (!row || !McpOAuthClientService.isMcpSignIn(row)) return { status: 'not_mcp_oauth' };
    const config = await this.decrypted(row);
    const skewMs = mcpOAuthClientSettings().refreshSkewSeconds * 1000;
    const due = !!row.expiresAt && new Date(row.expiresAt).getTime() - skewMs <= Date.now();
    if (!opts.force && !due) return { status: 'fresh' };

    if (opts.force) {
      // SEP-2352: tokens are the issuer's. Read where the server sends
      // people to sign in now; if that is someone else, do not refresh at
      // the old one and do not send its token on.
      try {
        const { resource } = await this.discoverResource(config.serverUrl);
        const issuers = resource.authorizationServers.map(stripTrailingSlashes);
        if (!issuers.includes(stripTrailingSlashes(String(config.oauthIssuer)))) {
          return this.markReconnect(row, `${host(config.serverUrl)} now signs in with ${host(resource.authorizationServers[0])} instead of ${host(config.oauthIssuer)}. Sign in again.`);
        }
      } catch (e: any) {
        this.logger.warn(`could not re-read the sign-in of ${host(config.serverUrl)}: ${e?.response?.message ?? e?.message ?? e}`);
      }
    }

    if (typeof config.refreshToken !== 'string' || !config.refreshToken) {
      return this.markReconnect(row, `The sign-in to ${host(config.serverUrl)} has expired. Sign in again.`);
    }
    let out: Awaited<ReturnType<McpOAuthClientService['tokenRequest']>>;
    try {
      out = await this.tokenRequest(
        config.tokenEndpoint,
        { clientId: config.oauthClientId, secret: config.clientSecret ?? null, tokenAuthMethod: config.oauthTokenAuth ?? 'none' },
        { grant_type: 'refresh_token', refresh_token: config.refreshToken, resource: config.oauthResource, ...(config.oauthScope ? { scope: config.oauthScope } : {}) },
      );
    } catch (e: any) {
      return { status: 'unavailable', error: String(e?.response?.message ?? e?.message ?? e) };
    }
    if ('error' in out) {
      // invalid_grant and other client errors end the sign-in; a server
      // error may pass, so the connection is left as it is.
      if (out.status >= 500) return { status: 'unavailable', error: out.error };
      return this.markReconnect(row, `The sign-in to ${host(config.serverUrl)} could not be renewed (${out.error}). Sign in again.`);
    }

    const next: Record<string, any> = { ...(row.config ?? {}) };
    next.accessToken = await this.envelope.encryptForOrg(organizationId, out.accessToken);
    if (out.refreshToken) next.refreshToken = await this.envelope.encryptForOrg(organizationId, out.refreshToken);
    row.config = next;
    row.expiresAt = out.expiresAt as any;
    row.healthStatus = 'valid';
    row.healthCheckedAt = new Date();
    row.healthError = null;
    await this.credentials.save(row);
    this.logger.log(`refreshed the MCP sign-in ${row.id} at ${host(config.oauthIssuer)}`);
    return { status: 'refreshed' };
  }

  /** RFC 7009 revocation at the issuer, when it offers it; tokens first by refresh token. */
  async revoke(secrets: Record<string, any>): Promise<{ attempted: boolean; ok: boolean; error?: string }> {
    const url = secrets.oauthRevocationEndpoint;
    if (typeof url !== 'string' || !url) return { attempted: false, ok: false };
    const errors: string[] = [];
    const tokens: Array<[string, string]> = [];
    if (secrets.refreshToken) tokens.push([secrets.refreshToken, 'refresh_token']);
    if (secrets.accessToken) tokens.push([secrets.accessToken, 'access_token']);
    for (const [token, hint] of tokens) {
      try {
        const fields: Record<string, string> = { token, token_type_hint: hint };
        const secret = typeof secrets.clientSecret === 'string' && secrets.clientSecret ? secrets.clientSecret : null;
        const headers = this.clientAuth({ clientId: secrets.oauthClientId, secret, tokenAuthMethod: secrets.oauthTokenAuth ?? 'none' }, fields);
        const res = await this.call(url, { method: 'POST', headers, body: new URLSearchParams(fields).toString() });
        if (res.status !== 200) errors.push(`${hint}: HTTP ${res.status}`);
      } catch (e: any) {
        errors.push(`${hint}: ${e?.response?.message ?? e?.message ?? e}`);
      }
    }
    return { attempted: true, ok: errors.length === 0, ...(errors.length ? { error: errors.join('; ') } : {}) };
  }
}
