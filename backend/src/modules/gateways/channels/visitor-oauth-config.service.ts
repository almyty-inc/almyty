import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CredentialType } from '../../../entities/credential.entity';
import { Gateway, GatewayType, VisitorOAuthConfig, VisitorOAuthPreset } from '../../../entities/gateway.entity';
import { safeFetch, outboundFailureDetail } from '../../../common/security/safe-fetch';
import { CredentialRefResolver, ManagedBy } from '../../credentials/credential-ref.resolver';
import { GatewaysService } from '../gateways.service';
import { hostedChatConfigFrom } from './hosted-chat.config';
import {
  VISITOR_OAUTH_PRESETS,
  endpointError,
  isOidc,
  normalizeEmailDomains,
  normalizeScopes,
  presetEndpoints,
  providerLabel,
  visitorOAuthRedirectUris,
  VISITOR_OAUTH_FETCH,
  type OutboundFetch,
} from './visitor-oauth';

/**
 * The admin half of visitor OAuth: set, read and remove a hosted chat
 * surface's own identity provider.
 *
 * The client secret goes to `credentials` and nowhere else: one managed
 * row per surface (ManagedBy `hosted_chat_oauth`), rotated in place when
 * a new secret is pasted, released when the provider is removed. The
 * gateway's `visitorOAuth` column keeps its id, never the value, and is
 * written only here, with targeted SQL (the entity marks it `update:
 * false`, so a gateway save cannot put back an older provider).
 */

/** Writes a surface's `visitorOAuth` column. */
export interface VisitorOAuthStore {
  write(gatewayId: string, organizationId: string, config: VisitorOAuthConfig | null): Promise<void>;
}
export const VISITOR_OAUTH_STORE = Symbol('VISITOR_OAUTH_STORE');

@Injectable()
export class PgVisitorOAuthStore implements VisitorOAuthStore {
  constructor(@InjectRepository(Gateway) private readonly gateways: Repository<Gateway>) {}

  async write(gatewayId: string, organizationId: string, config: VisitorOAuthConfig | null): Promise<void> {
    await this.gateways.query(
      `UPDATE "gateways" SET "visitorOAuth" = $3::jsonb WHERE "id" = $1 AND "organizationId" = $2`,
      [gatewayId, organizationId, config ? JSON.stringify(config) : null],
    );
  }
}

export function visitorOAuthManagedBy(gatewayId: string): ManagedBy {
  return { kind: 'hosted_chat_oauth', id: gatewayId };
}

export interface VisitorOAuthView {
  preset: VisitorOAuthPreset;
  providerLabel: string;
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string | null;
  jwksUri: string | null;
  discoveryUrl: string | null;
  tenant: string | null;
  clientId: string;
  scopes: string[];
  allowedEmailDomains: string[];
  /** Whether a secret is stored. The value itself is never returned. */
  hasClientSecret: boolean;
  updatedAt: string;
}

/** What the admin endpoints answer: the provider, and what to register at it. */
export interface VisitorOAuthState {
  provider: VisitorOAuthView | null;
  /** The redirect URIs to register at the provider, exactly. */
  redirectUris: string[];
}

/** Longest discovery document we will read. */
const DISCOVERY_MAX_BYTES = 256 * 1024;
const WELL_KNOWN = '/.well-known/openid-configuration';

@Injectable()
export class VisitorOAuthConfigService {
  private readonly logger = new Logger(VisitorOAuthConfigService.name);

  constructor(
    private readonly gatewaysService: GatewaysService,
    @Inject(VISITOR_OAUTH_STORE) private readonly store: VisitorOAuthStore,
    @Optional() private readonly credentialRefs?: CredentialRefResolver,
    @Optional() @Inject(VISITOR_OAUTH_FETCH) private readonly fetchImpl: OutboundFetch = safeFetch,
  ) {}

