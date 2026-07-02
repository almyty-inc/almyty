import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ChannelInstallation } from '../../../entities/channel-installation.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { encryptField, decryptField } from '../../../common/security/field-crypto';

/** Credential keys whose values are encrypted at rest. */
const SECRET_CREDENTIAL_KEYS = new Set(['bot_token', 'access_token', 'refresh_token']);

export interface UpsertInstallationInput {
  externalTenantId: string;
  /** Plaintext credentials — secrets are encrypted before persisting. */
  credentials: Record<string, any>;
  metadata?: Record<string, any>;
}

/**
 * Multi-workspace installations for channel gateways. A gateway with
 * zero installations keeps the single-credential behavior (config on
 * the gateway row); once workspaces install via OAuth, inbound events
 * are resolved to the installing workspace's own credentials by the
 * platform tenant id the adapter extracts from the payload.
 *
 * externalTenantId is platform-agnostic (Slack team_id today; a Teams
 * AAD tenant id can reuse the same table/service unchanged).
 */
@Injectable()
export class ChannelInstallationService {
  private readonly logger = new Logger(ChannelInstallationService.name);

  constructor(
    @InjectRepository(ChannelInstallation)
    private readonly installationRepository: Repository<ChannelInstallation>,
  ) {}

  /**
   * Create or refresh the installation for (gateway, tenant). Reinstalls
   * (including into a previously revoked workspace) reactivate the row
   * with fresh credentials and bump installedAt.
   */
  async upsert(gateway: Gateway, input: UpsertInstallationInput): Promise<ChannelInstallation> {
    const encrypted = this.encryptCredentials(input.credentials);

    let installation = await this.installationRepository.findOne({
      where: { gatewayId: gateway.id, externalTenantId: input.externalTenantId },
    });

    if (installation) {
      installation.credentials = encrypted;
      installation.status = 'active';
      installation.metadata = { ...(installation.metadata || {}), ...(input.metadata || {}) };
      installation.installedAt = new Date();
    } else {
      installation = this.installationRepository.create({
        gatewayId: gateway.id,
        organizationId: gateway.organizationId,
        externalTenantId: input.externalTenantId,
        credentials: encrypted,
        status: 'active',
        metadata: input.metadata || null,
        installedAt: new Date(),
      });
    }

    return this.installationRepository.save(installation);
  }

  /**
   * Resolve the decrypted credentials for an active installation of
   * `gatewayId` in `externalTenantId`, or null when the tenant never
   * installed / was revoked — callers fall back to the gateway's own
   * single-workspace configuration in that case.
   */
  async resolveCredentials(
    gatewayId: string,
    externalTenantId: string,
  ): Promise<Record<string, any> | null> {
    const installation = await this.installationRepository.findOne({
      where: { gatewayId, externalTenantId, status: 'active' },
    });
    if (!installation || !installation.credentials) return null;
    return this.decryptCredentials(installation.credentials);
  }

  /** Sanitized list for the dashboard — credentials never leave the server. */
  async listForGateway(gatewayId: string): Promise<Array<Record<string, any>>> {
    const installations = await this.installationRepository.find({
      where: { gatewayId },
      order: { installedAt: 'DESC' },
    });
    return installations.map((i) => this.sanitize(i));
  }

  /**
   * Revoke an installation: status=revoked and credentials cleared so
   * the workspace token no longer exists anywhere in our database.
   */
  async revoke(gatewayId: string, installationId: string): Promise<Record<string, any>> {
    const installation = await this.installationRepository.findOne({
      where: { id: installationId, gatewayId },
    });
    if (!installation) {
      throw new NotFoundException('Installation not found');
    }
    installation.status = 'revoked';
    installation.credentials = null;
    const saved = await this.installationRepository.save(installation);
    this.logger.log(
      `revoked channel installation ${installationId} (gateway ${gatewayId}, tenant ${installation.externalTenantId})`,
    );
    return this.sanitize(saved);
  }

  /** True when the gateway has at least one active installation. */
  async hasActiveInstallations(gatewayId: string): Promise<boolean> {
    const count = await this.installationRepository.count({
      where: { gatewayId, status: 'active' },
    });
    return count > 0;
  }

  // ---------------------------------------------------------------------------
  // Crypto helpers
  // ---------------------------------------------------------------------------

  private encryptCredentials(credentials: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(credentials || {})) {
      if (value == null) continue;
      out[key] = SECRET_CREDENTIAL_KEYS.has(key) ? encryptField(String(value)) : value;
    }
    return out;
  }

  private decryptCredentials(credentials: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(credentials)) {
      out[key] = typeof value === 'string' ? decryptField(value) : value;
    }
    return out;
  }

  private sanitize(installation: ChannelInstallation): Record<string, any> {
    return {
      id: installation.id,
      gatewayId: installation.gatewayId,
      externalTenantId: installation.externalTenantId,
      status: installation.status,
      metadata: installation.metadata,
      installedAt: installation.installedAt,
      createdAt: installation.createdAt,
    };
  }
}
