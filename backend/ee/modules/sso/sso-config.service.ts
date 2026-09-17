import { HttpException, HttpStatus, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';

import { OrgSsoConfig } from '../../../src/entities/org-sso-config.entity';
import { OrganizationRole } from '../../../src/entities/user-organization.entity';
import { NotificationsService } from '../../../src/modules/notifications/notifications.service';
import {
  encryptField,
  decryptField,
  isEncrypted,
} from '../../../src/common/security/field-crypto';
import { OrgLicenseResolver } from '../../../src/modules/licensing/org-license.resolver';
import { EE_ENTITLEMENTS } from '../../../src/modules/licensing/license.constants';

/** Fields an org admin may set. Secrets are accepted plaintext and encrypted here. */
export interface UpsertSsoConfigDto {
  protocol?: 'saml' | 'oidc';
  enabled?: boolean;
  jitProvisioning?: boolean;
  defaultRole?: string;
  samlEntryPoint?: string | null;
  samlIssuer?: string | null;
  samlCert?: string | null;
  oidcIssuerUrl?: string | null;
  oidcClientId?: string | null;
  oidcClientSecret?: string | null;
  oidcRedirectUri?: string | null;
  scimEnabled?: boolean;
}

/** Config with secrets decrypted — for internal use by the login/SCIM flows. */
export interface DecryptedSsoConfig extends OrgSsoConfig {
  oidcClientSecretPlain: string | null;
}

const SCIM_TOKEN_PREFIX = 'scim_';

@Injectable()
export class SsoConfigService {
  constructor(
    @InjectRepository(OrgSsoConfig)
    private readonly repo: Repository<OrgSsoConfig>,
    // Core notification pipeline (@Global). EE -> core is the allowed
    // dependency direction; @Optional() so tests constructing the
    // service without it keep working.
    @Optional()
    private readonly notifications?: NotificationsService,
    // @Optional() for the same reason: a test that builds this service
    // bare gets the unentitled answer, which is the safe one.
    @Optional()
    private readonly licenses?: OrgLicenseResolver,
  ) {}

  /** Raw entity (secrets still encrypted). */
  async get(organizationId: string): Promise<OrgSsoConfig | null> {
    return this.repo.findOne({ where: { organizationId } });
  }

  private async entitled(organizationId: string): Promise<boolean> {
    try {
      return this.licenses ? await this.licenses.hasForOrg(organizationId, EE_ENTITLEMENTS.SSO) : false;
    } catch {
      return false;
    }
  }

  async getOrThrow(organizationId: string): Promise<OrgSsoConfig> {
    const config = await this.get(organizationId);
    if (!config) {
      throw new NotFoundException('SSO is not configured for this organization');
    }
    return config;
  }

  /**
   * Config with `oidcClientSecret` decrypted — never return this over the wire.
   *
   * The entitlement is checked here rather than by a controller guard.
   * SsoController is @Public(), because an SSO login arrives with no app
   * session, and JwtAuthGuard short-circuits on @Public() without
   * attaching a user — so EntitlementGuard had no org to resolve and
   * fell to its global branch, which is community on this deployment.
   * The result was 402 on every SAML and OIDC login for every paying
   * customer: an admin could configure SSO successfully from the
   * authenticated settings screen and then nobody could use it. Every
   * login route reaches the identity provider through this method, so
   * this is the one place that covers all of them.
   */
  async getDecrypted(organizationId: string): Promise<DecryptedSsoConfig | null> {
    if (!(await this.entitled(organizationId))) {
      throw new HttpException(
        { success: false, code: 'SSO_NOT_ENTITLED', message: 'Single sign-on is not included in this organization plan' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    const config = await this.get(organizationId);
    if (!config) return null;
    return {
      ...config,
      oidcClientSecretPlain: config.oidcClientSecret
        ? decryptField(config.oidcClientSecret)
        : null,
    } as DecryptedSsoConfig;
  }

  /**
   * Safe projection for the admin UI. Strips every secret and instead reports
   * whether it is set, and surfaces the SCIM base URL + a masked token hint.
   */
  toPublicView(config: OrgSsoConfig | null, baseUrl: string) {
    if (!config) {
      return {
        configured: false,
        protocol: 'saml' as const,
        enabled: false,
        jitProvisioning: false,
        defaultRole: 'member',
        scimEnabled: false,
        scimBaseUrl: `${baseUrl}/scim/v2`,
        scimTokenSet: false,
      };
    }
    return {
      configured: true,
      protocol: config.protocol,
      enabled: config.enabled,
      jitProvisioning: config.jitProvisioning,
      defaultRole: config.defaultRole,
      samlEntryPoint: config.samlEntryPoint,
      samlIssuer: config.samlIssuer,
      samlCert: config.samlCert,
      oidcIssuerUrl: config.oidcIssuerUrl,
      oidcClientId: config.oidcClientId,
      oidcClientSecretSet: !!config.oidcClientSecret,
      oidcRedirectUri: config.oidcRedirectUri,
      scimEnabled: config.scimEnabled,
      scimBaseUrl: `${baseUrl}/scim/v2`,
      scimTokenSet: !!config.scimTokenHash,
      loginUrl: `${baseUrl}/sso/${config.organizationId}/${config.protocol}/login`,
    };
  }

  /** Create or update the org's SSO config, encrypting any provided secret. */
  async upsert(
    organizationId: string,
    dto: UpsertSsoConfigDto,
  ): Promise<OrgSsoConfig> {
    let config = await this.get(organizationId);
    const isNew = !config;
    if (!config) {
      config = this.repo.create({ organizationId });
    }

    const assignIfDefined = <K extends keyof OrgSsoConfig>(
      key: K,
      value: OrgSsoConfig[K] | undefined,
    ) => {
      if (value !== undefined) config![key] = value;
    };

    assignIfDefined('protocol', dto.protocol);
    assignIfDefined('enabled', dto.enabled);
    assignIfDefined('jitProvisioning', dto.jitProvisioning);
    assignIfDefined('defaultRole', dto.defaultRole);
    assignIfDefined('samlEntryPoint', dto.samlEntryPoint);
    assignIfDefined('samlIssuer', dto.samlIssuer);
    assignIfDefined('samlCert', dto.samlCert);
    assignIfDefined('oidcIssuerUrl', dto.oidcIssuerUrl);
    assignIfDefined('oidcClientId', dto.oidcClientId);
    assignIfDefined('oidcRedirectUri', dto.oidcRedirectUri);
    assignIfDefined('scimEnabled', dto.scimEnabled);

    // Encrypt the OIDC client secret. An empty string clears it; a value that
    // is already ciphertext (round-tripped from the wire) is left untouched.
    if (dto.oidcClientSecret !== undefined) {
      if (!dto.oidcClientSecret) {
        config.oidcClientSecret = null;
      } else if (isEncrypted(dto.oidcClientSecret)) {
        config.oidcClientSecret = dto.oidcClientSecret;
      } else {
        config.oidcClientSecret = encryptField(dto.oidcClientSecret);
      }
    }

    const saved = await this.repo.save(config);

    // security.sso_install — notify org admins the first time SSO is
    // configured for the org. Best-effort: EE feature code never breaks
    // the admin's save. (EE -> core injection is the allowed dependency
    // direction; @Optional() keeps unit tests without the pipeline
    // working.)
    if (isNew && this.notifications) {
      this.notifications
        .emit({
          type: 'security.sso_install',
          organizationId,
          roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
          title: 'SSO configuration created',
          body: `Single sign-on (${saved.protocol || 'saml'}) was configured for your organization.`,
          link: '/settings',
          email: {
            template: 'security.sso_install',
            params: { kind: 'sso', detail: saved.protocol || 'saml' },
          },
        })
        .catch(() => {});
    }

    return saved;
  }

  /**
   * Mint a fresh SCIM bearer token, persist its lookup hash + encrypted copy,
   * enable SCIM, and return the plaintext ONCE for the admin to copy.
   */
  async rotateScimToken(organizationId: string): Promise<{ token: string }> {
    let config = await this.get(organizationId);
    if (!config) {
      config = this.repo.create({ organizationId });
    }
    const token = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('hex')}`;
    config.scimTokenHash = SsoConfigService.hashToken(token);
    config.scimTokenEncrypted = encryptField(token);
    config.scimEnabled = true;
    await this.repo.save(config);
    return { token };
  }

  /** Decrypt and return the stored SCIM token so the UI can re-display it. */
  async revealScimToken(organizationId: string): Promise<string | null> {
    const config = await this.get(organizationId);
    if (!config?.scimTokenEncrypted) return null;
    return decryptField(config.scimTokenEncrypted);
  }

  /**
   * Resolve an inbound SCIM bearer token to its organization via the indexed
   * lookup hash. Returns null when unknown or SCIM is disabled for the org.
   */
  async findOrgByScimToken(token: string): Promise<string | null> {
    if (!token) return null;
    const hash = SsoConfigService.hashToken(token);
    const config = await this.repo.findOne({
      where: { scimTokenHash: hash },
    });
    if (!config || !config.scimEnabled) return null;
    return config.organizationId;
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