  static view(_gateway: Pick<Gateway, 'configuration' | 'customDomain'>, config: VisitorOAuthConfig | null | undefined): VisitorOAuthView | null {
    if (!config) return null;
    return {
      preset: config.preset,
      providerLabel: providerLabel(config),
      issuer: config.issuer,
      authorizationEndpoint: config.authorizationEndpoint,
      tokenEndpoint: config.tokenEndpoint,
      userinfoEndpoint: config.userinfoEndpoint,
      jwksUri: config.jwksUri,
      discoveryUrl: config.discoveryUrl,
      tenant: config.tenant,
      clientId: config.clientId,
      scopes: [...config.scopes],
      allowedEmailDomains: [...config.allowedEmailDomains],
      hasClientSecret: !!config.credentialId,
      updatedAt: config.updatedAt,
    };
  }

  /**
   * The provider (or null) and the redirect URIs to register. The URIs
   * are answered before a provider exists: the provider asks for them
   * when the OAuth app is created, which is where the client ID comes from.
   */
  static state(gateway: Pick<Gateway, 'configuration' | 'customDomain'>, config: VisitorOAuthConfig | null | undefined): VisitorOAuthState {
    const slug = hostedChatConfigFrom(gateway.configuration).slug;
    const custom = gateway.customDomain?.status === 'active' ? gateway.customDomain.hostname : null;
    return {
      provider: VisitorOAuthConfigService.view(gateway, config),
      redirectUris: slug ? visitorOAuthRedirectUris(slug, custom) : [],
    };
  }

  async get(gatewayId: string, organizationId: string, userId: string): Promise<VisitorOAuthState> {
    const gateway = await this.surface(gatewayId, organizationId, userId);
    return VisitorOAuthConfigService.state(gateway, gateway.visitorOAuth);
  }

  /**
   * Save the provider. Endpoints come from the preset, from the discovery
   * document (fetched now, through the SSRF gate, and checked), or from
   * the body for a provider without discovery. A secret in the body is
   * moved to the credential store; no secret keeps the stored one.
   */
  async set(gatewayId: string, organizationId: string, userId: string, body: Record<string, any>): Promise<VisitorOAuthState> {
    const gateway = await this.surface(gatewayId, organizationId, userId);
    const input = body && typeof body === 'object' ? body : {};
    const preset = input.preset as VisitorOAuthPreset;
    if (!VISITOR_OAUTH_PRESETS.includes(preset)) this.refuse('Choose a provider.');

    const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
    if (!clientId || clientId.length > 512 || /\s/.test(clientId)) this.refuse('Enter the client ID from the provider.');

    const resolved = await this.resolveEndpoints(preset, input);
    const scopes = normalizeScopes(input.scopes, resolved.scopes);
    if (scopes.error) this.refuse(scopes.error);
    if (isOidc({ preset, issuer: resolved.issuer }) && !scopes.scopes.includes('openid')) {
      this.refuse('OpenID Connect sign-in needs the openid scope.');
    }
    const domains = normalizeEmailDomains(input.allowedEmailDomains);
    if (domains.error) this.refuse(domains.error);

    const previous = gateway.visitorOAuth;
    const secret = typeof input.clientSecret === 'string' ? input.clientSecret : '';
    const credentialId = await this.storeSecret(gateway, previous?.credentialId ?? null, secret);

    const config: VisitorOAuthConfig = {
      preset,
      issuer: resolved.issuer,
      authorizationEndpoint: resolved.authorizationEndpoint,
      tokenEndpoint: resolved.tokenEndpoint,
      userinfoEndpoint: resolved.userinfoEndpoint,
      jwksUri: resolved.jwksUri,
      discoveryUrl: resolved.discoveryUrl,
      tenant: resolved.tenant,
      clientId,
      scopes: scopes.scopes,
      allowedEmailDomains: domains.domains,
      credentialId,
      tokenEndpointAuthMethod: resolved.tokenEndpointAuthMethod,
      updatedAt: new Date().toISOString(),
    };
    await this.store.write(gateway.id, organizationId, config);
    return VisitorOAuthConfigService.state(gateway, config);
  }

