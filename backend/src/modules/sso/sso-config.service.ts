import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createHash, randomBytes } from 'crypto';

import { OrgSsoConfig } from '../../entities/org-sso-config.entity';
import {
  encryptField,
  decryptField,
  isEncrypted,
} from '../../common/security/field-crypto';

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
  ) {}

  /** Raw entity (secrets still encrypted). */
  async get(organizationId: string): Promise<OrgSsoConfig | null> {
    return this.repo.findOne({ where: { organizationId } });
  }

  async getOrThrow(organizationId: string): Promise<OrgSsoConfig> {
    const config = await this.get(organizationId);
    if (!config) {
      throw new NotFoundException('SSO is not configured for this organization');
    }
    return config;
  }

  /** Config with `oidcClientSecret` decrypted — never return this over the wire. */
  async getDecrypted(organizationId: string): Promise<DecryptedSsoConfig | null> {
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

    return this.repo.save(config);
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
