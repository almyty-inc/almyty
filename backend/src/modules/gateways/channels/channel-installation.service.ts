import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ChannelInstallation } from '../../../entities/channel-installation.entity';
import { CredentialType } from '../../../entities/credential.entity';
import { Gateway } from '../../../entities/gateway.entity';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { CredentialRefResolver } from '../../credentials/credential-ref.resolver';
import { EnvelopeCryptoService } from '../../kms/envelope-crypto.service';
import { NotificationsService } from '../../notifications/notifications.service';

/** Credential keys whose values are secrets (encrypted by the store). */
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
    private readonly envelopeCrypto: EnvelopeCryptoService,
    private readonly credentialRefs: CredentialRefResolver,
    // @Global notifications pipeline; @Optional() keeps existing unit
    // tests (constructed without it) working.
    @Optional()
    private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Create or refresh the installation for (gateway, tenant). Reinstalls
   * (including into a previously revoked workspace) reactivate the row
   * with fresh credentials and bump installedAt. The credentials go to
   * the org's credential store; the row only keeps the reference.
   */
  async upsert(gateway: Gateway, input: UpsertInstallationInput): Promise<ChannelInstallation> {
    let installation = await this.installationRepository.findOne({
      where: { gatewayId: gateway.id, externalTenantId: input.externalTenantId },
    });
    const isNew = !installation;

    if (installation) {
      installation.credentials = null;
      installation.status = 'active';
      installation.metadata = { ...(installation.metadata || {}), ...(input.metadata || {}) };
      installation.installedAt = new Date();
    } else {
      installation = this.installationRepository.create({
        gatewayId: gateway.id,
        organizationId: gateway.organizationId,
        externalTenantId: input.externalTenantId,
        credentials: null,
        credentialId: null,
        status: 'active',
        metadata: input.metadata || null,
        installedAt: new Date(),
      });
    }

    // Saved first so the credential row can name the installation it
    // belongs to; the reference is written with the second save.
    let saved = await this.installationRepository.save(installation);
    await this.attachCredentials(saved, input.credentials);
    saved = await this.installationRepository.save(saved);

    // security.sso_install — new external-workspace installs grant an
    // outside tenant access through this gateway; org admins should
    // know. First install only (reinstall/refresh is routine churn).
    if (isNew && this.notifications) {
      const detail =
        (input.metadata as any)?.teamName ||
        (input.metadata as any)?.workspaceName ||
        input.externalTenantId;
      this.notifications
        .emit({
          type: 'security.sso_install',
          organizationId: gateway.organizationId,
          roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
          title: 'New channel installation',
          body: `A channel integration was installed into an external workspace (${detail}).`,
          link: `/gateways/${gateway.id}`,
          email: {
            template: 'security.sso_install',
            params: { kind: 'channel', detail },
          },
        })
        .catch(() => {});
    }

    return saved;
  }

  /**
   * Resolve the decrypted credentials for an active installation of
   * `gatewayId` in `externalTenantId`, or null when the tenant never
   * installed / was revoked — callers fall back to the gateway's own
   * single-workspace configuration in that case. The credential
   * reference is the source of truth; the stored blob is the shim for
   * rows the startup backfill has not moved yet.
   */
  async resolveCredentials(
    gatewayId: string,
    externalTenantId: string,
  ): Promise<Record<string, any> | null> {
    const installation = await this.installationRepository.findOne({
      where: { gatewayId, externalTenantId, status: 'active' },
    });
    if (!installation) return null;
    if (installation.credentialId) {
      const resolved = await this.credentialRefs.resolve(installation.organizationId, installation.credentialId, {
        context: { purpose: 'channel_inbound', resourceType: 'channel_installation', resourceId: installation.id },
      });
      return resolved.config;
    }
    if (!installation.credentials) return null;
    return this.decryptLegacyCredentials(installation.organizationId, installation.credentials);
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
   * Revoke an installation: status=revoked, the credential row released
   * and the shim blob cleared, so the workspace token no longer exists
   * anywhere in our database.
   */
  async revoke(gatewayId: string, installationId: string): Promise<Record<string, any>> {
    const installation = await this.installationRepository.findOne({
      where: { id: installationId, gatewayId },
    });
    if (!installation) {
      throw new NotFoundException('Installation not found');
    }
    await this.credentialRefs.releaseManaged(installation.organizationId, installation.credentialId, {
      kind: 'channel_installation',
      id: installation.id,
    });
    installation.status = 'revoked';
    installation.credentials = null;
    installation.credentialId = null;
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
  // Credential store
  // ---------------------------------------------------------------------------

  /**
   * Store the workspace's credentials as a row this installation
   * manages: rotated in place on a reinstall, deleted on revoke. Secret
   * keys are encrypted by the store (a BYO-KMS org's through its CMK).
   */
  private async attachCredentials(installation: ChannelInstallation, credentials: Record<string, any>): Promise<void> {
    const config: Record<string, any> = {};
    for (const [key, value] of Object.entries(credentials || {})) {
      if (value == null) continue;
      config[key] = SECRET_CREDENTIAL_KEYS.has(key) ? String(value) : value;
    }
    const managedBy = { kind: 'channel_installation' as const, id: installation.id };
    const secretKeys = Array.from(SECRET_CREDENTIAL_KEYS);
    const current = installation.credentialId
      ? await this.credentialRefs.load(installation.organizationId, installation.credentialId).catch(() => null)
      : null;
    if (current && CredentialRefResolver.isManagedBy(current, managedBy)) {
      await this.credentialRefs.rotateManaged(installation.organizationId, current.id, { config, secretKeys, managedBy });
      return;
    }
    const row = await this.credentialRefs.createManaged(installation.organizationId, {
      name: `Channel installation ${installation.externalTenantId}`,
      description: `Workspace credentials for gateway ${installation.gatewayId}, tenant ${installation.externalTenantId}`,
      type: CredentialType.CUSTOM,
      config,
      secretKeys,
      managedBy,
    });
    installation.credentialId = row.id;
  }

  /**
   * Shim for rows the startup backfill has not moved yet: decrypt the
   * stored blob. Prefix routing means platform / plaintext values decrypt
   * exactly as before; `encrypted:kms:` values are unwrapped via the
   * org's CMK. TODO(2026-12-01): drop with the column.
   */
  private async decryptLegacyCredentials(
    organizationId: string,
    credentials: Record<string, any>,
  ): Promise<Record<string, any>> {
    const out: Record<string, any> = {};
    for (const [key, value] of Object.entries(credentials)) {
      out[key] =
        typeof value === 'string'
          ? await this.envelopeCrypto.decryptForOrg(organizationId, value)
          : value;
    }
    return out;
  }

  private sanitize(installation: ChannelInstallation): Record<string, any> {
    return {
      id: installation.id,
      gatewayId: installation.gatewayId,
      externalTenantId: installation.externalTenantId,
      status: installation.status,
      credentialId: installation.credentialId ?? null,
      metadata: installation.metadata,
      installedAt: installation.installedAt,
      createdAt: installation.createdAt,
    };
  }
}
