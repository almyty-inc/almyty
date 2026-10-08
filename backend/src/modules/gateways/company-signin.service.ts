import { verifyGoogleGroups } from './google-directory-groups';
import { endpointVisibility, endpointTeamId } from './gateway-access';
import { ConfigService } from '@nestjs/config';
import { getBaseUrl } from '../../common/config/base-url';
import { Injectable, BadRequestException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectRedis } from '@nestjs-modules/ioredis';
import { Repository } from 'typeorm';
import * as oidc from 'openid-client';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { Gateway, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayAuth, GatewayAuthType } from '../../entities/gateway-auth.entity';
import { OAuthAccessToken } from '../../entities/oauth-access-token.entity';
import { CredentialType } from '../../entities/credential.entity';
import { CredentialRefResolver } from '../credentials/credential-ref.resolver';
import { gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { assertOutboundUrlAllowed, safeFetch } from '../../common/security/safe-fetch';

export interface CompanyGrant { authConfigId: string; configVersion: string; subject: string; expiresAt: number; }
export interface CompanyOAuthRequest { clientId: string; redirectUri: string; scope?: string; codeChallenge: string; codeChallengeMethod: string; state?: string; resource?: string; clientName?: string; }
export function companySetting(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookieName = (id: string) => 'almyty_company_' + id.replace(/-/g, '');
export function companyIssuer(input: any): string {
  if (input.preset === 'google') return 'https://accounts.google.com';
  if (input.preset === 'microsoft') {
    const tenant = input.tenant;
    if (typeof tenant !== 'string' || !/^[a-zA-Z0-9.-]{1,255}$/.test(tenant) || ['common', 'organizations', 'consumers'].includes(tenant.toLowerCase())) throw new BadRequestException('Enter your Microsoft tenant ID or verified tenant domain');
    return `https://login.microsoftonline.com/${tenant}/v2.0`;
  }
  if (!['okta', 'auth0'].includes(input.preset) || typeof input.issuer !== 'string') throw new BadRequestException('Choose Google, Microsoft, Okta or Auth0');
  const issuer = assertOutboundUrlAllowed(input.issuer);
  if (new URL(issuer).protocol !== 'https:' || new URL(issuer).search || new URL(issuer).hash) throw new BadRequestException('Enter your HTTPS issuer URL');
  return input.issuer;
}
export function companyIdentityAllowed(config: any, claims: any, googleGroupsVerified = false): boolean {
  if (config.allowedEmailDomains?.length) {
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
    const verified = claims.email_verified === true || (config.preset === 'microsoft' && claims.xms_edov === true);
    if (config.preset === 'google' && (typeof claims.hd !== 'string' || !config.allowedEmailDomains.includes(claims.hd.toLowerCase()))) return false;
    if (!verified || !config.allowedEmailDomains.includes(email.split('@')[1]) || email.split('@').length !== 2) return false;
  }
  if (config.allowedGroups?.length) {
    if (config.preset === 'google') return googleGroupsVerified;
    const groups = claims[config.groupsClaim || 'groups'];
    if (!Array.isArray(groups) || !config.allowedGroups.some((g: string) => groups.includes(g))) return false;
  }
  return true;
}
@Injectable()
export class CompanySigninService {
  constructor(
    @InjectRepository(Gateway) private readonly gateways: Repository<Gateway>,
    @InjectRepository(GatewayAuth) private readonly auths: Repository<GatewayAuth>,
    @InjectRepository(OAuthAccessToken) private readonly tokens: Repository<OAuthAccessToken>,
    @InjectRedis() private readonly redis: any,
    private readonly credentials: CredentialRefResolver,
  ) {}
  static metadata(gatewayId: string) {
    const base = getBaseUrl(new ConfigService({ ...process.env, BASE_URL: process.env.PUBLIC_API_URL || process.env.BASE_URL || process.env.API_BASE_URL || process.env.API_URL }));
    if (process.env.NODE_ENV === 'production' && new URL(base).protocol !== 'https:') throw new Error('Company sign-in requires a trusted HTTPS public API URL');
    return { redirectUri: `${base}/company-signin/${gatewayId}/callback`, signInUrl: `${base}/company-signin/${gatewayId}/start` };
  }
  async prepare(gateway: Gateway, id: string, input: any, previous: any = {}) {
    const issuer = companyIssuer(input);
    const clientId = typeof input.clientId === 'string' ? input.clientId.trim() : '';
    if (!clientId || clientId.length > 512 || /\s/.test(clientId)) throw new BadRequestException('Enter the client ID');
    const discovery = await safeFetch(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', { maxBytes: companySetting('COMPANY_SIGNIN_MAX_RESPONSE_BYTES', 262144), timeoutMs: companySetting('COMPANY_SIGNIN_HTTP_TIMEOUT_MS', 10000) });
    if (!discovery.ok) throw new BadRequestException('Provider discovery failed');
    const doc = await discovery.json() as any;
    if (doc.issuer !== issuer && !(input.preset === 'microsoft' && /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i.test(doc.issuer))) throw new BadRequestException('Provider issuer did not match');
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof doc[field] !== 'string' || new URL(assertOutboundUrlAllowed(doc[field])).protocol !== 'https:') throw new BadRequestException('Provider needs secure authorization, token and signing-key endpoints');
    }
    const strings = (value: any, domains = false): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v.trim() || v.length > 255)) throw new BadRequestException('Invalid sign-in restrictions');
      const result = [...new Set<string>(value.map(v => domains ? v.trim().toLowerCase() : v.trim()))];
      if (domains && result.some(v => !/^[a-z0-9.-]+\.[a-z]{2,63}$/.test(v))) throw new BadRequestException('Enter email domains without @');
      return result;
    };
    const allowedEmailDomains = strings(input.allowedEmailDomains, true);
    const allowedGroups = strings(input.allowedGroups);
    const groupsClaim = input.groupsClaim || 'groups';
    if (typeof groupsClaim !== 'string' || groupsClaim.length > 255) throw new BadRequestException('Invalid group claim');
    const scopes = strings(input.scopes ?? ['openid', 'profile', 'email']);
    if (!scopes.includes('openid') || scopes.some(s => /\s/.test(s))) throw new BadRequestException('Company sign-in requires the openid scope');
    let directoryCredentialId: string | null = null, directoryAdminEmail: string | null = null;
    if (input.preset === 'google' && allowedGroups.length) {
      directoryCredentialId = typeof input.directoryCredentialId === 'string' ? input.directoryCredentialId : previous.directoryCredentialId;
      directoryAdminEmail = typeof input.directoryAdminEmail === 'string' ? input.directoryAdminEmail.trim().toLowerCase() : previous.directoryAdminEmail;
      if (!directoryCredentialId || !directoryAdminEmail || !/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(directoryAdminEmail)) throw new BadRequestException('Google group restrictions need a Workspace Directory connection and delegated admin email');
      const directory = await this.credentials.load(gateway.organizationId, directoryCredentialId);
      if (directory.connectorKey !== 'gcp') throw new BadRequestException('Choose a Google service-account connection');
      await this.credentials.assertAttachable(directory, { organizationId: gateway.organizationId, visibility: endpointVisibility(gateway), teamId: endpointTeamId(gateway), ownerUserId: gateway.ownerUserId, noun: 'company sign-in endpoint' });
    }
    const managedBy = { kind: 'gateway_company_signin' as const, id };
    let credentialId = previous.credentialId ?? null;
    const secret = typeof input.clientSecret === 'string' && input.clientSecret !== '••••••••' ? input.clientSecret : '';
    if (secret.length > 4096) throw new BadRequestException('Client secret is too long');
    if (credentialId) {
      const owned = await this.credentials.load(gateway.organizationId, credentialId);
      if (!CredentialRefResolver.isManagedBy(owned, managedBy)) throw new BadRequestException('Invalid sign-in credential');
    }
    if (secret) {
      const saved = credentialId ? await this.credentials.rotateManaged(gateway.organizationId, credentialId, { config: { client_secret: secret }, secretKeys: ['client_secret'], managedBy }) : await this.credentials.createManaged(gateway.organizationId, { name: `${gateway.name} company sign-in`, type: CredentialType.CUSTOM, config: { client_secret: secret }, secretKeys: ['client_secret'], managedBy });
      credentialId = saved.id;
    }
    if (!credentialId) throw new BadRequestException('Enter the client secret');
    return { preset: input.preset, tenant: input.tenant ?? null, issuer: doc.issuer, clientId, credentialId, authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint, jwksUri: doc.jwks_uri, scopes, allowedEmailDomains, allowedGroups, groupsClaim, directoryCredentialId, directoryAdminEmail, configVersion: randomUUID(), hasClientSecret: true, ...CompanySigninService.metadata(gateway.id) };
  }
  async release(auth: GatewayAuth) {
    await this.credentials.releaseManaged(auth.gateway.organizationId, auth.configuration.credentialId, { kind: 'gateway_company_signin', id: auth.id });
  }
  async gateway(gatewayId: string) {
    const gateway = await this.gateways.findOne({ where: { id: gatewayId, status: GatewayStatus.ACTIVE }, relations: { authConfigs: true } });
    if (!gateway || gateway.accessScope !== 'external_protected') throw new NotFoundException('Sign-in not available');
    const auth = gateway.authConfigs.find(a => a.isActive && a.type === GatewayAuthType.COMPANY_SIGNIN);
    if (!auth) throw new NotFoundException('Sign-in not available');
    return { gateway, auth };
  }
  async begin(gatewayId: string, req: any, res: any, oauth?: CompanyOAuthRequest) {
    const { auth } = await this.gateway(gatewayId);
    const config = auth.configuration;
    const state = oidc.randomState(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
    const binding = randomBytes(32).toString('base64url');
    const pending = { gatewayId, authConfigId: auth.id, configVersion: config.configVersion, verifier, nonce, binding: hash(binding), oauth };
    if (await this.redis.set('company:state:' + state, JSON.stringify(pending), 'PX', companySetting('COMPANY_SIGNIN_STATE_TTL_MS', 600000), 'NX') !== 'OK') throw new UnauthorizedException('Sign-in unavailable');
    res.cookie(cookieName(gatewayId), binding, { httpOnly: true, secure: CompanySigninService.metadata(gatewayId).redirectUri.startsWith('https:'), sameSite: 'lax', maxAge: companySetting('COMPANY_SIGNIN_STATE_TTL_MS', 600000), path: new URL(CompanySigninService.metadata(gatewayId).signInUrl).pathname.replace(/\/start$/, '') });
    const url = new URL(config.authorizationEndpoint);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: CompanySigninService.metadata(gatewayId).redirectUri, scope: config.scopes.join(' '), state, nonce, code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' })) url.searchParams.set(key, String(value));
    return url.href;
  }
  async finish(gatewayId: string, req: any) {
    const state = typeof req.query?.state === 'string' ? req.query.state : '';
    if (!state) throw new UnauthorizedException('Sign-in expired');
    const raw = await this.redis.getdel('company:state:' + state);
    if (!raw) throw new UnauthorizedException('Sign-in expired');
    const pending = JSON.parse(raw);
    if (pending.gatewayId !== gatewayId || pending.binding !== hash(req.cookies?.[cookieName(gatewayId)] || '')) throw new UnauthorizedException('Sign-in expired');
    const { gateway, auth } = await this.gateway(gatewayId);
    const config = auth.configuration;
    if (pending.authConfigId !== auth.id || pending.configVersion !== config.configVersion) throw new UnauthorizedException('Sign-in settings changed');
    const resolved = await this.credentials.resolve(gateway.organizationId, config.credentialId, { principal: gatewayPrincipal(gateway), context: { purpose: 'gateway_company_signin', resourceType: 'gateway', resourceId: gateway.id } });
    const client = new oidc.Configuration({ issuer: config.issuer, authorization_endpoint: config.authorizationEndpoint, token_endpoint: config.tokenEndpoint, jwks_uri: config.jwksUri }, config.clientId, undefined, oidc.ClientSecretPost(resolved.config.client_secret));
    client[oidc.customFetch] = (url, options) => safeFetch(String(url), { ...options, maxBytes: companySetting('COMPANY_SIGNIN_MAX_RESPONSE_BYTES', 262144), timeoutMs: companySetting('COMPANY_SIGNIN_HTTP_TIMEOUT_MS', 10000) } as any);
    oidc.enableNonRepudiationChecks(client);
    const callback = new URL(CompanySigninService.metadata(gatewayId).redirectUri);
    for (const [key, value] of Object.entries(req.query ?? {})) if (typeof value === 'string') callback.searchParams.set(key, value);
    let tokens: Awaited<ReturnType<typeof oidc.authorizationCodeGrant>>;
    try { tokens = await oidc.authorizationCodeGrant(client, callback, { pkceCodeVerifier: pending.verifier, expectedState: state, expectedNonce: pending.nonce, idTokenExpected: true }); } catch { throw new UnauthorizedException('Company sign-in failed'); }
    const claims = tokens.claims();
    let googleGroupsVerified = false;
    if (config.preset === 'google' && config.allowedGroups?.length && claims?.email_verified === true && typeof claims.email === 'string' && typeof claims.hd === 'string') {
      const directory = await this.credentials.resolve(gateway.organizationId, config.directoryCredentialId, { principal: gatewayPrincipal(gateway), context: { purpose: 'company_google_group_membership', resourceType: 'gateway', resourceId: gateway.id } }).catch(() => null);
      googleGroupsVerified = directory ? await verifyGoogleGroups(directory.config, config.directoryAdminEmail, claims.email, config.allowedGroups, (url, init) => safeFetch(url, { ...init, maxBytes: companySetting('COMPANY_SIGNIN_MAX_RESPONSE_BYTES', 262144), timeoutMs: companySetting('COMPANY_SIGNIN_HTTP_TIMEOUT_MS', 10000) })) : false;
    }
    if (!claims?.sub || !companyIdentityAllowed(config, claims, googleGroupsVerified)) throw new UnauthorizedException('This company account cannot use this endpoint');
    const grant: CompanyGrant = { authConfigId: auth.id, configVersion: config.configVersion, subject: claims.sub, expiresAt: Date.now() + companySetting('COMPANY_SIGNIN_TOKEN_TTL_MS', 3600000) };
    return { gateway, grant, oauth: pending.oauth as CompanyOAuthRequest | undefined, binding: pending.binding };
  }
  async validGrant(gatewayId: string, grant: CompanyGrant | null | undefined): Promise<boolean> {
    if (!grant || grant.expiresAt <= Date.now()) return false;
    const auth = await this.auths.findOne({ where: { id: grant.authConfigId, gatewayId, type: GatewayAuthType.COMPANY_SIGNIN, isActive: true }, relations: { gateway: true } });
    return !!auth && auth.gateway?.status === GatewayStatus.ACTIVE && auth.gateway?.accessScope === 'external_protected' && auth.configuration.configVersion === grant.configVersion;
  }
  async issue(gatewayId: string, grant: CompanyGrant) {
    const token = 'almyty_company_' + randomBytes(32).toString('base64url');
    if (await this.redis.set('company:token:' + hash(token), JSON.stringify({ gatewayId, grant }), 'PX', Math.max(1, grant.expiresAt - Date.now()), 'NX') !== 'OK') throw new UnauthorizedException('Sign-in unavailable');
    return token;
  }
  async validateToken(gatewayId: string, header: string): Promise<(CompanyGrant & { scopes?: string[]; oauth?: boolean }) | null> {
    if (!header?.startsWith('Bearer ')) return null;
    const tokenHash = hash(header.slice(7));
    const raw = await this.redis.get('company:token:' + tokenHash);
    let grant: CompanyGrant | undefined;
    let scopes: string[] | undefined;
    if (raw) { const saved = JSON.parse(raw); if (saved.gatewayId === gatewayId) grant = saved.grant; }
    if (!grant) { const token = await this.tokens.findOne({ where: { tokenHash, gatewayId, tokenType: 'access', isRevoked: false } }); if (token && token.expiresAt > new Date()) { grant = token.companyGrant; scopes = (token.scope ?? '').split(' ').filter(Boolean); } }
    return await this.validGrant(gatewayId, grant) ? (scopes ? { ...grant, scopes, oauth: true } : grant) : null;
  }
  async consent(gatewayId: string, result: any) {
    const ticket = randomBytes(32).toString('base64url');
    if (await this.redis.set('company:consent:' + hash(ticket), JSON.stringify({ ...result, gateway: { id: result.gateway.id, organizationId: result.gateway.organizationId, name: result.gateway.name } }), 'PX', companySetting('COMPANY_SIGNIN_CONSENT_TTL_MS', 600000), 'NX') !== 'OK') throw new UnauthorizedException('Consent unavailable');
    return ticket;
  }
  async takeConsent(gatewayId: string, ticket: string, req: any) {
    const raw = await this.redis.getdel('company:consent:' + hash(ticket));
    if (!raw) throw new UnauthorizedException('Consent expired');
    const saved = JSON.parse(raw);
    if (saved.gateway.id !== gatewayId || saved.binding !== hash(req.cookies?.[cookieName(gatewayId)] || '') || !await this.validGrant(gatewayId, saved.grant)) throw new UnauthorizedException('Consent expired');
    return saved;
  }
}
