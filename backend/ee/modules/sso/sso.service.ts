import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { SAML, Profile } from '@node-saml/passport-saml';
import * as oidc from 'openid-client';

import { User } from '../../../src/entities/user.entity';
import {
  UserOrganization,
  OrganizationRole,
} from '../../../src/entities/user-organization.entity';
import { DecryptedSsoConfig, SsoConfigService } from './sso-config.service';

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

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(UserOrganization)
    private readonly membershipRepo: Repository<UserOrganization>,
    private readonly configService: SsoConfigService,
  ) {}

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
  async buildOidcClient(config: DecryptedSsoConfig): Promise<any> {
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
    const redirectUri = config.oidcRedirectUri;
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
        checks: { state?: string } = {},
      ): Promise<{ claims: () => Record<string, any> }> {
        const currentUrl = new URL(redirectUri);
        for (const [key, value] of Object.entries(params)) {
          if (value !== undefined && value !== null) {
            currentUrl.searchParams.set(key, String(value));
          }
        }
        const tokens = await oidc.authorizationCodeGrant(
          configuration,
          currentUrl,
          { expectedState: checks.state },
        );
        return { claims: () => tokens.claims() ?? {} };
      },
    };
  }

  async getOidcLoginUrl(
    orgId: string,
  ): Promise<{ url: string; state: string }> {
    const config = await this.loadEnabledConfig(orgId, 'oidc');
    const client = await this.buildOidcClient(config);
    const state = randomBytes(16).toString('hex');
    const url = client.authorizationUrl({
      scope: 'openid email profile',
      state,
    });
    return { url, state };
  }

  async handleOidcCallback(
    orgId: string,
    params: Record<string, any>,
    expectedState: string | undefined,
  ): Promise<User> {
    const config = await this.loadEnabledConfig(orgId, 'oidc');
    const client = await this.buildOidcClient(config);

    let claims: Record<string, any>;
    try {
      const tokenSet = await client.callback(
        config.oidcRedirectUri,
        params,
        expectedState ? { state: expectedState } : {},
      );
      claims = tokenSet.claims();
    } catch (err) {
      this.logger.warn(`OIDC callback rejected for org ${orgId}: ${err}`);
      throw new UnauthorizedException('OIDC token exchange failed');
    }

    const email = (claims.email as string | undefined)?.toLowerCase();
    if (!email) {
      throw new UnauthorizedException('OIDC claims did not include an email');
    }
    return this.resolveUser(
      orgId,
      {
        email,
        firstName: claims.given_name as string | undefined,
        lastName: claims.family_name as string | undefined,
      },
      config,
    );
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
      if (membership) {
        if (!membership.isActive) {
          throw new UnauthorizedException(
            'Your access to this organization has been deactivated',
          );
        }
        return user;
      }
      // Existing user, not yet a member of this org.
      if (!config.jitProvisioning) {
        throw new UnauthorizedException(
          'You are not a member of this organization',
        );
      }
      await this.provisionMembership(user.id, orgId, config.defaultRole);
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
      role: (role as OrganizationRole) || OrganizationRole.MEMBER,
      isActive: true,
      inviteAccepted: true,
    });
    await this.membershipRepo.save(membership);
  }
}

function isEmail(value: unknown): value is string {
  return typeof value === 'string' && /.+@.+\..+/.test(value);
}
