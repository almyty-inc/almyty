import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { Credential, CredentialType } from '../../entities/credential.entity';
import { Organization } from '../../entities/organization.entity';
import { validateUrl } from '../../common/security/url-validator';
import { AuditLogService } from '../audit-log/audit-log.service';
import { generatePkcePair } from '../credentials/oauth2.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import {
  CONNECT_STATE_STORE,
  CONNECT_STATE_TTL_SECONDS,
  ConnectStateStore,
  ConnectStateStoreFactory,
  newState,
  PendingConnect,
} from './connect-state.store';
import { ConnectionValidationService } from './connection-validation.service';
import { ConnectorCatalogService } from './connector-catalog.service';
import { interpolate, schemaViolations, secretFieldsOf, splitSecrets } from './connector-schema';
import {
  ConnectMethod,
  ConnectionOwner,
  ConnectionView,
  ConnectMethodType,
  ConnectorDefinition,
  REDIRECT_METHODS,
} from './connector.types';
import {
  CONNECTIONS_MANAGE,
  CONNECTIONS_READ,
  ConnectionPrincipal,
  membershipOf,
  principalHasPermission,
} from './connections.permissions';

export interface ConnectBody {
  method?: ConnectMethodType;
  owner?: ConnectionOwner;
  mode?: 'browser' | 'headless';
  input?: Record<string, unknown>;
  name?: string;
}

export interface PendingRedirect {
  pending: true;
  method: ConnectMethodType;
  mode: 'browser' | 'headless';
  authorizeUrl: string;
  state: string;
  expiresInSeconds: number;
  /** Set in headless mode when the provider prints the code on-screen; POST it to /complete. */
  completeWith: 'callback' | 'code';
}

export interface PendingForm {
  pending: true;
  method: ConnectMethodType;
  form: { schema: ConnectMethod['schema']; keyPageUrl: string | null };
}

export type ConnectResult = PendingRedirect | PendingForm | { pending: false; connection: ConnectionView };

/** Personal / free orgs let members keep their own keys; production tiers start closed. */
export function defaultAllowUserScopedConnections(plan: string | null | undefined): boolean {
  return !plan || plan === 'free' || plan === 'personal';
}

const OAUTH_SECRET_KEYS = ['accessToken', 'refreshToken', 'apiKey'];

