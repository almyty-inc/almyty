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
import { McpOAuthClientService } from './mcp-oauth/mcp-oauth-client.service';
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
import { GrantsService } from './grants/grants.service';
import { connectionVisibleTo, GrantPrincipal } from './grants/grant-check';
import { RotationService, RotateOutcome } from './rotation/rotation.service';
import { CONNECTIONS_GOVERNANCE_HOOK, ConnectionsGovernanceHook } from '../../common/ee-hooks/ee-hooks';
import { interpolate, schemaViolations, secretFieldsOf, splitSecrets } from './connector-schema';
import {
  ConnectMethod,
  ConnectionOwner,
  ConnectionView,
  ConnectMethodType,
  ConnectorDefinition,
  REDIRECT_METHODS,
  connectionOwnerOf,
  heldBy,
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
  /** The team, when owner is 'team'. */
  teamId?: string;
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

/** What asking a provider to revoke a connection's grant came to. */
export interface ProviderRevokeOutcome {
  /** False when the provider offers no way to revoke (nothing was sent). */
  attempted: boolean;
  revoked: boolean;
  via?: 'rotation' | 'connector' | 'oauth2';
  error?: string;
}
export type ConnectResult = PendingRedirect | PendingForm | { pending: false; connection: ConnectionView; rotation?: RotateOutcome };

/** Personal / free orgs let members keep their own keys; production tiers start closed. */
export function defaultAllowUserScopedConnections(plan: string | null | undefined): boolean {
  return !plan || plan === 'free' || plan === 'personal';
}

const OAUTH_SECRET_KEYS = ['accessToken', 'refreshToken', 'apiKey', 'clientSecret'];

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
    @Optional() private readonly grants?: GrantsService,
    @Optional() private readonly rotation?: RotationService,
    @Optional() @Inject(CONNECTIONS_GOVERNANCE_HOOK) private readonly governance?: ConnectionsGovernanceHook,
    // Signing in to MCP servers (connections/mcp-oauth). Optional for the positional spec harnesses.
    @Optional() private readonly mcpOAuth?: McpOAuthClientService,
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
    const teamId = owner === 'team' ? body.teamId ?? null : null;
    await this.assertCanCreate(principal, organizationId, owner, teamId);
    await this.governance?.beforeConnect(organizationId, connector.key, heldBy(owner));
    // Personal and private both belong to the caller; private also takes
    // the row out of everyone else's reach (admins included). A team row
    // is the organization's, for that team alone.
    const ownerUserId = owner === 'org' || owner === 'team' ? null : principal.id;
    const visibility = owner === 'private' ? 'private' : owner === 'team' ? 'team' : 'org';

    if (REDIRECT_METHODS.includes(method.type)) {
      const plainInput = this.plainInput(method, body.input);
      return this.startRedirect({
        connector, method, organizationId, userId: principal.id, ownerUserId, visibility, teamId,
        mode: body.mode ?? 'browser', input: plainInput, rotateConnectionId: null, requestBase, secretInput: body.input, name: body.name,
      });
    }

    const input = this.checkedInput(method, body.input);
    const view = await this.finalize({
      connector, method, organizationId, userId: principal.id, ownerUserId, visibility, teamId,
      config: input, name: body.name, action: AuditAction.CONNECTION_CONNECT,
    });
    return { pending: false, connection: view };
  }

  /**
   * Headless / CLI completion: the user pastes the code the provider printed.
   * `iss` is the authorization response's issuer (RFC 9207), when the service sent one.
   */
  async complete(state: string, code: string, iss?: string): Promise<ConnectionView> {
    if (!state || !code) throw new BadRequestException({ code: 'CONNECT_STATE_INVALID', message: 'state and code are required' });
    const pending = await this.stateStore.take(state);
    if (!pending) throw new UnauthorizedException({ code: 'CONNECT_STATE_INVALID', message: 'unknown or expired connect state; start the connect again' });

    // An MCP server sign-in: endpoints discovered, iss checked (RFC 9207).
    if (pending.mcpOAuth) return this.completeMcpSignIn(pending, code, iss);
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
      config, existing, expiresAt, scopesGranted, visibility: pending.visibility, teamId: pending.teamId ?? null, name: pending.rotateConnectionId ? undefined : pending.name,
      action: pending.rotateConnectionId ? AuditAction.CONNECTION_ROTATE : AuditAction.CONNECTION_CONNECT,
    });
  }

  /** Browser completion: the provider redirected here with code and state. Same exchange as `complete`. */
  async handleCallback(query: { code?: string; state?: string; error?: string; error_description?: string; iss?: string }): Promise<ConnectionView> {
    if (query.error) {
      if (query.state) await this.stateStore.take(query.state);
      throw new BadRequestException({ code: 'CONNECT_DENIED', message: query.error_description ?? query.error });
    }
    return this.complete(String(query.state ?? ''), String(query.code ?? ''), typeof query.iss === 'string' ? query.iss : undefined);
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  async list(principal: ConnectionPrincipal, organizationId: string): Promise<ConnectionView[]> {
    this.assertMember(principal, organizationId, CONNECTIONS_READ);
    const rows = (await this.credentials.find({ where: { organizationId }, order: { createdAt: 'DESC' } })).filter((r) => !!r.connectorKey);
    const who = await this.grantPrincipal(principal, organizationId);
    const visible = [];
    for (const r of rows) if (await this.canSee(principal, r, who)) visible.push(r);
    const connectors = new Map((await this.catalog.list(organizationId)).map((c) => [c.key, c] as const));
    return visible.map((r) => this.view(r, connectors.get(r.connectorKey!)));
  }

  async get(principal: ConnectionPrincipal, organizationId: string, id: string): Promise<ConnectionView> {
    const row = await this.load(organizationId, id);
    if (!(await this.canSee(principal, row))) {
      // A connection the caller may not see is not found, not forbidden:
      // a 403 would confirm the id exists.
      throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found' });
    }
    return this.view(row, await this.catalog.find(organizationId, row.connectorKey!));
  }

  // ------------------------------------------------------------------
  // Validate / rotate / disconnect
  // ------------------------------------------------------------------

  async validate(principal: ConnectionPrincipal, organizationId: string, id: string): Promise<ConnectionView> {
    const row = await this.load(organizationId, id);
    await this.assertCanManage(principal, row);
    const connector = await this.catalog.require(organizationId, row.connectorKey!);
    const config = await this.decryptConfig(row);
    const result = await this.validation.validate(connector, config, { organizationId });
    row.healthStatus = result.status;
    row.healthCheckedAt = new Date();
    row.healthError = result.ok ? null : result.error ?? 'validation failed';
    row.metadata = { ...(row.metadata ?? {}), healthDetail: result.ok ? result.detail ?? null : null };
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
    await this.assertCanManage(principal, row);
    const connector = await this.catalog.require(organizationId, row.connectorKey!);
    const method = this.pickMethod(connector, (row.metadata?.connectMethod as ConnectMethodType | undefined));
    await this.governance?.beforeConnect(organizationId, connector.key, row.ownerUserId ? 'user' : 'org');

    if (REDIRECT_METHODS.includes(method.type)) {
      // Signing in to an MCP server again needs its URL (and a client id
      // entered by hand), which the connection already has.
      let input = this.plainInput(method, body.input);
      let secretInput: Record<string, unknown> | undefined;
      if (method.oauth?.discover === 'mcp') {
        const current = await this.decryptConfig(row);
        const handEntered = current.oauthRegistration === 'pre_registered';
        input = {
          serverUrl: current.serverUrl,
          ...(handEntered ? { clientId: current.oauthClientId } : {}),
          ...(current.oauthScope ? { scope: current.oauthScope } : {}),
          ...input,
        };
        if (handEntered && current.clientSecret) secretInput = { clientSecret: current.clientSecret };
      }
      return this.startRedirect({
        connector, method, organizationId, userId: principal.id, ownerUserId: row.ownerUserId,
        mode: body.mode ?? 'browser', input, rotateConnectionId: row.id, requestBase, secretInput,
      });
    }
    // Gate 5: providers with a key-provisioning API rotate in place, no
    // form, no browser. Anything else falls through to the re-connect flow.
    if (!body.input && this.rotation) {
      const outcome = await this.rotateInPlace(row, connector, method, principal.id);
      if (!outcome.manual) {
        const fresh = await this.load(organizationId, id);
        return { pending: false, connection: this.view(fresh, connector), rotation: outcome };
      }
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

  /**
   * The provider-API rotation seam: mint, validate through the connector
   * probe, persist encrypted with the plain handle fields kept, retire the
   * old key. Returns manual:true when the connector cannot mint keys.
   * Used by the API (with the actor) and by the EE scheduler (system).
   */
  async rotateInPlace(row: Credential, connector: ConnectorDefinition, method: ConnectMethod, userId: string | null): Promise<RotateOutcome> {
    if (!this.rotation) return { manual: true, reason: 'rotation module not wired', keyPageUrl: method.keyPageUrl ?? connector.keyPageUrl ?? null };
    const organizationId = row.organizationId;
    const current = await this.decryptConfig(row);
    return this.rotation.rotate(
      { id: row.id, organizationId, connectorKey: row.connectorKey!, name: row.name, secrets: current, keyPageUrl: method.keyPageUrl ?? connector.keyPageUrl ?? null },
      {
        userId: userId ?? undefined,
        validate: async (next) => {
          const verdict = await this.validation.validate(connector, { ...current, ...next } as Record<string, any>, { organizationId });
          return { ok: verdict.ok, error: verdict.error, accountLabel: verdict.accountLabel ?? undefined };
        },
        persist: async (next, meta) => {
          const { plain } = splitSecrets(current, method.schema);
          await this.finalize({
            connector, method, organizationId, userId: userId ?? 'system', ownerUserId: row.ownerUserId,
            config: { ...plain, ...next }, existing: row, expiresAt: meta.expiresAt, action: AuditAction.CONNECTION_ROTATE,
          });
          row.metadata = { ...(row.metadata ?? {}), rotatedAt: meta.rotatedAt.toISOString(), secretRotatedAt: meta.rotatedAt.toISOString(), rotatedLabel: meta.label ?? null };
          await this.credentials.save(row);
        },
      },
    );
  }

  /** System rotation for the EE scheduler: any organization, no actor, provider API only. */
  async rotateAsSystem(connectionId: string): Promise<{ rotated: boolean; manual?: boolean; error?: string }> {
    const row = await this.credentials.findOne({ where: { id: connectionId } });
    if (!row || !row.connectorKey) return { rotated: false, error: 'connection not found' };
    const connector = await this.catalog.find(row.organizationId, row.connectorKey);
    if (!connector) return { rotated: false, error: `unknown connector ${row.connectorKey}` };
    const method = this.pickMethod(connector, (row.metadata?.connectMethod as ConnectMethodType | undefined));
    try {
      const outcome = await this.rotateInPlace(row, connector, method, null);
      return outcome.manual ? { rotated: false, manual: true, error: outcome.reason } : { rotated: true };
    } catch (err: any) {
      return { rotated: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Change who can use a credential after it was added, with the rules
   * a provider connection's scope change has: the caller must be able to
   * manage the credential as it is (the read rule first, so a hidden one
   * is not found), and able to make one for the new audience (Everyone
   * needs connections:manage, One team a member of that team or
   * connections:manage, Only you the organization's allowance for personal
   * keys). Only its owner makes an owned credential private. The key a
   * provider connection keeps for itself follows that connection, so it is
   * changed there. `assertConsumersCovered` is the save-time check that
   * whatever uses the credential is still inside its new audience.
   */
  async setSharing(
    principal: ConnectionPrincipal,
    organizationId: string,
    id: string,
    body: { owner: 'org' | 'team' | 'private'; teamId?: string | null },
    assertConsumersCovered?: (next: Credential) => Promise<void>,
  ): Promise<ConnectionView> {
    const row = await this.load(organizationId, id);
    await this.assertCanManage(principal, row);
    if ((row.metadata as Record<string, any> | null | undefined)?.managedBy) {
      throw new BadRequestException({ code: 'CONNECTION_MANAGED', message: 'this key belongs to a connection; change who can use it on that connection' });
    }
    const owner = body.owner;
    if (!['org', 'team', 'private'].includes(owner)) {
      throw new BadRequestException({ code: 'CONNECTION_OWNER_INVALID', message: 'who can use it is org, team or private' });
    }
    const teamId = owner === 'team' ? body.teamId ?? null : null;
    await this.assertCanCreate(principal, organizationId, owner, teamId);
    if (owner === 'private' && row.ownerUserId && row.ownerUserId !== principal.id) {
      throw new ForbiddenException({ code: 'CONNECTION_FORBIDDEN', message: "only its owner can make someone else's credential private" });
    }

    const before = connectionOwnerOf(row);
    const next = Object.assign(Object.create(Object.getPrototypeOf(row)), row) as Credential;
    next.visibility = owner;
    next.teamId = teamId;
    next.ownerUserId = owner === 'private' ? principal.id : null;
    await assertConsumersCovered?.(next);

    row.visibility = next.visibility;
    row.teamId = next.teamId;
    row.ownerUserId = next.ownerUserId;
    const saved = await this.credentials.save(row);
    this.auditLog.log({
      organizationId, userId: principal.id, action: AuditAction.CONNECTION_SHARE, resourceType: AuditResource.CONNECTION,
      resourceId: saved.id, resourceName: saved.name,
      details: { connectorKey: saved.connectorKey, from: before, to: connectionOwnerOf(saved), teamId: saved.teamId ?? null },
    });
    // Everyone and One team are the organization's: members use them
    // through the default grant (the team gate narrows it to the team), as
    // when one is added that way.
    if (owner !== 'private') await this.applyDefaultGrant(saved, principal.id);
    const connector = await this.catalog.find(organizationId, saved.connectorKey!);
    return this.view(saved, connector);
  }

  async disconnect(principal: ConnectionPrincipal, organizationId: string, id: string): Promise<{ revoked: boolean; revokeError?: string }> {
    const row = await this.load(organizationId, id);
    await this.assertCanManage(principal, row);
    const { revoked, error: revokeError } = await this.revokeAtProvider(row, principal.id);
    await this.credentials.remove(row);
    this.auditLog.log({
      organizationId, userId: principal.id, action: AuditAction.CONNECTION_DISCONNECT, resourceType: AuditResource.CONNECTION,
      resourceId: id, resourceName: row.name, details: { connectorKey: row.connectorKey, revoked, revokeError: revokeError ?? null },
    });
    return { revoked, revokeError };
  }

  /**
   * Revoke a connection's grant at its provider. Best-effort and never
   * throws: the caller removes or wipes the row locally whatever this
   * answers. In order, the first that applies:
   *
   *  1. a rotation provider that can revoke the key it minted;
   *  2. the connector's declared `revoke` probe;
   *  3. RFC 7009 token revocation, when the OAuth method the connection
   *     was made with declares a `revocationUrl` -- the refresh token
   *     first (which, per the RFC, also ends the access tokens it
   *     issued), then the access token.
   *
   * `attempted: false` means the provider offers no way to revoke.
   */
  async revokeAtProvider(
    row: Pick<Credential, 'id' | 'organizationId' | 'name' | 'connectorKey' | 'metadata' | 'config'>,
    actorUserId?: string,
  ): Promise<ProviderRevokeOutcome> {
    try {
      if (!row.connectorKey) return { attempted: false, revoked: false };
      const secrets = await this.decryptConfig(row as Credential);
      if (this.rotation) {
        const outcome = await this.rotation.revoke(
          { id: row.id, organizationId: row.organizationId, connectorKey: row.connectorKey, name: row.name, secrets },
          { userId: actorUserId },
        );
        if (outcome.supported) return { attempted: true, revoked: outcome.revoked, via: 'rotation', error: outcome.error };
      }
      // An MCP server sign-in revokes at the authorization server that issued it.
      if (this.mcpOAuth && typeof secrets.oauthIssuer === 'string') {
        const outcome = await this.mcpOAuth.revoke(secrets);
        if (outcome.attempted) return { attempted: true, revoked: outcome.ok, via: 'oauth2', error: outcome.error };
        return { attempted: false, revoked: false };
      }
      const connector = await this.catalog.find(row.organizationId, row.connectorKey);
      if (connector?.revoke) {
        const outcome = await this.validation.revoke(connector, secrets);
        return { attempted: true, revoked: outcome.ok, via: 'connector', error: outcome.error };
      }
      const methodType = row.metadata?.connectMethod as ConnectMethodType | undefined;
      const method = connector && methodType ? connector.connect.find((m) => m.type === methodType) : undefined;
      if (connector && method?.oauth?.revocationUrl) {
        const outcome = await this.revokeOAuthTokens(connector, method, secrets);
        return { attempted: true, revoked: outcome.ok, via: 'oauth2', error: outcome.error };
      }
      return { attempted: false, revoked: false };
    } catch (err: any) {
      return { attempted: true, revoked: false, error: String(err?.message ?? err) };
    }
  }

  /** RFC 7009: POST each token to the revocation endpoint, authenticated as at the token endpoint. */
  private async revokeOAuthTokens(
    connector: ConnectorDefinition,
    method: ConnectMethod,
    secrets: Record<string, any>,
  ): Promise<{ ok: boolean; error?: string }> {
    const oauth = method.oauth!;
    const url = interpolate(oauth.revocationUrl!, splitSecrets(secrets, method.schema).plain);
    const urlCheck = validateUrl(url);
    if (!urlCheck.valid) return { ok: false, error: `revocation URL refused: ${urlCheck.error}` };

    const accessField = method.secretField ?? (method.credentialType === CredentialType.OAUTH2 ? 'accessToken' : 'apiKey');
    const tokens: Array<[string, 'refresh_token' | 'access_token']> = [];
    if (typeof secrets.refreshToken === 'string' && secrets.refreshToken) tokens.push([secrets.refreshToken, 'refresh_token']);
    if (typeof secrets[accessField] === 'string' && secrets[accessField]) tokens.push([secrets[accessField], 'access_token']);
    if (tokens.length === 0) return { ok: false, error: 'the connection holds no token to revoke' };

    const client = oauth.clientId === 'platform' ? this.platformClient(connector.key) : null;
    const errors: string[] = [];
    for (const [token, hint] of tokens) {
      const fields: Record<string, string> = { token, token_type_hint: hint };
      if (client) {
        fields.client_id = client.clientId;
        fields.client_secret = client.clientSecret;
      }
      try {
        const res = await this.validation.request(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: new URLSearchParams(fields).toString(),
        });
        // 200 whether or not the token was still valid (RFC 7009 2.2).
        if (!res.ok) errors.push(`${hint}: HTTP ${res.status}`);
      } catch (e: any) {
        errors.push(`${hint}: ${e?.message ?? e}`);
      }
    }
    return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
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
      owner: connectionOwnerOf(row),
      ownerUserId: row.ownerUserId ?? null,
      teamId: row.visibility === 'team' ? row.teamId ?? null : null,
      method: (row.metadata?.connectMethod as ConnectMethodType | undefined) ?? null,
      accountLabel: row.accountLabel ?? null,
      health: { status: row.healthStatus ?? 'unknown', checkedAt: row.healthCheckedAt ?? null, error: row.healthError ?? null, detail: typeof row.metadata?.healthDetail === 'string' ? row.metadata.healthDetail : null },
      scopesGranted: row.scopesGranted ?? [],
      expiresAt: row.expiresAt ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      providerId: row.metadata?.managedBy?.kind === 'llm_provider' && typeof row.metadata.managedBy.id === 'string' ? row.metadata.managedBy.id : null,
    };
  }

  async loadForResolve(connectionId: string): Promise<Credential | null> {
    const row = await this.credentials.findOne({ where: { id: connectionId } });
    return row && row.connectorKey ? row : null;
  }

  /**
   * The read rule for connections (connectionVisibleTo): a private one is
   * its owner's alone, admins included; a team one is its team's (and
   * connections:manage's) alone; then an organization connection needs
   * connections:read and a user-owned one is its owner's or
   * connections:manage's to see. `who` is the principal already built for
   * this organization, when the caller has one.
   */
  async canSee(principal: ConnectionPrincipal, row: Credential, who?: GrantPrincipal): Promise<boolean> {
    return connectionVisibleTo(row, who ?? (await this.grantPrincipal(principal, row.organizationId)));
  }

  /**
   * The caller as the grant rules see them: org role, membership
   * permissions and, from the database, their teams. Without the grants
   * service (unit wiring) nobody is on a team, so a team connection is
   * hidden from everyone but its owner and connections:manage.
   */
  private async grantPrincipal(principal: ConnectionPrincipal, organizationId: string): Promise<GrantPrincipal> {
    if (this.grants) return this.grants.principalFor(principal, organizationId);
    const membership = membershipOf(principal, organizationId);
    return {
      userId: principal.id,
      roles: membership ? [String(membership.role)] : [],
      permissions: Array.isArray(membership?.permissions) ? [...membership!.permissions!] : [],
      teamIds: [],
    };
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

  private async assertCanCreate(principal: ConnectionPrincipal, organizationId: string, owner: ConnectionOwner, teamId?: string | null): Promise<void> {
    if (owner === 'org') {
      this.assertMember(principal, organizationId, CONNECTIONS_MANAGE);
      return;
    }
    if (owner === 'team') {
      await this.assertCanScopeToTeam(principal, organizationId, teamId);
      return;
    }
    // Personal and private are both a member's own key: the same
    // membership and the same org switch decide whether they may keep one.
    this.assertMember(principal, organizationId, CONNECTIONS_READ);
    if (!(await this.userScopedAllowed(organizationId))) {
      throw new ForbiddenException({ code: 'USER_CONNECTIONS_DISABLED', message: 'this organization does not allow user-scoped connections; ask an admin to enable allowUserScopedConnections or connect on behalf of the organization' });
    }
  }

  /**
   * Who may make a connection for one team: the rule a provider
   * connection's team scope has (AccessPolicyService.assertCanScopeToTeam).
   * A member of that team, or whoever manages the organization's
   * connections, for any active team of this organization. Anyone else
   * gets the not-found a team that does not exist gets.
   */
  private async assertCanScopeToTeam(principal: ConnectionPrincipal, organizationId: string, teamId: string | null | undefined): Promise<void> {
    if (!teamId) throw new BadRequestException({ code: 'CONNECTION_TEAM_REQUIRED', message: 'pick the team this connection is for' });
    this.assertMember(principal, organizationId, CONNECTIONS_READ);
    const who = await this.grantPrincipal(principal, organizationId);
    if (who.teamIds.includes(teamId)) return;
    if (principalHasPermission(principal, organizationId, CONNECTIONS_MANAGE) && (await this.grants?.teamInOrganization(teamId, organizationId))) return;
    throw new NotFoundException({ code: 'TEAM_NOT_FOUND', message: 'team not found' });
  }

  private async assertCanManage(principal: ConnectionPrincipal, row: Credential): Promise<void> {
    // The read rule first (read-rule.ts): a connection the caller may not
    // see -- another user's private one (connections:manage included), a
    // team one outside their team, a user-owned one of someone else
    // without connections:manage, any of the organization's without
    // connections:read -- does not exist for them. A 403 here would
    // confirm the id.
    if (!(await this.canSee(principal, row))) {
      throw new NotFoundException({ code: 'CONNECTION_NOT_FOUND', message: 'connection not found' });
    }
    if (row.visibility === 'private') return; // canSee: the owner.
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

  /** The API's public origin: where services send people back, and where the client metadata document is. */
  apiBase(requestBase?: string): string {
    return (
      this.configService.get<string>('PUBLIC_API_URL') ||
      this.configService.get<string>('BASE_URL') ||
      this.configService.get<string>('API_BASE_URL') ||
      requestBase ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  callbackUrl(requestBase?: string): string {
    return `${this.apiBase(requestBase)}/credentials/oauth/callback`;
  }

  /**
   * Sign in to an MCP server (owner decision 11): the endpoints and who
   * almyty is there come from the server (connections/mcp-oauth), then the
   * same PKCE redirect and state as every other sign-in. What the callback
   * needs -- the token endpoint, the issuer it must come from, the client --
   * is kept in the state, not in the browser.
   */
  private async startMcpSignIn(args: {
    connector: ConnectorDefinition; method: ConnectMethod; organizationId: string; userId: string; ownerUserId: string | null;
    mode: 'browser' | 'headless'; input: Record<string, unknown>; rotateConnectionId: string | null; requestBase?: string;
    visibility?: 'org' | 'team' | 'private';
    teamId?: string | null;
    secretInput?: Record<string, unknown>;
    name?: string;
  }): Promise<PendingRedirect> {
    if (!this.mcpOAuth) throw new BadRequestException({ code: 'CONNECT_METHOD_UNSUPPORTED', message: 'signing in to MCP servers is not available on this API' });
    const values = { ...args.input, ...(args.secretInput ?? {}) };
    const serverUrl = typeof values.serverUrl === 'string' ? values.serverUrl.trim() : '';
    if (!serverUrl) throw new BadRequestException({ code: 'CONNECT_INPUT_INVALID', message: 'serverUrl is required', errors: ['serverUrl is required'] });
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const callbackUrl = this.callbackUrl(args.requestBase);
    const mcpOAuth = await this.mcpOAuth.prepareSignIn({
      organizationId: args.organizationId,
      serverUrl,
      callbackUrl,
      apiBase: this.apiBase(args.requestBase),
      frontendUrl: this.configService.get<string>('FRONTEND_URL') ?? null,
      clientId: text(values.clientId),
      clientSecret: text(values.clientSecret),
      scope: text(values.scope),
    });
    const pkce = generatePkcePair();
    const state = newState();
    const payload: PendingConnect = {
      organizationId: args.organizationId,
      userId: args.userId,
      ownerUserId: args.ownerUserId,
      visibility: args.visibility ?? 'org',
      teamId: args.visibility === 'team' ? args.teamId ?? null : null,
      connectorKey: args.connector.key,
      methodType: args.method.type,
      codeVerifier: pkce.codeVerifier,
      callbackUrl,
      mode: 'browser',
      rotateConnectionId: args.rotateConnectionId,
      ...(args.name ? { name: args.name } : {}),
      input: { serverUrl },
      mcpOAuth,
      createdAt: Date.now(),
    };
    await this.stateStore.put(state, payload, CONNECT_STATE_TTL_SECONDS);
    this.logger.log(`MCP sign-in started at ${new URL(mcpOAuth.issuer).host} (${mcpOAuth.registration}) for org ${args.organizationId}${args.rotateConnectionId ? ' (again)' : ''}`);
    return {
      pending: true,
      method: args.method.type,
      mode: 'browser',
      authorizeUrl: this.mcpOAuth.authorizeUrl(mcpOAuth, { state, codeChallenge: pkce.codeChallenge, callbackUrl }),
      state,
      expiresInSeconds: CONNECT_STATE_TTL_SECONDS,
      completeWith: 'callback',
    };
  }

  /** The code of an MCP sign-in for its tokens, after checking who sent the browser back. */
  private async completeMcpSignIn(pending: PendingConnect, code: string, iss: string | undefined): Promise<ConnectionView> {
    if (!this.mcpOAuth || !pending.mcpOAuth || !pending.codeVerifier || !pending.callbackUrl) {
      throw new UnauthorizedException({ code: 'CONNECT_STATE_INVALID', message: 'this sign-in cannot be finished here; start it again' });
    }
    this.mcpOAuth.checkIssuer(pending.mcpOAuth, iss);
    const tokens = await this.mcpOAuth.exchangeCode(pending.organizationId, pending.mcpOAuth, {
      code,
      codeVerifier: pending.codeVerifier,
      callbackUrl: pending.callbackUrl,
    });
    const connector = await this.catalog.require(pending.organizationId, pending.connectorKey);
    const method = this.pickMethod(connector, pending.methodType as ConnectMethodType);
    let existing: Credential | undefined;
    if (pending.rotateConnectionId) {
      existing = (await this.credentials.findOne({ where: { id: pending.rotateConnectionId, organizationId: pending.organizationId } })) ?? undefined;
    }
    return this.finalize({
      connector, method, organizationId: pending.organizationId, userId: pending.userId, ownerUserId: pending.ownerUserId,
      config: this.mcpOAuth.connectionConfig(pending.mcpOAuth, tokens),
      existing, expiresAt: tokens.expiresAt,
      scopesGranted: (tokens.scope ?? pending.mcpOAuth.scope ?? '').split(/\s+/).filter(Boolean),
      visibility: pending.visibility, teamId: pending.teamId ?? null, name: pending.rotateConnectionId ? undefined : pending.name,
      action: pending.rotateConnectionId ? AuditAction.CONNECTION_ROTATE : AuditAction.CONNECTION_CONNECT,
    });
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
    visibility?: 'org' | 'team' | 'private';
    teamId?: string | null;
    /** The form's secret values too (an MCP sign-in's client secret); never stored in the state as given. */
    secretInput?: Record<string, unknown>;
    /** The name the new connection is saved under. */
    name?: string;
  }): Promise<PendingRedirect> {
    const { connector, method } = args;
    if (method.oauth?.discover === 'mcp') return this.startMcpSignIn(args);
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
      visibility: args.visibility ?? 'org',
      teamId: args.visibility === 'team' ? args.teamId ?? null : null,
      connectorKey: connector.key,
      methodType: method.type,
      codeVerifier: pkce?.codeVerifier ?? null,
      callbackUrl,
      mode: args.mode,
      rotateConnectionId: args.rotateConnectionId,
      ...(args.name ? { name: args.name } : {}),
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
  /**
   * Sane default, configurable: a new organization connection is usable by
   * every member unless the org setting connectionsDefaultGrant is 'none'
   * (then only admins, until someone grants). Never applied to user
   * connections, which stay the owner's until shared.
   */
  private async applyDefaultGrant(saved: Credential, userId: string | null): Promise<void> {
    if (!this.grants) return;
    const org = await this.organizations.findOne({ where: { id: saved.organizationId } });
    const setting = (org?.settings as Record<string, unknown> | null | undefined)?.connectionsDefaultGrant;
    if (setting === 'none') return;
    try {
      await this.grants.grantDefaultForOrgConnection(saved, userId);
    } catch (err: any) {
      this.logger.warn(`default grant for connection ${saved.id} failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Validates live, stores (encrypting every secret), audits, and either
   * returns the connection or throws 422 carrying it with failed health.
   */
  private async finalize(args: {
    connector: ConnectorDefinition; method: ConnectMethod; organizationId: string; userId: string; ownerUserId: string | null;
    config: Record<string, unknown>; existing?: Credential; name?: string; expiresAt?: Date | null; scopesGranted?: string[];
    action: AuditAction;
    /** Only read on create: 'private' makes the new row its owner's alone, 'team' its team's (teamId). */
    visibility?: 'org' | 'team' | 'private';
    teamId?: string | null;
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
    // The tier is chosen once, at connect; a rotation keeps it. A private
    // row always carries its owner (fail closed: no owner, no private row),
    // a team row its team and no owner (it is the organization's, for them).
    if (args.existing) {
      row.visibility = row.visibility ?? 'org';
    } else if (args.visibility === 'private') {
      if (!args.ownerUserId) throw new ForbiddenException({ code: 'CONNECTION_OWNER_REQUIRED', message: 'a private connection needs an owner' });
      row.visibility = 'private';
      row.teamId = null;
    } else if (args.visibility === 'team') {
      if (!args.teamId || args.ownerUserId) throw new BadRequestException({ code: 'CONNECTION_TEAM_REQUIRED', message: 'a team connection needs its team' });
      row.visibility = 'team';
      row.teamId = args.teamId;
    } else {
      row.visibility = 'org';
      row.teamId = null;
    }
    row.isActive = true;
    row.accountLabel = label;
    row.healthStatus = result.status;
    row.healthCheckedAt = new Date();
    row.healthError = result.ok ? null : result.error ?? 'validation failed';
    row.scopesGranted = result.scopesGranted ?? args.scopesGranted ?? row.scopesGranted ?? [];
    if (args.expiresAt !== undefined) row.expiresAt = args.expiresAt as any;
    row.metadata = { ...(row.metadata ?? {}), connectMethod: method.type, connectorKind: connector.kind, healthDetail: result.ok ? result.detail ?? null : null };
    if (method.type === 'api_key' && row.type === CredentialType.API_KEY) {
      row.keyName = row.keyName ?? 'Authorization';
      row.keyLocation = row.keyLocation ?? 'header';
    }

    const saved = await this.credentials.save(row);
    this.auditLog.log({
      organizationId, userId: args.userId, action: args.action, resourceType: AuditResource.CONNECTION,
      resourceId: saved.id, resourceName: saved.name,
      details: { connectorKey: connector.key, method: method.type, owner: connectionOwnerOf(saved), ok: result.ok, status: result.status, error: result.error ?? null },
    });
    if (result.ok && !args.ownerUserId && !args.existing) await this.applyDefaultGrant(saved, args.userId);
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
