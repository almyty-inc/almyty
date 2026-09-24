import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { SAML, Profile } from '@node-saml/passport-saml';
import * as oidc from 'openid-client';

import { User } from '../../../src/entities/user.entity';
import { UserOrganization } from '../../../src/entities/user-organization.entity';
import { isEffectiveMembership } from '../../../src/common/authorization/membership';
import { DecryptedSsoConfig, SsoConfigService, provisioningRole } from './sso-config.service';
import {
  MemoryOidcLoginStateStore,
  OIDC_LOGIN_TTL_SECONDS,
  OidcLoginStateStore,
  OidcLoginStateStoreFactory,
} from './oidc-login-state.store';

/** Inject a specific store (specs); otherwise the factory picks Redis or memory. */
export const OIDC_LOGIN_STATE_STORE = Symbol('OIDC_LOGIN_STATE_STORE');

export interface SsoUserProfile {
  email: string;
  firstName?: string;
  lastName?: string;
}

/**
 * SP-initiated SAML + OIDC login. The flows are implemented imperatively
 * against the underlying libraries (rather than as passport strategies) because
 * the IdP config is resolved dynamically per organization from `OrgSsoConfig`.
 *
 * On a verified assertion the caller (SsoController) issues the app's normal
 * JWT httpOnly cookie via AuthService — this module never invents its own
 * session mechanism.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);
  private readonly loginStates: OidcLoginStateStore;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepo: Repository<UserOrganization>,
    private readonly configService: SsoConfigService,
    // Optional so specs that never start an OIDC sign-in can construct
    // the service bare; they get a per-instance memory store.
    @Optional() loginStateFactory?: OidcLoginStateStoreFactory,
    @Optional() @Inject(OIDC_LOGIN_STATE_STORE) loginStates?: OidcLoginStateStore,
  ) {
    this.loginStates = loginStates ?? loginStateFactory?.create() ?? new MemoryOidcLoginStateStore();
  }

  // ── SAML ────────────────────────────────────────────────────────────

  /** Overridable factory so unit tests can inject a fake SAML provider. */
  buildSaml(config: DecryptedSsoConfig, callbackUrl: string): SAML {
    if (!config.samlEntryPoint || !config.samlIssuer || !config.samlCert) {
      throw new BadRequestException('SAML is not fully configured');
    }
    return new SAML({
      entryPoint: config.samlEntryPoint,
      issuer: config.samlIssuer,
      idpCert: config.samlCert,
      callbackUrl,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: false,
    });
  }

  private samlCallbackUrl(baseUrl: string, orgId: string): string {
    return `${baseUrl}/sso/${orgId}/saml/callback`;
  }

  async getSamlLoginUrl(orgId: string, baseUrl: string): Promise<string> {
    const config = await this.loadEnabledConfig(orgId, 'saml');
    const saml = this.buildSaml(config, this.samlCallbackUrl(baseUrl, orgId));
    return saml.getAuthorizeUrlAsync('', undefined, {});
  }

  async handleSamlCallback(
    orgId: string,
    samlResponse: string,
    baseUrl: string,
  ): Promise<User> {
    const config = await this.loadEnabledConfig(orgId, 'saml');
    const saml = this.buildSaml(config, this.samlCallbackUrl(baseUrl, orgId));

    let profile: Profile | null;
    try {
      const result = await saml.validatePostResponseAsync({
        SAMLResponse: samlResponse,
      });
      profile = result.profile;
    } catch (err) {
      this.logger.warn(`SAML assertion rejected for org ${orgId}: ${err}`);
      throw new UnauthorizedException('Invalid SAML assertion');
    }

    if (!profile) {
      throw new UnauthorizedException('SAML response contained no assertion');
    }

    return this.resolveUser(orgId, this.profileFromSaml(profile), config);
  }

  /** Extract email + name from a validated SAML profile. */
  private profileFromSaml(profile: Profile): SsoUserProfile {
    const email =
      (profile.email as string) ||
      (profile.mail as string) ||
      (profile['urn:oid:0.9.2342.19200300.100.1.3'] as string) ||
      (isEmail(profile.nameID) ? profile.nameID : '');
    if (!email) {
      throw new UnauthorizedException('SAML assertion did not include an email');
    }
    return {
      email: email.toLowerCase(),
      firstName:
        (profile.firstName as string) ||
        (profile.givenName as string) ||
        (profile['urn:oid:2.5.4.42'] as string),
      lastName:
        (profile.lastName as string) ||
        (profile.surname as string) ||
        (profile['urn:oid:2.5.4.4'] as string),
    };
  }

  // ── OIDC ────────────────────────────────────────────────────────────

  /**
   * Overridable factory so unit tests can inject a fake OIDC client.
   *
   * openid-client v6 replaced the class-based `Issuer`/`Client` API with a
   * functional one built around a discovered `Configuration`. We wrap that
   * Configuration in a thin adapter exposing the two methods the callers use
   * (`authorizationUrl` + `callback`), which keeps this factory's contract
   * stable for the unit tests that stub it.
   */
  async buildOidcClient(config: DecryptedSsoConfig, redirectUriOverride?: string): Promise<any> {
    if (
      !config.oidcIssuerUrl ||
      !config.oidcClientId ||
      !config.oidcClientSecretPlain ||
      !config.oidcRedirectUri
    ) {
      throw new BadRequestException('OIDC is not fully configured');
    }
    const issuerUrl = new URL(config.oidcIssuerUrl);
    // openid-client v6 (via oauth4webapi) rejects non-HTTPS issuers by
    // default. Permit HTTP only for loopback issuers — local dev IdPs and
    // the oauth2-mock-server integration test — never for a real remote IdP.
    const isLoopback =
      issuerUrl.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname);
    const discoveryOptions = isLoopback
      ? { execute: [oidc.allowInsecureRequests] }
      : undefined;
    const configuration = await oidc.discovery(
      issuerUrl,
      config.oidcClientId,
      config.oidcClientSecretPlain,
      undefined,
      discoveryOptions,
    );
    const redirectUri = redirectUriOverride ?? config.oidcRedirectUri;
    return {
      authorizationUrl(parameters: Record<string, string>): string {
        return oidc
          .buildAuthorizationUrl(configuration, {
            redirect_uri: redirectUri,
            response_type: 'code',
            ...parameters,
          })
          .href;
      },
      async callback(
        _redirectUri: string,
        params: Record<string, any>,
        checks: OidcCallbackChecks,
      ): Promise<{ claims: () => Record<string, any> }> {
        const currentUrl = new URL(redirectUri);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null) {
            currentUrl.searchParams.set(key, String(value));
          }
        }
        // openid-client sends the verifier with the code and checks the
        // ID token's nonce itself; resolveOidcClaims checks the nonce
        // again so the rule does not rest on this adapter alone.
        const tokens = await oidc.authorizationCodeGrant(configuration, currentUrl, {
          expectedState: checks.state,
          pkceCodeVerifier: checks.codeVerifier,
          expectedNonce: checks.nonce,
        });
        return { claims: () => tokens.claims() ?? {} };
      },
    };
  }

  /**
   * Start an OIDC sign-in. Besides `state` (login CSRF), every request
   * carries an S256 PKCE challenge, so a code intercepted on its way back
   * cannot be redeemed without the verifier this server keeps, and a
   * `nonce` the ID token must echo, so an ID token minted for another
   * sign-in cannot be replayed into this one. The verifier and nonce are
   * stored server-side under the state, for one callback only.
   */
  async getOidcLoginUrl(
    orgId: string,
    options: { redirectUri?: string } = {},
  ): Promise<{ url: string; state: string }> {
    const config = await this.loadEnabledConfig(orgId, 'oidc');
    const client = await this.buildOidcClient(config, options.redirectUri);

    const state = randomBytes(16).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    await this.loginStates.put(
      state,
      {
        organizationId: orgId,
        codeVerifier,
        nonce,
        redirectUri: options.redirectUri ?? null,
        createdAt: Date.now(),
      },
      OIDC_LOGIN_TTL_SECONDS,
    );
    const url = client.authorizationUrl({
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: pkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { url, state };
  }

  async handleOidcCallback(
    orgId: string,
    params: Record<string, any>,
    expectedState: string | undefined,
  ): Promise<User> {
    const config = await this.loadEnabledConfig(orgId, 'oidc');
    const claims = await this.resolveOidcClaims(orgId, params, expectedState);
    return this.resolveUser(
      orgId,
      {
        email: claims.email,
        firstName: claims.givenName,
        lastName: claims.familyName,
      },
      config,
    );
  }

  /**
   * Finish the auth-code exchange and return the verified identity, without
   * deciding what it is for. The dashboard login turns it into a User; a
   * hosted-chat surface turns it into a signed-in visitor.
   */
  async resolveOidcClaims(
    orgId: string,
    params: Record<string, any>,
    expectedState: string | undefined,
    redirectUri?: string,
  ): Promise<{ sub: string; email: string; name?: string; givenName?: string; familyName?: string }> {
    // No state to compare is a refusal, not a skipped check: without an
    // expectation openid-client accepts a response that carries no
    // `state`, so a code minted for someone else's login could be
    // planted in this browser (login CSRF).
    if (!expectedState) {
      throw new UnauthorizedException('Sign-in session expired or did not match. Start again.');
    }

    // The verifier and nonce this sign-in started with. Taken, not read:
    // a second callback with the same state finds nothing. A state this
    // server never issued, one that expired, or one issued for another
    // organization or redirect is the same refusal.
    const pending = await this.loginStates.take(expectedState);
    if (
      !pending ||
      pending.organizationId !== orgId ||
      pending.redirectUri !== (redirectUri ?? null)
    ) {
      throw new UnauthorizedException('Sign-in session expired or did not match. Start again.');
    }

    const config = await this.loadEnabledConfig(orgId, 'oidc');
    const client = await this.buildOidcClient(config, redirectUri);

    let claims: Record<string, any>;
    try {
      const tokenSet = await client.callback(
        redirectUri ?? config.oidcRedirectUri,
        params,
        { state: expectedState, codeVerifier: pending.codeVerifier, nonce: pending.nonce },
      );
      claims = tokenSet.claims();
    } catch (err) {
      this.logger.warn(`OIDC callback rejected for org ${orgId}: ${err}`);
      throw new UnauthorizedException('OIDC token exchange failed');
    }

    // The ID token must answer this sign-in: a missing nonce is refused
    // as firmly as a wrong one.
    if (typeof claims.nonce !== 'string' || !timingSafeEqualText(claims.nonce, pending.nonce)) {
      this.logger.warn(`OIDC ID token nonce missing or mismatched for org ${orgId}`);
      throw new UnauthorizedException('OIDC token exchange failed');
    }

    const email = (claims.email as string | undefined)?.toLowerCase();
    if (!email) {
      throw new UnauthorizedException('OIDC claims did not include an email');
    }
    // Members are matched by email, so an address the IdP itself says is
    // unproven (self-service sign-up, an editable profile field) must not
    // sign anyone in as the member who owns it. An IdP that does not send
    // the claim at all is trusted as configured.
    if (claims.email_verified === false || claims.email_verified === 'false') {
      throw new UnauthorizedException('The identity provider has not verified this email address');
    }
    const sub = typeof claims.sub === 'string' && claims.sub ? claims.sub : email;
    return {
      sub,
      email,
      name: claims.name as string | undefined,
      givenName: claims.given_name as string | undefined,
      familyName: claims.family_name as string | undefined,
    };
  }

  // ── Shared ──────────────────────────────────────────────────────────

  private async loadEnabledConfig(
    orgId: string,
    protocol: 'saml' | 'oidc',
  ): Promise<DecryptedSsoConfig> {
    const config = await this.configService.getDecrypted(orgId);
    if (!config || !config.enabled) {
      throw new BadRequestException('SSO is not enabled for this organization');
    }
    if (config.protocol !== protocol) {
      throw new BadRequestException(
        `This organization is configured for ${config.protocol}, not ${protocol}`,
      );
    }
    return config;
  }

  /**
   * Map an asserted identity to an existing org member by email. When the user
   * is not a member: JIT-provision if the config allows it, otherwise reject
   * (deferring provisioning to SCIM / manual invite).
   *
   * JIT may only CREATE a user, never adopt one.
   *
   * `users` is a platform-wide table keyed by email, and an organization
   * configures its own IdP certificate. Looking an asserted email up
   * globally and then handing the row to `issueSession` meant any org
   * owner could self-sign an assertion for someone else's address and
   * receive a full dashboard session as that person -- with a token
   * carrying every organization the victim belongs to. Nothing binds an
   * asserted email to the asserting organization: there is no verified
   * domain here, so an IdP is not entitled to name an identity that
   * already exists outside its own membership.
   *
   * The legitimate version of "this person already has an almyty account"
   * is an invite or a SCIM assignment, both of which the account holder
   * sees and one of which they accept.
   */
  async resolveUser(
    orgId: string,
    profile: SsoUserProfile,
    config: DecryptedSsoConfig,
  ): Promise<User> {
    const email = profile.email.toLowerCase();
    let user = await this.userRepo.findOne({ where: { email } });

    if (user) {
      const membership = await this.membershipRepo.findOne({
        where: { userId: user.id, organizationId: orgId },
      });
      if (!membership) {
        // Existing account, not a member here. Never adopted, whatever
        // jitProvisioning says.
        throw new UnauthorizedException(
          'You are not a member of this organization',
        );
      }
      if (!membership.isActive) {
        throw new UnauthorizedException(
          'Your access to this organization has been deactivated',
        );
      }
      if (!isEffectiveMembership(membership)) {
        // A membership row that still holds an invite token has not been
        // accepted; the IdP does not get to accept it on the user's behalf.
        throw new UnauthorizedException(
          'Your invitation to this organization has not been accepted yet',
        );
      }
      return user;
    }

    // Brand-new user.
    if (!config.jitProvisioning) {
      throw new UnauthorizedException(
        'No account exists for this identity in this organization',
      );
    }
    user = await this.provisionUser(profile);
    await this.provisionMembership(user.id, orgId, config.defaultRole);
    return user;
  }

  private async provisionUser(profile: SsoUserProfile): Promise<User> {
    // A random password the SSO user never uses — they authenticate via the IdP.
    const passwordHash = await bcrypt.hash(
      randomBytes(24).toString('hex'),
      12,
    );
    const user = this.userRepo.create({
      email: profile.email.toLowerCase(),
      passwordHash,
      firstName: profile.firstName || profile.email.split('@')[0],
      lastName: profile.lastName || '',
      isVerified: true,
      isActive: true,
    });
    return this.userRepo.save(user);
  }

  private async provisionMembership(
    userId: string,
    organizationId: string,
    role: string,
  ): Promise<void> {
    const membership = this.membershipRepo.create({
      userId,
      organizationId,
      role: provisioningRole(role),
      isActive: true,
      inviteAccepted: true,
    });
    await this.membershipRepo.save(membership);
  }
}

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && /.+@.+\..+/.test(value);
}

/** What the OIDC client adapter checks on the callback. */
export interface OidcCallbackChecks {
  state: string;
  codeVerifier: string;
  nonce: string;
}

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export function pkceChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