  /** Remove the provider and the secret it held. Visitors can no longer sign in this way. */
  async remove(gatewayId: string, organizationId: string, userId: string): Promise<void> {
    const gateway = await this.surface(gatewayId, organizationId, userId);
    await this.store.write(gateway.id, organizationId, null);
    await this.credentialRefs?.releaseManaged(organizationId, gateway.visitorOAuth?.credentialId, visitorOAuthManagedBy(gateway.id));
  }

  private async storeSecret(gateway: Gateway, currentId: string | null, secret: string): Promise<string> {
    const managedBy = visitorOAuthManagedBy(gateway.id);
    const current = currentId && this.credentialRefs
      ? await this.credentialRefs.load(gateway.organizationId, currentId).catch(() => null)
      : null;
    const owned = current && CredentialRefResolver.isManagedBy(current, managedBy) ? current : null;

    if (!secret.trim()) {
      if (owned) return owned.id;
      this.refuse('Enter the client secret from the provider.');
    }
    if (secret.length > 4096) this.refuse('That client secret is too long.');
    if (!this.credentialRefs) {
      // Failing closed: the alternative is keeping the secret on the row.
      throw new ServiceUnavailableException('The credential store is not available, so the client secret cannot be saved.');
    }
    if (owned) {
      const rotated = await this.credentialRefs.rotateManaged(gateway.organizationId, owned.id, {
        config: { client_secret: secret },
        secretKeys: ['client_secret'],
        managedBy,
      });
      return rotated.id;
    }
    const created = await this.credentialRefs.createManaged(gateway.organizationId, {
      name: `${gateway.name ?? gateway.id} visitor sign-in`,
      description: `OAuth client secret for visitor sign-in on hosted chat ${gateway.id}`,
      type: CredentialType.CUSTOM,
      config: { client_secret: secret },
      secretKeys: ['client_secret'],
      managedBy,
    });
    return created.id;
  }

  private async resolveEndpoints(preset: VisitorOAuthPreset, input: Record<string, any>): Promise<{
    issuer: string | null;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userinfoEndpoint: string | null;
    jwksUri: string | null;
    discoveryUrl: string | null;
    tenant: string | null;
    scopes: string[];
    tokenEndpointAuthMethod: VisitorOAuthConfig['tokenEndpointAuthMethod'];
  }> {
    if (preset === 'google' || preset === 'github' || preset === 'microsoft') {
      const tenant = preset === 'microsoft' ? String(input.tenant ?? '').trim().toLowerCase() : null;
      const known = presetEndpoints(preset, tenant);
      if (!known) this.refuse('Enter your Microsoft Entra tenant ID or primary domain. The shared common and organizations tenants are not supported.');
      return { ...known!, discoveryUrl: null, tenant, tokenEndpointAuthMethod: 'client_secret_post' };
    }

    const discoveryUrl = typeof input.discoveryUrl === 'string' ? input.discoveryUrl.trim() : '';
    if (preset === 'oidc' && discoveryUrl) return this.discover(discoveryUrl);

    const field = (key: string) => (typeof input[key] === 'string' && input[key].trim() ? input[key].trim() : null);
    const authorizationEndpoint = field('authorizationEndpoint');
    const tokenEndpoint = field('tokenEndpoint');
    const userinfoEndpoint = field('userinfoEndpoint');
    const jwksUri = field('jwksUri');
    const issuer = preset === 'oidc' ? field('issuer') : null;
    for (const [label, value, required] of [
      ['Authorization endpoint', authorizationEndpoint, true],
      ['Token endpoint', tokenEndpoint, true],
      ['User info endpoint', userinfoEndpoint, preset === 'oauth2'],
      ['JWKS URI', jwksUri, preset === 'oidc'],
      ['Issuer', issuer, preset === 'oidc'],
    ] as Array<[string, string | null, boolean]>) {
      if (!value && !required) continue;
      const problem = endpointError(label, value);
      if (problem) this.refuse(problem);
    }
    return {
      issuer,
      authorizationEndpoint: authorizationEndpoint!,
      tokenEndpoint: tokenEndpoint!,
      userinfoEndpoint,
      jwksUri,
      discoveryUrl: null,
      tenant: null,
      scopes: preset === 'oidc' ? ['openid', 'email', 'profile'] : [],
      tokenEndpointAuthMethod: 'client_secret_post',
    };
  }