/**
 * Connect, validate, rotate and disconnect. A connection is a Credential
 * row with a connectorKey; this service is the only writer of those
 * rows and never returns a secret. A connect that does not end in a
 * validated connection is reported as failed: the row is kept with
 * healthStatus `failed` so the user can retry or rotate in place, and
 * the response carries the provider's error.
 */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);
  private readonly stateStore: ConnectStateStore;

  constructor(
    @InjectRepository(Credential) private readonly credentials: Repository<Credential>,
    @InjectRepository(Organization) private readonly organizations: Repository<Organization>,
    private readonly catalog: ConnectorCatalogService,
    private readonly validation: ConnectionValidationService,
    private readonly envelope: EnvelopeCryptoService,
    private readonly auditLog: AuditLogService,
    private readonly configService: ConfigService,
    stateStoreFactory: ConnectStateStoreFactory,
    @Optional() @Inject(CONNECT_STATE_STORE) stateStore?: ConnectStateStore,
  ) {
    this.stateStore = stateStore ?? stateStoreFactory.create();
  }

  // ------------------------------------------------------------------
  // Catalog decoration
  // ------------------------------------------------------------------

  /** The catalog with per-org rendered links (CloudFormation quick-create carries the org as external id). */
  async describeConnectors(organizationId: string, kind?: ConnectorDefinition['kind']): Promise<Array<ConnectorDefinition & { connect: Array<ConnectMethod & { quickCreateUrl?: string }> }>> {
    const list = await this.catalog.list(organizationId, kind);
    return list.map((c) => ({
      ...c,
      connect: c.connect.map((m) => {
        if (m.type !== 'cloud_iam' || !m.quickCreate) return m;
        const cfnTemplateUrl = this.configService.get<string>('CONNECTIONS_AWS_CFN_TEMPLATE_URL');
        const trustedAccountId = this.configService.get<string>('CONNECTIONS_AWS_TRUSTED_ACCOUNT_ID');
        if (!cfnTemplateUrl || !trustedAccountId) return m;
        const quickCreateUrl = interpolate(m.quickCreate.templateUrl, {
          cfnTemplateUrl: encodeURIComponent(cfnTemplateUrl),
          stackName: m.quickCreate.stackName,
          externalId: organizationId,
          trustedAccountId,
          ...(m.quickCreate.params ?? {}),
        });
        return { ...m, quickCreateUrl };
      }),
    }));
  }

  // ------------------------------------------------------------------
  // Connect
  // ------------------------------------------------------------------

  async connect(principal: ConnectionPrincipal, organizationId: string, connectorKey: string, body: ConnectBody, requestBase?: string): Promise<ConnectResult> {
    const connector = await this.catalog.require(organizationId, connectorKey);
    const method = this.pickMethod(connector, body.method);
    const owner: ConnectionOwner = body.owner ?? 'org';
    await this.assertCanCreate(principal, organizationId, owner);
    const ownerUserId = owner === 'user' ? principal.id : null;

    if (REDIRECT_METHODS.includes(method.type)) {
      const plainInput = this.plainInput(method, body.input);
      return this.startRedirect({
        connector, method, organizationId, userId: principal.id, ownerUserId,
        mode: body.mode ?? 'browser', input: plainInput, rotateConnectionId: null, requestBase,
      });
    }

    const input = this.checkedInput(method, body.input);
    const view = await this.finalize({
      connector, method, organizationId, userId: principal.id, ownerUserId,
      config: input, name: body.name, action: AuditAction.CONNECTION_CONNECT,
    });
    return { pending: false, connection: view };
  }

  /** Headless / CLI completion: the user pastes the code the provider printed. */
  async complete(state: string, code: string): Promise<ConnectionView> {
    if (!state || !code) throw new BadRequestException({ code: 'CONNECT_STATE_INVALID', message: 'state and code are required' });
    const pending = await this.stateStore.take(state);
    if (!pending) throw new UnauthorizedException({ code: 'CONNECT_STATE_INVALID', message: 'unknown or expired connect state; start the connect again' });

    const connector = await this.catalog.require(pending.organizationId, pending.connectorKey);
    const method = this.pickMethod(connector, pending.methodType as ConnectMethodType);
    const oauth = method.oauth!;
    const tokenUrl = oauth.tokenUrl;
    const urlCheck = validateUrl(tokenUrl);
    if (!urlCheck.valid) throw new BadRequestException({ code: 'CONNECT_EXCHANGE_FAILED', message: `token URL refused: ${urlCheck.error}` });

    const platformClient = oauth.clientId === 'platform' ? this.platformClient(connector.key) : null;
    const fields: Record<string, string> = { code };
    if (pending.codeVerifier) {
      fields.code_verifier = pending.codeVerifier;
      fields.code_challenge_method = 'S256';
    }
    if (platformClient || oauth.tokenRequest !== 'json') {
      fields.grant_type = 'authorization_code';
      if (pending.callbackUrl) fields.redirect_uri = pending.callbackUrl;
    }
    if (platformClient) {
      fields.client_id = platformClient.clientId;
      fields.client_secret = platformClient.clientSecret;
    }
    const json = oauth.tokenRequest === 'json';
    let res: Response;
    try {
      res = await this.validation.request(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': json ? 'application/json' : 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: json ? JSON.stringify(fields) : new URLSearchParams(fields).toString(),
      });
    } catch (e: any) {
      throw new BadRequestException({ code: 'CONNECT_EXCHANGE_FAILED', message: `token exchange could not reach the provider: ${e?.message ?? e}` });
    }
    const text = await res.text().catch(() => '');
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || data?.error) {
      const detail = data?.error_description ?? data?.error?.message ?? data?.error ?? data?.message ?? text.slice(0, 160);
      throw new BadRequestException({ code: 'CONNECT_EXCHANGE_FAILED', message: `token exchange failed (${res.status}): ${detail}` });
    }
    const secret = data?.[oauth.tokenField ?? 'access_token'];
    if (typeof secret !== 'string' || !secret) {
      throw new BadRequestException({ code: 'CONNECT_EXCHANGE_FAILED', message: `token response carried no ${oauth.tokenField ?? 'access_token'}` });
    }

    const secretField = method.secretField ?? (method.credentialType === CredentialType.OAUTH2 ? 'accessToken' : 'apiKey');
    const config: Record<string, unknown> = { ...pending.input, [secretField]: secret };
    const refresh = data?.[oauth.refreshField ?? 'refresh_token'];
    if (typeof refresh === 'string' && refresh) config.refreshToken = refresh;
    if (method.credentialType === CredentialType.OAUTH2) config.tokenEndpoint = tokenUrl;
    const expiresAt = typeof data?.expires_in === 'number' ? new Date(Date.now() + data.expires_in * 1000) : null;
    const scopesGranted = typeof data?.scope === 'string' ? data.scope.split(/[\s,]+/).filter(Boolean) : oauth.scopes ?? [];

    let existing: Credential | undefined;
    if (pending.rotateConnectionId) {
      existing = (await this.credentials.findOne({ where: { id: pending.rotateConnectionId, organizationId: pending.organizationId } })) ?? undefined;
    }
    return this.finalize({
      connector, method, organizationId: pending.organizationId, userId: pending.userId, ownerUserId: pending.ownerUserId,
      config, existing, expiresAt, scopesGranted,
      action: pending.rotateConnectionId ? AuditAction.CONNECTION_ROTATE : AuditAction.CONNECTION_CONNECT,
    });
  }

  /** Browser completion: the provider redirected here with code and state. Same exchange as `complete`. */
  async handleCallback(query: { code?: string; state?: string; error?: string; error_description?: string }): Promise<ConnectionView> {
    if (query.error) {
      if (query.state) await this.stateStore.take(query.state);
      throw new BadRequestException({ code: 'CONNECT_DENIED', message: query.error_description ?? query.error });
    }
    return this.complete(String(query.state ?? ''), String(query.code ?? ''));
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async list(principal: ConnectionPrincipal, organizationId: string): Promise<ConnectionView[]> {
    this.assertMember(principal, organizationId, CONNECTIONS_READ);
    const rows = (await this.credentials.find({ where: { organizationId }, order: { createdAt: 'DESC' } })).filter((r) => !!r.connectorKey);
    const visible = rows.filter((r) => this.canSee(principal, r));
    const connectors = new Map((await this.catalog.list(organizationId)).map((c) => [c.key, c] as const));
    return visible.map((r) => this.view(r, connectors.get(r.connectorKey!)));
  }

  async get(principal: ConnectionPrincipal, organizationId: string, id: string): Promise<ConnectionView> {
    const row = await this.load(organizationId, id);
    if (!this.canSee(principal, row)) throw new ForbiddenException({ code: 'CONNECTION_FORBIDDEN', message: 'not your connection' });
    return this.view(row, await this.catalog.find(organizationId, row.connectorKey!));
  }

  // ------------------------------------------------------------------
  // Validate / rotate / disconnect
  // ------------------------------------------------------------------

  async validate(principal: ConnectionPrincipal, organizationId: string, id: string): Promise<ConnectionView> {
    const row = await this.load(organizationId, id);
    this.assertCanManage(principal, row);
    const connector = await this.catalog.require(organizationId, row.connectorKey!);
    const config = await this.decryptConfig(row);
    const result = await this.validation.validate(connector, config, { organizationId });
    row.healthStatus = result.status;
    row.healthCheckedAt = new Date();
    row.healthError = result.ok ? null : result.error ?? 'validation failed';
    if (result.accountLabel) row.accountLabel = result.accountLabel;
    if (result.scopesGranted) row.scopesGranted = result.scopesGranted;
    const saved = await this.credentials.save(row);
    this.auditLog.log({
      organizationId, userId: principal.id, action: AuditAction.CONNECTION_VALIDATE, resourceType: AuditResource.CONNECTION,
      resourceId: saved.id, resourceName: saved.name, details: { connectorKey: saved.connectorKey, ok: result.ok, status: result.status, error: result.error ?? null },
    });
    return this.view(saved, connector);
  }

  async rotate(principal: ConnectionPrincipal, organizationId: string, id: string, body: { input?: Record<string, unknown>; mode?: 'browser' | 'headless' }, requestBase?: string): Promise<ConnectResult> {
    const row = await this.load(organizationId, id);
    this.assertCanManage(principal, row);
    const connector = await this.catalog.require(organizationId, row.connectorKey!);
    const method = this.pickMethod(connector, (row.metadata?.connectMethod as ConnectMethodType | undefined));

    if (REDIRECT_METHODS.includes(method.type)) {
      return this.startRedirect({
        connector, method, organizationId, userId: principal.id, ownerUserId: row.ownerUserId,
        mode: body.mode ?? 'browser', input: this.plainInput(method, body.input), rotateConnectionId: row.id, requestBase,
      });
    }
    if (!body.input) {
      return { pending: true, method: method.type, form: { schema: method.schema, keyPageUrl: method.keyPageUrl ?? connector.keyPageUrl ?? null } };
    }
    const current = await this.decryptConfig(row);
    const { plain } = splitSecrets(current, method.schema);
    const input = this.checkedInput(method, { ...plain, ...body.input });
    const view = await this.finalize({
      connector, method, organizationId, userId: principal.id, ownerUserId: row.ownerUserId,
      config: input, existing: row, action: AuditAction.CONNECTION_ROTATE,
    });
    return { pending: false, connection: view };
  }

  async disconnect(principal: ConnectionPrincipal, organizationId: string, id: string): Promise<{ revoked: boolean; revokeError?: string }> {
    const row = await this.load(organizationId, id);
    this.assertCanManage(principal, row);
    const connector = await this.catalog.find(organizationId, row.connectorKey!);
    let revoked = false;
    let revokeError: string | undefined;
    if (connector?.revoke) {
      const outcome = await this.validation.revoke(connector, await this.decryptConfig(row));
      revoked = outcome.ok;
      revokeError = outcome.error;
    }
    await this.credentials.remove(row);
    this.auditLog.log({
      organizationId, userId: principal.id, action: AuditAction.CONNECTION_DISCONNECT, resourceType: AuditResource.CONNECTION,
      resourceId: id, resourceName: row.name, details: { connectorKey: row.connectorKey, revoked, revokeError: revokeError ?? null },
    });
    return { revoked, revokeError };
  }

  // ------------------------------------------------------------------
  // Shared with the resolver
  // ------------------------------------------------------------------

  /** Decrypts every `encrypted:` value through the org's envelope path (platform GCM or BYO-KMS). */
  async decryptConfig(row: Credential): Promise<Record<string, any>> {
    const out: Record<string, any> = { ...(row.config ?? {}) };
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && v.startsWith('encrypted:')) out[k] = await this.envelope.decryptForOrg(row.organizationId, v);
    }
    return out;
  }

  view(row: Credential, connector?: ConnectorDefinition | null): ConnectionView {
    return {
      id: row.id,
      connectorKey: row.connectorKey!,
      connectorDisplayName: connector?.displayName ?? row.connectorKey!,
      kind: connector?.kind ?? null,
      name: row.name,
      owner: row.ownerUserId ? 'user' : 'org',
      ownerUserId: row.ownerUserId ?? null,
      method: (row.metadata?.connectMethod as ConnectMethodType | undefined) ?? null,
      accountLabel: row.accountLabel ?? null,
      health: { status: row.healthStatus ?? 'unknown', checkedAt: row.healthCheckedAt ?? null, error: row.healthError ?? null },
      scopesGranted: row.scopesGranted ?? [],
      expiresAt: row.expiresAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async loadForResolve(connectionId: string): Promise<Credential | null> {
    const row = await this.credentials.findOne({ where: { id: connectionId } });
    return row && row.connectorKey ? row : null;
  }

  canSee(principal: ConnectionPrincipal, row: Credential): boolean {
    if (!row.ownerUserId) return principalHasPermission(principal, row.organizationId, CONNECTIONS_READ);
    return row.ownerUserId === principal.id || principalHasPermission(principal, row.organizationId, CONNECTIONS_MANAGE);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private pickMethod(connector: ConnectorDefinition, type?: ConnectMethodType): ConnectMethod {
    const method = type ? connector.connect.find((m) => m.type === type) : connector.connect[0];
    if (!method) throw new BadRequestException({ code: 'CONNECT_METHOD_UNSUPPORTED', message: `${connector.key} does not support ${type}; offers ${connector.connect.map((m) => m.type).join(', ')}` });
    return method;
  }

  private plainInput(method: ConnectMethod, input: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!input) return {};
    return splitSecrets(input, method.schema).plain;
  }

  private checkedInput(method: ConnectMethod, input: Record<string, unknown> | undefined): Record<string, unknown> {
    const values = input ?? {};
    const errors = schemaViolations(values, method.schema);
    if (errors.length) throw new BadRequestException({ code: 'CONNECT_INPUT_INVALID', message: errors.join('; '), errors });
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== null && v !== '') out[k] = v;
    for (const [k, p] of Object.entries(method.schema?.properties ?? {})) if (out[k] === undefined && p.default !== undefined) out[k] = p.default;
    return out;
  }

  private assertMember(principal: ConnectionPrincipal, organizationId: string, permission: string): void {
    if (!membershipOf(principal, organizationId)) throw new ForbiddenException({ code: 'NOT_A_MEMBER', message: 'not a member of this organization' });
    if (!principalHasPermission(principal, organizationId, permission)) {
      throw new ForbiddenException({ code: 'CONNECTIONS_PERMISSION_REQUIRED', message: `${permission} is required` });
    }
  }

  private async assertCanCreate(principal: ConnectionPrincipal, organizationId: string, owner: ConnectionOwner): Promise<void> {
    if (owner === 'org') {
      this.assertMember(principal, organizationId, CONNECTIONS_MANAGE);
      return;
    }
    this.assertMember(principal, organizationId, CONNECTIONS_READ);
    if (!(await this.userScopedAllowed(organizationId))) {
      throw new ForbiddenException({ code: 'USER_CONNECTIONS_DISABLED', message: 'this organization does not allow user-scoped connections; ask an admin to enable allowUserScopedConnections or connect on behalf of the organization' });
    }
  }

  private assertCanManage(principal: ConnectionPrincipal, row: Credential): void {
    if (!row.ownerUserId) {
      this.assertMember(principal, row.organizationId, CONNECTIONS_MANAGE);
      return;
    }
    if (row.ownerUserId === principal.id || principalHasPermission(principal, row.organizationId, CONNECTIONS_MANAGE)) return;
    throw new ForbiddenException({ code: 'CONNECTION_FORBIDDEN', message: 'not your connection' });
  }

  async userScopedAllowed(organizationId: string): Promise<boolean> {
    const org = await this.organizations.findOne({ where: { id: organizationId } });
    const setting = (org?.settings as Record<string, unknown> | null | undefined)?.allowUserScopedConnections;
    if (typeof setting === 'boolean') return setting;
    return defaultAllowUserScopedConnections(org?.plan);
  }

  private async load(organizationId: string, id: string): Promise<Credential> {
    const row = await this.credentials.findOne({ where: { id, organizationId } });
    if (!row || !row.connectorKey) throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found' });
    return row;
  }

  callbackUrl(requestBase?: string): string {
    const base = (
      this.configService.get<string>('PUBLIC_API_URL') ||
      this.configService.get<string>('BASE_URL') ||
      this.configService.get<string>('API_BASE_URL') ||
      requestBase ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
    return `${base}/connections/oauth/callback`;
  }

  private platformClient(connectorKey: string): { clientId: string; clientSecret: string } {
    const env = connectorKey.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    const clientId = this.configService.get<string>(`CONNECTIONS_OAUTH_${env}_CLIENT_ID`);
    const clientSecret = this.configService.get<string>(`CONNECTIONS_OAUTH_${env}_CLIENT_SECRET`);
    if (!clientId || !clientSecret) {
      throw new BadRequestException({ code: 'CONNECT_CLIENT_NOT_CONFIGURED', message: `CONNECTIONS_OAUTH_${env}_CLIENT_ID / _CLIENT_SECRET are not configured on this API` });
    }
    return { clientId, clientSecret };
  }

  private async startRedirect(args: {
    connector: ConnectorDefinition; method: ConnectMethod; organizationId: string; userId: string; ownerUserId: string | null;
    mode: 'browser' | 'headless'; input: Record<string, unknown>; rotateConnectionId: string | null; requestBase?: string;
  }): Promise<PendingRedirect> {
    const { connector, method } = args;
    const oauth = method.oauth;
    if (!oauth) throw new BadRequestException({ code: 'CONNECT_METHOD_UNSUPPORTED', message: `${connector.key} ${method.type} has no oauth endpoints` });
    const urlCheck = validateUrl(oauth.authorizeUrl);
    if (!urlCheck.valid) throw new BadRequestException({ code: 'CONNECT_URL_REFUSED', message: `authorize URL refused: ${urlCheck.error}` });

    const usePkce = method.type === 'oauth2_pkce' || oauth.pkce === true;
    const pkce = usePkce ? generatePkcePair() : null;
    const state = newState();
    const headlessByCode = args.mode === 'headless' && oauth.headlessCode === true;
    let callbackUrl: string | null = null;
    if (!headlessByCode) {
      callbackUrl = this.callbackUrl(args.requestBase);
      if ((oauth.stateVia ?? 'param') === 'callback_query') {
        const u = new URL(callbackUrl);
        u.searchParams.set('state', state);
        callbackUrl = u.toString();
      }
    }

    const url = new URL(oauth.authorizeUrl);
    if (oauth.clientId === 'platform') {
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', this.platformClient(connector.key).clientId);
    }
    if (callbackUrl) url.searchParams.set(oauth.callbackParam ?? 'redirect_uri', callbackUrl);
    if ((oauth.stateVia ?? 'param') === 'param') url.searchParams.set('state', state);
    if (pkce) {
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
    }
    if (oauth.scopes?.length) url.searchParams.set('scope', oauth.scopes.join(' '));
    for (const [k, v] of Object.entries(oauth.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);

    const payload: PendingConnect = {
      organizationId: args.organizationId,
      userId: args.userId,
      ownerUserId: args.ownerUserId,
      connectorKey: connector.key,
      methodType: method.type,
      codeVerifier: pkce?.codeVerifier ?? null,
      callbackUrl,
      mode: args.mode,
      rotateConnectionId: args.rotateConnectionId,
      input: args.input,
      createdAt: Date.now(),
    };
    await this.stateStore.put(state, payload, CONNECT_STATE_TTL_SECONDS);
    this.logger.log(`connect started: ${connector.key} via ${method.type} for org ${args.organizationId}${args.rotateConnectionId ? ' (rotate)' : ''}`);
    return {
      pending: true,
      method: method.type,
      mode: args.mode,
      authorizeUrl: url.toString(),
      state,
      expiresInSeconds: CONNECT_STATE_TTL_SECONDS,
      completeWith: headlessByCode ? 'code' : 'callback',
    };
  }

  /**
   * Validates live, stores (encrypting every secret), audits, and either
   * returns the connection or throws 422 carrying it with failed health.
   */
  private async finalize(args: {
    connector: ConnectorDefinition; method: ConnectMethod; organizationId: string; userId: string; ownerUserId: string | null;
    config: Record<string, unknown>; existing?: Credential; name?: string; expiresAt?: Date | null; scopesGranted?: string[];
    action: AuditAction;
  }): Promise<ConnectionView> {
    const { connector, method, organizationId } = args;
    const result = await this.validation.validate(connector, args.config as Record<string, any>, { organizationId });

    const row = args.existing ?? this.credentials.create({ organizationId });
    const secretKeys = new Set([...secretFieldsOf(method.schema), method.secretField ?? 'apiKey', ...OAUTH_SECRET_KEYS]);
    const stored: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args.config)) {
      if (v === undefined || v === null || v === '') continue;
      if (secretKeys.has(k) && typeof v === 'string' && !v.startsWith('encrypted:')) stored[k] = await this.envelope.encryptForOrg(organizationId, v);
      else stored[k] = v;
    }
    row.config = stored;
    await row.encryptSensitiveDataForOrg(this.envelope);

    const label = result.accountLabel ?? row.accountLabel ?? null;
    row.organizationId = organizationId;
    row.connectorKey = connector.key;
    row.ownerUserId = args.ownerUserId;
    row.type = (method.credentialType ?? CredentialType.API_KEY) as CredentialType;
    row.name = args.name ?? row.name ?? `${connector.displayName}${label ? ` (${label})` : ''}`;
    if (!args.existing) row.description = `${connector.displayName} connection via ${method.type}`;
    row.visibility = row.visibility ?? 'org';
    row.isActive = true;
    row.accountLabel = label;
    row.healthStatus = result.status;
    row.healthCheckedAt = new Date();
    row.healthError = result.ok ? null : result.error ?? 'validation failed';
    row.scopesGranted = result.scopesGranted ?? args.scopesGranted ?? row.scopesGranted ?? [];
    if (args.expiresAt !== undefined) row.expiresAt = args.expiresAt as any;
    row.metadata = { ...(row.metadata ?? {}), connectMethod: method.type, connectorKind: connector.kind };
    if (method.type === 'api_key' && row.type === CredentialType.API_KEY) {
      row.keyName = row.keyName ?? 'Authorization';
      row.keyLocation = row.keyLocation ?? 'header';
    }

    const saved = await this.credentials.save(row);
    this.auditLog.log({
      organizationId, userId: args.userId, action: args.action, resourceType: AuditResource.CONNECTION,
      resourceId: saved.id, resourceName: saved.name,
      details: { connectorKey: connector.key, method: method.type, owner: args.ownerUserId ? 'user' : 'org', ok: result.ok, status: result.status, error: result.error ?? null },
    });
    const view = this.view(saved, connector);
    if (!result.ok) {
      this.logger.warn(`connection ${saved.id} (${connector.key}) failed validation: ${result.error}`);
      throw new UnprocessableEntityException({
        code: 'CONNECTION_VALIDATION_FAILED',
        message: result.error ?? 'the provider did not accept the credential',
        connection: view,
      });
    }
    return view;
  }
}