  /**
   * Read an OpenID Connect discovery document. The document must name
   * the issuer it was fetched for (RFC 8414 / OIDC Discovery 4.3): a
   * document that claims to be someone else is refused, since every ID
   * token will be checked against that issuer.
   */
  private async discover(given: string) {
    const problem = endpointError('Discovery URL', given);
    if (problem) this.refuse(problem);
    // Either the issuer or its discovery document may be pasted.
    const discoveryUrl = given.endsWith(WELL_KNOWN) ? given : `${given.replace(/\/$/, '')}${WELL_KNOWN}`;
    let doc: Record<string, any>;
    try {
      const res = await this.fetchImpl(discoveryUrl, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error('not ok');
      const text = await res.text();
      if (text.length > DISCOVERY_MAX_BYTES) throw new Error('too large');
      doc = JSON.parse(text);
    } catch (err) {
      this.logger.warn(`Visitor OAuth discovery failed for ${discoveryUrl}: ${err}`);
      this.refuse(`Could not read the discovery document: ${outboundFailureDetail(err)}.`);
    }
    if (!doc! || typeof doc! !== 'object') this.refuse('The discovery document is not JSON.');
    const issuer = typeof doc!.issuer === 'string' ? doc!.issuer : '';
    const expected = discoveryUrl.slice(0, -WELL_KNOWN.length);
    if (!issuer || issuer.replace(/\/$/, '') !== expected.replace(/\/$/, '')) {
      this.refuse('The discovery document names a different issuer than the URL it was read from.');
    }
    for (const [label, key, required] of [
      ['Authorization endpoint', 'authorization_endpoint', true],
      ['Token endpoint', 'token_endpoint', true],
      ['JWKS URI', 'jwks_uri', true],
      ['User info endpoint', 'userinfo_endpoint', false],
    ] as Array<[string, string, boolean]>) {
      if (!doc![key] && !required) continue;
      const bad = endpointError(`The discovered ${label.toLowerCase()}`, doc![key]);
      if (bad) this.refuse(bad);
    }
    const methods: string[] = Array.isArray(doc!.token_endpoint_auth_methods_supported)
      ? doc!.token_endpoint_auth_methods_supported
      : ['client_secret_basic'];
    const tokenEndpointAuthMethod = methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
    if (!methods.includes(tokenEndpointAuthMethod)) {
      this.refuse('The provider accepts no client secret method this sign-in supports.');
    }
    return {
      issuer,
      authorizationEndpoint: doc!.authorization_endpoint,
      tokenEndpoint: doc!.token_endpoint,
      userinfoEndpoint: doc!.userinfo_endpoint ?? null,
      jwksUri: doc!.jwks_uri,
      discoveryUrl,
      tenant: null,
      scopes: ['openid', 'email', 'profile'],
      tokenEndpointAuthMethod: tokenEndpointAuthMethod as VisitorOAuthConfig['tokenEndpointAuthMethod'],
    };
  }

  private refuse(message: string): never {
    throw new BadRequestException({ code: 'VISITOR_OAUTH_INVALID', message });
  }

  private async surface(gatewayId: string, organizationId: string, userId: string): Promise<Gateway> {
    const gateway = await this.gatewaysService.findManageable(gatewayId, organizationId, userId);
    if (gateway.type !== GatewayType.HOSTED_CHAT) {
      throw new BadRequestException({ code: 'NOT_A_HOSTED_CHAT', message: 'Visitor sign-in is for hosted chat apps.' });
    }
    return gateway;
  }
}
