import { ConflictException, Inject, Optional, forwardRef } from '@nestjs/common';
import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Gateway, GatewayKind, GatewayType, GatewayStatus } from '../../entities/gateway.entity';
import { GatewayTool } from '../../entities/gateway-tool.entity';
import { GatewayAuth } from '../../entities/gateway-auth.entity';
import { User } from '../../entities/user.entity';
import { Organization } from '../../entities/organization.entity';
import { UsageMetric } from '../../entities/usage-metric.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

import { GatewaysStatsHelper } from './gateways-stats.helper';
import { GatewayInitHelper } from './gateway-init.helper';
import { canPublishHostedChat } from './channels/hosted-chat.config';
import { stripCustomDomainFromConfiguration } from './channels/custom-domain';
import { EE_ENTITLEMENTS } from '../licensing/license.constants';
import { OrgLicenseResolver } from '../licensing/org-license.resolver';
import { AccessPolicyService, normaliseVisibility, type ResourceVisibility } from '../../common/authorization/access-policy.service';
import { ExecutionAccessService, gatewayPrincipal } from '../../common/authorization/execution-access.service';
import { Agent } from '../../entities/agent.entity';
import { PRIVATE_CAPABLE_GATEWAY_TYPES, gatewayServableTo } from './private-gateway';
import {
  encryptChannelConfigSecrets,
  hasInlineChannelSecret,
  restoreMaskedChannelSecrets,
  splitChannelConfigSecrets,
  type ChannelSecretEnvelope,
} from './channels/channel-config.helper';
import { ChannelCredentialService } from './channels/channel-credential.service';
import { encryptField as platformEncryptField } from '../../common/security/field-crypto';
import { DiscordGatewayTransport } from './channels/discord-gateway.transport';
import { ChannelWebhookRegistrar } from './channels/channel-webhook-registrar.service';
import { EmailProvisioningService } from './channels/email-provisioning.service';
import { EnvelopeCryptoService } from '../kms/envelope-crypto.service';
import { withGatewayQuota } from './gateway-quota';

/**
 * The partial unique index that actually reserves a hosted-chat slug.
 * Named here because the service has to recognise its 23505.
 */
export const HOSTED_CHAT_SLUG_INDEX = 'UQ_gateways_hosted_chat_slug';

export interface CreateGatewayDto {
  name: string;
  description?: string;
  type: GatewayType;
  agentId?: string;
  endpoint: string;
  configuration: Record<string, any>;
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    perVisitorPerHour?: number;
    perIpPerHour?: number;
  };

  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };
  requestTimeout?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };
  metadata?: Record<string, any>;
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

export interface UpdateGatewayDto {
  name?: string;
  description?: string;
  /**
   * Which agent answers here.
   *
   * Applied by the Object.assign below and always has been; it was
   * simply absent from this type, so a caller repointing a gateway had
   * to cast. Declaring it is what makes that caller's intent checkable.
   */
  agentId?: string;
  configuration?: Record<string, any>;
  rateLimitConfig?: {
    enabled: boolean;
    requestsPerMinute?: number;
    requestsPerHour?: number;
    requestsPerDay?: number;
    perVisitorPerHour?: number;
    perIpPerHour?: number;
  };

  corsConfig?: {
    origins: string[];
    methods: string[];
    allowedHeaders: string[];
    credentials: boolean;
  };
  webhooks?: {
    enabled: boolean;
    endpoints: Array<{
      url: string;
      events: string[];
      secret?: string;
    }>;
  };
  requestTimeout?: number;
  maxRetries?: number;
  customHeaders?: Record<string, string>;
  healthCheck?: {
    enabled: boolean;
    endpoint?: string;
    interval?: number;
    timeout?: number;
  };
  metadata?: Record<string, any>;
  visibility?: ResourceVisibility;
  teamId?: string | null;
}

export interface GatewaySearchFilters {
  search?: string;
  kind?: GatewayKind;
  type?: GatewayType;
  status?: GatewayStatus;
  agentId?: string;
  organizationId: string;
  // Required so getGateways can apply the team-scope visibility
  // filter via AccessPolicyService.applyListFilter.
  caller: { id: string };
  page?: number;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt' | 'totalRequests';
  sortOrder?: 'ASC' | 'DESC';
}

export interface GatewayStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageResponseTime: number;
  successRate: number;
  activeTools: number;
  uniqueUsers: number;
  requestTrend: Array<{
    date: string;
    requests: number;
    success: number;
    failed: number;
  }>;
}

/**
 * The hosted-chat refusals that are about what an organization has paid
 * for, as opposed to how an operator has configured a surface.
 *
 * Only these are enforced server-side on write. The rest — the cost cap
 * and rate limits a public link needs — depend on values that do not
 * exist on a gateway, so this path cannot judge them.
 */
const ENTITLEMENT_REFUSALS = new Set([
  'WHITE_LABEL_NOT_ENTITLED',
  'DISCLOSURE_REMOVAL_NOT_ENTITLED',
  'AUTH_MODE_NOT_ENTITLED',
]);

@Injectable()
export class GatewaysService {
  private readonly logger = new Logger(GatewaysService.name);

  constructor(
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(GatewayTool)
    private gatewayToolRepository: Repository<GatewayTool>,
    @InjectRepository(GatewayAuth)
    private gatewayAuthRepository: Repository<GatewayAuth>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(Organization)
    private organizationRepository: Repository<Organization>,
    @InjectRepository(UsageMetric)
    private usageMetricRepository: Repository<UsageMetric>,
    private readonly auditLogService: AuditLogService,
    @Inject(forwardRef(() => GatewaysStatsHelper))
    private readonly statsHelper: GatewaysStatsHelper,
    private readonly init: GatewayInitHelper,
    private readonly accessPolicy: AccessPolicyService,
    // Optional so unit tests (and contexts without the transport) can
    // construct the service without a live discord connection manager.
    @Optional() private readonly discordTransport?: DiscordGatewayTransport,
    // Optional for the same reason: platform webhook auto-registration
    // must never be required to construct the service.
    @Optional() private readonly webhookRegistrar?: ChannelWebhookRegistrar,
    // Optional for the same reason: email inbound-address provisioning
    // must never be required to construct the service.
    @Optional() private readonly emailProvisioner?: EmailProvisioningService,
    // Optional so positional unit tests can construct the service without
    // it. When absent, channel-secret encryption falls back to the platform
    // path (byte-identical to the pre-KMS behavior); when present, a BYO-KMS
    // org's secrets are wrapped with the customer CMK.
    @Optional() private readonly envelopeCrypto?: EnvelopeCryptoService,
    // Optional for the same reason. When present, channel secrets are
    // moved to the credential store instead of being encrypted inline.
    @Optional() private readonly channelCredentials?: ChannelCredentialService,
    // Optional for the same reason. Absent means unentitled, which is the
    // safe answer for the checks below.
    @Optional() private readonly orgLicense?: OrgLicenseResolver,
  ) {}

  /**
   * Refuse a hosted-chat configuration the organization is not entitled to.
   *
   * canPublishHostedChat existed and was called from exactly one place:
   * the builder component, in the browser. Nothing on the server ran it,
   * and the gateway write path has no HOSTED_CHAT case at all -- so a
   * PATCH setting `whiteLabel: true` and `aiDisclosure: ""` was simply
   * accepted, and the public page then dropped both the almyty mark and
   * the AI disclosure. The disclosure is an EU AI Act Art. 50 control,
   * not decoration, so a browser-only check was never enough.
   */
  private async assertHostedChatEntitled(
    organizationId: string,
    configuration: Record<string, any> | undefined,
  ): Promise<void> {
    const hostedChat = configuration?.hostedChat;
    if (!hostedChat) return;

    const entitled = async (key: string) => {
      try {
        return this.orgLicense ? await this.orgLicense.hasForOrg(organizationId, key) : false;
      } catch {
        return false;
      }
    };

    // Entitlement refusals only.
    //
    // canPublishHostedChat also gates a public link on a cost cap and
    // rate limits, and those values do not exist on a gateway: they live
    // on AgentApp.limits, and the builder reads them from the gateway row
    // rather than from this config blob. Passing the blob's (absent) keys
    // in made the context permanently null, so every public_link save --
    // the schema default, and the ordinary case -- was refused with
    // PUBLIC_LINK_NEEDS_COST_CAP and no value an operator could set to
    // clear it. That was a regression this method introduced.
    //
    // What belongs here is the half the browser must not be trusted with:
    // whether this organization may remove the almyty mark, blank the AI
    // disclosure, or use an enterprise auth mode.
    const check = canPublishHostedChat(hostedChat as any, {
      hasEnterpriseAuth: await entitled(EE_ENTITLEMENTS.SSO),
      hasWhiteLabel: await entitled(EE_ENTITLEMENTS.WHITE_LABEL),
    });

    const entitlementRefusals = check.refusals.filter(r => ENTITLEMENT_REFUSALS.has(r.code));
    if (entitlementRefusals.length > 0) {
      throw new BadRequestException({
        success: false,
        code: 'HOSTED_CHAT_NOT_PUBLISHABLE',
        message: entitlementRefusals.map(r => r.message).join(' '),
        refusals: entitlementRefusals,
      });
    }
  }

  /**
   * Only the protocol surfaces (MCP, UTCP, Skills, A2A, ACP, OpenAI chat)
   * can be private: a channel is reached by people outside almyty with no
   * user identity, so a private one could never answer its owner either.
   */
  private assertPrivateCapable(type: GatewayType): void {
    if (!PRIVATE_CAPABLE_GATEWAY_TYPES.has(type)) {
      throw new BadRequestException(
        'Only MCP, UTCP, Skills, A2A, ACP and OpenAI-compatible gateways can be private; ' +
          'chat channels are reached by people who do not sign in to almyty',
      );
    }
  }

  /**
   * Keep the persistent discord gateway connection in sync with the
   * gateway row. Fire-and-forget: connection management must never
   * fail a CRUD request.
   */
  private syncDiscordTransport(gateway: Gateway): void {
    if (gateway.type !== GatewayType.DISCORD) return;
    try {
      this.discordTransport?.sync(gateway);
    } catch (err: any) {
      this.logger.warn(`Failed to sync discord gateway transport: ${err.message}`);
    }
  }

  private stopDiscordTransport(gateway: Gateway): void {
    if (gateway.type !== GatewayType.DISCORD) return;
    try {
      this.discordTransport?.stop(gateway.id);
    } catch (err: any) {
      this.logger.warn(`Failed to stop discord gateway transport: ${err.message}`);
    }
  }

  /**
   * Keep the platform inbound-webhook registration (telegram
   * setWebhook, twilio number webhook) and the email inbound-address
   * provisioning in sync with the gateway row. Fire-and-forget:
   * neither must ever fail a CRUD request.
   */
  private syncWebhookRegistration(gateway: Gateway): void {
    this.webhookRegistrar
      ?.sync(gateway)
      .catch((err: any) =>
        this.logger.warn(`Failed to sync channel webhook registration: ${err.message}`),
      );
    this.emailProvisioner
      ?.sync(gateway)
      .catch((err: any) =>
        this.logger.warn(`Failed to sync email inbound provisioning: ${err.message}`),
      );
  }

  private removeWebhookRegistration(gateway: Gateway): void {
    this.webhookRegistrar
      ?.remove(gateway)
      .catch((err: any) =>
        this.logger.warn(`Failed to remove channel webhook registration: ${err.message}`),
      );
    this.emailProvisioner
      ?.remove(gateway)
      .catch((err: any) =>
        this.logger.warn(`Failed to remove email inbound provisioning: ${err.message}`),
      );
  }

  /**
   * Reserve a hosted-chat subdomain globally.
   *
   * App slugs are tenant-scoped, but a hosted chat's DNS name is not:
   * `{slug}.almyty.app` is one public address for the whole deployment.
   * Letting two organizations publish the same slug makes the public
   * lookup ambiguous and can route one tenant to another tenant's agent.
   *
   * This check is a SELECT before an INSERT, so it cannot be atomic on
   * its own. The thing that actually reserves the address is the partial
   * unique index `UQ_gateways_hosted_chat_slug`; this runs first only so
   * the ordinary case gets a readable message instead of a driver error.
   * The loser of a genuine race comes back through
   * hostedChatSlugConflict() with the same conflict.
   */
  private async assertHostedChatSlugAvailable(
    configuration: Record<string, any> | undefined,
    allowedGatewayId?: string,
  ): Promise<void> {
    const raw = configuration?.hostedChat?.slug;
    const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (!slug) return;

    const claims = await this.gatewayRepository
      .createQueryBuilder('gateway')
      .where('gateway.type = :type', { type: GatewayType.HOSTED_CHAT })
      .andWhere("gateway.configuration -> 'hostedChat' ->> 'slug' = :slug", { slug })
      .getMany();

    if (claims.some((gateway) => gateway.id !== allowedGatewayId)) {
      throw this.slugConflict(slug);
    }
  }

  private slugConflict(slug: string): ConflictException {
    return new ConflictException(
      `The web address '${slug}' is already in use. Choose a different app name.`,
    );
  }

  /**
   * Translate the slug index's unique violation into the same conflict
   * the pre-check raises, so a lost race is a 409 and not a 500.
   */
  private hostedChatSlugConflict(
    error: any,
    configuration?: Record<string, any>,
  ): ConflictException | null {
    const code = error?.code ?? error?.driverError?.code;
    if (code !== '23505') return null;
    const marker = HOSTED_CHAT_SLUG_INDEX;
    const mentions = [
      error?.constraint,
      error?.driverError?.constraint,
      error?.detail,
      error?.driverError?.detail,
      error?.message,
    ].some((field) => typeof field === 'string' && field.includes(marker));
    if (!mentions) return null;

    const raw = configuration?.hostedChat?.slug;
    const slug = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    return this.slugConflict(slug);
  }

  /**
   * Channel configs carry channel secrets: the app's OAuth client
   * secret (multi-workspace installs, e.g. a Slack app's
   * client_secret) plus per-channel credentials such as bot_token,
   * twilio_auth_token, access_token, signing secrets, verify/bridge
   * tokens etc. Encrypt them at rest; decryption happens at the point
   * of use (getChannelConfig in the channel pipeline,
   * SlackInstallService for OAuth), and isEncrypted() makes this
   * idempotent so an already-encrypted value round-trips through
   * update unchanged.
   */
  private async encryptConfigSecrets(
    configuration: Record<string, any> | undefined,
    organizationId: string,
  ): Promise<void> {
    await encryptChannelConfigSecrets(configuration, organizationId, this.secretEnvelope());
  }

  /**
   * Channel secrets belong in the credential store. With the channel
   * credential service wired (always, outside positional unit tests)
   * pasted values become a managed connection and the row keeps only
   * `credentialId` + `credentialKeys`; without it the inline encryption
   * path above is the fallback.
   */
  private async storeChannelSecrets(
    gateway: Gateway,
    configuration: Record<string, any> | undefined,
    previous: Record<string, any> | null | undefined,
  ): Promise<void> {
    if (!configuration) return;
    if (!this.channelCredentials) {
      await this.encryptConfigSecrets(configuration, gateway.organizationId);
      return;
    }
    await this.channelCredentials.persistSecrets(gateway, configuration, previous);
  }

  private async releaseChannelCredential(gateway: Gateway): Promise<void> {
    try {
      await this.channelCredentials?.release(gateway);
    } catch (err: any) {
      this.logger.warn(`Failed to release channel credential of gateway ${gateway.id}: ${err?.message ?? err}`);
    }
  }

  /**
   * Take back a gateway whose creation failed after the row was
   * written, so the endpoint is free for the retry the caller is about
   * to make. Neither step may mask the original error; a cleanup that
   * itself fails is logged loudly, because then the endpoint really is
   * stuck and someone has to look.
   */
  private async discardPartialGateway(gateway: Gateway): Promise<void> {
    await this.releaseChannelCredential(gateway);
    try {
      await this.gatewayRepository.delete({ id: gateway.id });
    } catch (err: any) {
      this.logger.error(
        `Gateway ${gateway.id} could not be removed after a failed create; ` +
          `endpoint ${gateway.endpoint} stays taken in org ${gateway.organizationId}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Envelope used to encrypt channel secrets. Prefers the injected
   * EnvelopeCryptoService (org-aware BYO-KMS routing); when it is absent
   * (positional unit tests), falls back to the platform field-crypto path,
   * which produces the exact same `encrypted:gcm:` value as before.
   */
  private secretEnvelope(): ChannelSecretEnvelope {
    if (this.envelopeCrypto) return this.envelopeCrypto;
    return {
      encryptForOrg: (_organizationId: string, plaintext: string) =>
        Promise.resolve(platformEncryptField(plaintext)),
    };
  }

  async createGateway(
    createGatewayDto: CreateGatewayDto,
    organizationId: string,
    userId: string,
    // A caller that has more writes to do before the surface should
    // answer creates it INACTIVE and activates it last, so a crash
    // mid-sequence leaves nothing live. Everything else wants the
    // gateway routable as soon as it commits.
    initialStatus: GatewayStatus = GatewayStatus.ACTIVE,
  ): Promise<Gateway> {
    try {
      this.logger.log(`[CREATE_GATEWAY] Creating gateway '${createGatewayDto.name}' for org=${organizationId}, user=${userId}`);

      // Verify organization and user permissions
      const organization = await this.organizationRepository.findOne({
        where: { id: organizationId },
      });

      if (!organization) {
        throw new NotFoundException('Organization not found');
      }

      const user = await this.userRepository.findOne({
        where: { id: userId },
        relations: { organizationMemberships: true },
      });

      if (!user?.hasPermissionInOrganization(organizationId, 'create_gateways')) {
        throw new ForbiddenException('User does not have permission to create gateways');
      }

      // Organization limits (settings.maxGateways) are enforced with the
      // insert below, by withGatewayQuota.

      // Ensure endpoint starts with /
      const endpoint = createGatewayDto.endpoint.startsWith('/')
        ? createGatewayDto.endpoint
        : '/' + createGatewayDto.endpoint;

      // Validate endpoint uniqueness within organization
      const existingGateway = await this.gatewayRepository.findOne({
        where: { endpoint, organizationId },
      });

      if (existingGateway) {
        throw new BadRequestException('Endpoint already exists in your organization');
      }

      // Infer kind from type if not provided
      const kind = Gateway.kindForType(createGatewayDto.type);

      // Validate kind/type exclusivity
      if (kind === GatewayKind.AGENT && !createGatewayDto.agentId) {
        throw new BadRequestException('Agent-kind gateways require an agentId');
      }
      if (kind === GatewayKind.TOOL && createGatewayDto.agentId) {
        throw new BadRequestException('Tool-kind gateways cannot have an agentId');
      }

      // Never taken from the body: a domain is active only once verified.
      stripCustomDomainFromConfiguration(createGatewayDto.configuration);
      // Validate configuration based on gateway type
      this.init.validateGatewayConfiguration(createGatewayDto.type, createGatewayDto.configuration);

      if (createGatewayDto.type === GatewayType.HOSTED_CHAT) {
        await this.assertHostedChatSlugAvailable(createGatewayDto.configuration);
        await this.assertHostedChatEntitled(organizationId, createGatewayDto.configuration);
      }

      // Validate team scoping before persisting.
      await this.accessPolicy.assertCanScopeToTeam(
        userId,
        organizationId,
        createGatewayDto.visibility,
        createGatewayDto.teamId,
      );
      const scope = normaliseVisibility(createGatewayDto.visibility, createGatewayDto.teamId);
      if (scope.visibility === 'private') this.assertPrivateCapable(createGatewayDto.type);
      // What the gateway serves must be at least as private as the
      // gateway itself (a private agent only behind its owner's private
      // gateway). Checked on an unsaved row, so only the agent applies.
      await this.assertContentsServable(
        { ...scope, ownerUserId: userId, organizationId, agentId: createGatewayDto.agentId } as Gateway,
        userId,
      );

      // Channel secrets go to the credential store, never onto the row.
      // The managed row names the gateway, so it is created after the
      // first save; until then the row carries only the public part.
      const inlineConfiguration = createGatewayDto.configuration;
      const deferSecrets = !!this.channelCredentials && !!inlineConfiguration
        && (hasInlineChannelSecret(inlineConfiguration) || 'credentialId' in inlineConfiguration);
      if (!deferSecrets) {
        await this.encryptConfigSecrets(createGatewayDto.configuration, organizationId);
      }

      // Create the gateway
      const gateway = this.gatewayRepository.create({
        ...createGatewayDto,
        ...(deferSecrets ? { configuration: splitChannelConfigSecrets(inlineConfiguration).publicConfig } : {}),
        kind,
        endpoint,
        organizationId,
        status: initialStatus,
        visibility: scope.visibility,
        teamId: scope.teamId,
        // Always record who made it: a private gateway needs its owner,
        // and an org gateway flipped to private later keeps the creator.
        ownerUserId: userId,
      });

      // The row, its channel secret and its default auth config are
      // three writes across two tables plus the credential store, and
      // only the first has to land for the endpoint to be taken:
      // `(organizationId, endpoint)` is uniquely indexed. A failure in
      // a later step used to leave an ACTIVE row behind with no auth
      // config and no secrets — the caller saw a 500 and believed
      // nothing had been created, but could then neither use the
      // gateway nor recreate it ("Endpoint already exists in your
      // organization"). It failed closed, so never an auth hole, just
      // an endpoint nobody could have.
      //
      // Undone rather than wrapped in a database transaction: the
      // secret write goes to the credential store through its own
      // service, which no transaction opened here could enlist, so the
      // failure path has to compensate for that write regardless.
      // Compensating for all of it keeps one recovery path instead of
      // two that have to agree.
      //
      // The quota check and this first insert share one transaction under
      // the organization's gateway-quota lock (see gateway-quota.ts), so
      // two concurrent creates cannot both take the last slot.
      let savedGateway = await withGatewayQuota(
        this.gatewayRepository.manager,
        organizationId,
        1,
        (tx) => tx.getRepository(Gateway).save(gateway),
      );
      try {
        if (deferSecrets) {
          savedGateway.configuration = inlineConfiguration;
          await this.storeChannelSecrets(savedGateway, savedGateway.configuration, null);
          savedGateway = await this.gatewayRepository.save(savedGateway);
        }

        this.logger.log(`[CREATE_GATEWAY] Gateway saved to DB: id=${savedGateway.id}, name='${savedGateway.name}', org=${savedGateway.organizationId}`);

        // Create default authentication if not provided
        await this.init.createDefaultAuth(savedGateway);
      } catch (error) {
        await this.discardPartialGateway(savedGateway);
        throw error;
      }

      this.logger.log(`[CREATE_GATEWAY] Gateway '${savedGateway.name}' created successfully in organization ${organizationId}`);

      // Start the persistent connection for discord channel gateways.
      this.syncDiscordTransport(savedGateway);

      // Register the platform inbound webhook (telegram/twilio) for
      // channel gateways that support it.
      this.syncWebhookRegistration(savedGateway);

      // Audit log (fire-and-forget)
      this.auditLogService.logCreate(organizationId, userId, AuditResource.GATEWAY, savedGateway.id, savedGateway.name);

      return savedGateway;

    } catch (error) {
      const conflict = this.hostedChatSlugConflict(error, createGatewayDto.configuration);
      if (conflict) throw conflict;
      this.logger.error(`Failed to create gateway: ${error.message}`);
      throw error;
    }
  }

  async updateGateway(
    gatewayId: string,
    updateGatewayDto: UpdateGatewayDto,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    try {
      const gateway = await this.gatewayRepository.findOne({
        where: { id: gatewayId, organizationId },
      });

      if (!gateway) {
        throw new NotFoundException('Gateway not found');
      }

      // Authorization: org owner/admin always, team-scoped requires team lead
      await this.assertCanManage(gateway, userId);

      // Re-validate team scoping if it's being changed.
      const updateAnyEarly = updateGatewayDto as any;
      if (updateAnyEarly.visibility !== undefined || updateAnyEarly.teamId !== undefined) {
        const nextVis = updateAnyEarly.visibility ?? gateway.visibility;
        const nextTeamId = updateAnyEarly.teamId !== undefined ? updateAnyEarly.teamId : gateway.teamId;
        await this.accessPolicy.assertCanScopeToTeam(userId, organizationId, nextVis, nextTeamId);
      }

      // Capture old values for change tracking (before mutation)
      const oldValues = { name: gateway.name, description: gateway.description, configuration: gateway.configuration, rateLimitConfig: gateway.rateLimitConfig, metadata: gateway.metadata };
      // The owner is recorded by the server, never taken from a body.
      const recordedOwner = gateway.ownerUserId ?? null;

      // API responses mask channel secrets; an edit dialog that
      // round-trips the whole configuration sends the mask back for
      // untouched fields. Swap masked placeholders for the stored
      // values so they survive the update.
      restoreMaskedChannelSecrets(updateGatewayDto.configuration, gateway.configuration);
      // The custom domain claim and the visitor OAuth provider have
      // their own columns and their own endpoints; neither is written here.
      stripCustomDomainFromConfiguration(updateGatewayDto.configuration);
      delete (updateGatewayDto as any).customDomain;
      delete (updateGatewayDto as any).visitorOAuth;

      // Update fields
      Object.assign(gateway, updateGatewayDto);
      gateway.ownerUserId = recordedOwner;
      // Sanitize scoping after the spread: 'org' and 'private' carry no
      // teamId, so flipping away from 'team' clears the dangling one.
      const updateAny = updateGatewayDto as any;
      const scopeChanged = updateAny.visibility !== undefined || updateAny.teamId !== undefined;
      if (scopeChanged) {
        const scope = normaliseVisibility(gateway.visibility, gateway.teamId);
        gateway.visibility = scope.visibility;
        gateway.teamId = scope.teamId;
      }
      if (gateway.visibility === 'private') {
        this.assertPrivateCapable(gateway.type);
        // Only the recorded owner can make a gateway private. A row with
        // no recorded creator (made before owners were recorded) becomes
        // the caller's.
        if (!gateway.ownerUserId) {
          gateway.ownerUserId = userId;
        } else if (gateway.ownerUserId !== userId) {
          throw new ForbiddenException('Only the gateway\'s owner can make it private');
        }
      }
      if (scopeChanged || updateAny.agentId !== undefined) {
        await this.assertContentsServable(gateway, userId);
      }

      // Validate configuration if updated
      if (updateGatewayDto.configuration) {
        this.init.validateGatewayConfiguration(gateway.type, gateway.configuration);
        if (gateway.type === GatewayType.HOSTED_CHAT) {
          await this.assertHostedChatSlugAvailable(gateway.configuration, gateway.id);
          await this.assertHostedChatEntitled(gateway.organizationId, gateway.configuration);
        }
        await this.storeChannelSecrets(gateway, gateway.configuration, oldValues.configuration);
      }

      const updatedGateway = await this.gatewayRepository.save(gateway);

      this.logger.log(`Gateway '${updatedGateway.name}' updated`);

      // Reconcile the persistent connection for discord channel gateways
      // (bot token may have changed).
      this.syncDiscordTransport(updatedGateway);

      // Reconcile the platform webhook registration (token or public
      // endpoint may have changed).
      this.syncWebhookRegistration(updatedGateway);

      // Audit log (fire-and-forget)
      const changes = this.auditLogService.computeChanges(oldValues, updateGatewayDto, ['name', 'description', 'configuration', 'rateLimitConfig', 'metadata']);
      this.auditLogService.logUpdate(organizationId, userId, AuditResource.GATEWAY, updatedGateway.id, updatedGateway.name, changes);

      return updatedGateway;

    } catch (error) {
      const conflict = this.hostedChatSlugConflict(error, updateGatewayDto.configuration);
      if (conflict) throw conflict;
      this.logger.error(`Failed to update gateway: ${error.message}`);
      throw error;
    }
  }

  /**
   * Resolve a gateway by @orgSlug/gateway-name-slug.
   * Used by the CLI to avoid exposing UUIDs.
   *
   * `callerOrganizationId` is the org the request was authorized against.
   * Org slugs are public — they are in every unified-endpoint URL — so
   * without this the route answered for any tenant: the role check ran
   * against the caller's own org while the lookup ran against the slug in
   * the path, handing back another tenant's gateway id, name, type and
   * endpoint. Nothing is said about whether the slug exists.
   */
  async resolveGateway(
    orgSlug: string,
    gatewayNameSlug: string,
    callerOrganizationId: string,
    // Another member's private gateway resolves exactly like a slug that
    // does not exist. Required so no caller forgets to say who is asking.
    callerId: string | null,
  ): Promise<Gateway> {
    const organization = await this.organizationRepository.findOne({
      where: { slug: orgSlug },
    });
    if (!organization || organization.id !== callerOrganizationId) {
      throw new NotFoundException(`Gateway not found: @${orgSlug}/${gatewayNameSlug}`);
    }

    // Try matching by endpoint (which is already a slug like /httpbin-skills-gateway)
    let gateway = await this.gatewayRepository.findOne({
      where: { organizationId: organization.id, endpoint: `/${gatewayNameSlug}` },
      relations: { tools: { tool: true }, authConfigs: true },
    });
    if (gateway && !gatewayServableTo(gateway, callerId)) gateway = null;

    // Fallback: match by slugified name
    if (!gateway) {
      const gateways = await this.gatewayRepository.find({
        where: { organizationId: organization.id },
        relations: { tools: { tool: true }, authConfigs: true },
      });
      gateway = gateways.find(g =>
        g.name.toLowerCase().replace(/\s+/g, '-') === gatewayNameSlug
          && gatewayServableTo(g, callerId)
      ) || null;
    }

    if (!gateway) {
      throw new NotFoundException(`Gateway not found: @${orgSlug}/${gatewayNameSlug}`);
    }

    return gateway;
  }

  /**
   * Load a gateway of the organization.
   *
   * `caller` is who is asking. Another user's private gateway is reported
   * as not found -- to org owners and admins too -- so its existence is
   * not confirmed. Internal callers that act for the platform rather than
   * for a person (stats roll-ups, the channel pipeline) omit it.
   */
  async getGateway(
    gatewayId: string,
    organizationId: string,
    includeRelations = true,
    caller?: { id: string } | null,
  ): Promise<Gateway> {
    const relations = includeRelations ? {
      tools: { tool: true },
      authConfigs: true,
    } : {};

    const gateway = await this.gatewayRepository.findOne({
      where: { id: gatewayId, organizationId },
      relations,
    });

    if (!gateway) {
      throw new NotFoundException('Gateway not found');
    }
    if (caller !== undefined && !gatewayServableTo(gateway, caller?.id)) {
      throw new NotFoundException('Gateway not found');
    }

    return gateway;
  }

  /**
   * The manage gate, with one refinement over canAccess: another user's
   * private gateway is a 404, not a 403, so a caller probing ids learns
   * nothing about it.
   */
  /**
   * A gateway of this organization that the caller may manage, by the
   * same rule updateGateway applies. For write paths that live outside
   * this service (the custom-domain verification flow).
   */
  async findManageable(gatewayId: string, organizationId: string, userId: string): Promise<Gateway> {
    const gateway = await this.gatewayRepository.findOne({ where: { id: gatewayId, organizationId } });
    if (!gateway) throw new NotFoundException('Gateway not found');
    await this.assertCanManage(gateway, userId);
    return gateway;
  }

  private async assertCanManage(gateway: Gateway, userId: string): Promise<void> {
    if (!gatewayServableTo(gateway, userId)) {
      throw new NotFoundException('Gateway not found');
    }
    const decision = await this.accessPolicy.canAccess({ id: userId }, gateway, 'manage');
    if (!decision.allowed) {
      throw new ForbiddenException(decision.reason);
    }
  }

  /**
   * What a gateway serves has to be within the gateway's own scope.
   *
   * A gateway is a publication: whoever its auth admits gets what it
   * serves. So a private agent or tool can only sit behind a gateway
   * private to the same owner, and a team one only behind a gateway scoped
   * to that team (or private to someone who may run it) -- the rule
   * ExecutionAccessService applies again on every call. The person making
   * the change must be able to run it themselves; a resource they cannot
   * run is reported as not found.
   */
  async assertContentsServable(gateway: Gateway, userId: string): Promise<void> {
    const executionAccess = new ExecutionAccessService(this.accessPolicy);
    if (gateway.agentId) {
      const agent = await this.gatewayRepository.manager?.findOne(Agent, {
        where: { id: gateway.agentId, organizationId: gateway.organizationId },
        select: { id: true, name: true, organizationId: true, visibility: true, teamId: true, createdBy: true },
      });
      if (agent) {
        await executionAccess.assertGatewayMayServe(gateway, agent, userId, 'Agent');
      }
    }
    if (gateway.id) {
      const rows = await this.gatewayToolRepository.find({
        where: { gatewayId: gateway.id },
        relations: { tool: true },
      });
      for (const row of rows ?? []) {
        if (!row.tool) continue;
        const decision = await executionAccess.canExecute(gatewayPrincipal(gateway, userId), row.tool);
        if (!decision.allowed) {
          throw new BadRequestException(
            row.tool.visibility === 'team'
              ? 'This gateway serves team tools; it can only be scoped to their team'
              : 'This gateway serves private tools; it can only be private to their owner',
          );
        }
      }
    }
  }

  async getGateways(filters: GatewaySearchFilters): Promise<{
    gateways: Gateway[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    this.logger.log(`[GET_GATEWAYS] Fetching gateways for org=${filters.organizationId}`);

    // Self-heal: ensure the org has its system gateway. createOrganization()
    // calls ensureSystemGateway() inline, but auth.register() doesn't go
    // through that path — so freshly-signed-up orgs would render the
    // Gateways page as empty even though every org is supposed to ship
    // with the platform-management gateway used by MCP OAuth. The
    // ensureSystemGateway helper is idempotent (early-return on
    // existing isSystem=true row), so it costs one indexed lookup once
    // the gateway exists. Failure is logged-and-swallowed because we
    // don't want a transient gateway-create error to break listing.
    try {
      await this.init.ensureSystemGateway(filters.organizationId);
    } catch (err) {
      this.logger.warn(
        `[GET_GATEWAYS] ensureSystemGateway failed for org=${filters.organizationId}: ${err.message}`,
      );
    }

    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    // Count, don't load: the list only needs the number.
    //
    // This joined `gateway.tools` and `gatewayTool.tool`, so a page of 20
    // gateways averaging 100 tools hydrated 2,000 nested Tool entities --
    // each with `code`, `parameters` and `examples` -- and the authConfigs
    // join row-multiplied on top of them, all to render one integer per
    // row. Same shape as `ApisService.getApis`: a correlated COUNT read
    // back through getRawAndEntities.
    const queryBuilder = this.gatewayRepository
      .createQueryBuilder('gateway')
      .leftJoinAndSelect('gateway.authConfigs', 'authConfig')
      .where('1=1');
    queryBuilder.addSelect(
      (sub) =>
        sub
          .select('COUNT(gt.id)', 'cnt')
          .from(GatewayTool, 'gt')
          .where('gt."gatewayId" = gateway.id'),
      'gateway_toolCount',
    );
    await this.accessPolicy.applyListFilter(queryBuilder, filters.caller, filters.organizationId, 'gateway', { ownerColumn: 'ownerUserId' });

    // Apply filters
    if (filters.search) {
      queryBuilder.andWhere(
        '(gateway.name ILIKE :search OR gateway.description ILIKE :search)',
        { search: `%${filters.search}%` }
      );
    }

    if (filters.kind) {
      const toolTypes = [GatewayType.MCP, GatewayType.UTCP, GatewayType.SKILLS];
      if (filters.kind === GatewayKind.TOOL) {
        queryBuilder.andWhere('gateway.type IN (:...toolTypes)', { toolTypes });
      } else {
        queryBuilder.andWhere('gateway.type NOT IN (:...toolTypes)', { toolTypes });
      }
    }

    if (filters.type) {
      queryBuilder.andWhere('gateway.type = :type', { type: filters.type });
    }

    if (filters.status) {
      queryBuilder.andWhere('gateway.status = :status', { status: filters.status });
    }

    if (filters.agentId) {
      queryBuilder.andWhere('gateway.agentId = :agentId', { agentId: filters.agentId });
    }

    // Apply sorting
    const sortBy = filters.sortBy || 'createdAt';
    const sortOrder = filters.sortOrder || 'DESC';
    // Paged with skip/take below, so the sort has to be total. `name` and
    // `createdAt` both tie readily, and a tied pair reshuffles between
    // requests — one gateway on two pages, another on none.
    queryBuilder.orderBy(`gateway.${sortBy}`, sortOrder).addOrderBy('gateway.id', 'ASC');

    // Get total count
    const total = await queryBuilder.getCount();

    // Apply pagination
    const { entities, raw } = await queryBuilder
      .skip(skip)
      .take(limit)
      .getRawAndEntities();

    // Keyed by id, not by position. The authConfigs join still emits one
    // raw row per (gateway, authConfig) pair while `entities` is deduped,
    // so raw[i] lines up with entities[i] only for gateways that happen
    // to have exactly one auth config.
    const toolCounts = new Map<string, number>();
    for (const row of raw) {
      const id = row?.gateway_id;
      if (id != null) toolCounts.set(String(id), Number(row.gateway_toolCount ?? 0));
    }
    entities.forEach((gateway) => {
      gateway.toolCount = toolCounts.get(gateway.id) ?? 0;
    });
    const gateways = entities;

    const totalPages = Math.ceil(total / limit);

    this.logger.log(`[GET_GATEWAYS] Found ${total} gateways for org=${filters.organizationId}`);

    return {
      gateways,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async activateGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    // Authorization: org owner/admin always, team-scoped requires team lead
    await this.assertCanManage(gateway, userId);

    if (gateway.status === GatewayStatus.ACTIVE) {
      return gateway;
    }

    gateway.status = GatewayStatus.ACTIVE;
    const updatedGateway = await this.gatewayRepository.save(gateway);

    this.logger.log(`Gateway '${gateway.name}' activated`);

    this.syncDiscordTransport(updatedGateway);
    this.syncWebhookRegistration(updatedGateway);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId, action: AuditAction.GATEWAY_ACTIVATE, resourceType: AuditResource.GATEWAY, resourceId: gateway.id, resourceName: gateway.name });

    return updatedGateway;
  }

  /**
   * The gateway a published app distribution answers on.
   *
   * Find-or-create rather than create, because publishing is idempotent:
   * doing it twice is usually someone reapplying a settings change, and
   * the endpoint is unique per organization so a second create would
   * simply fail. An existing one is re-synced with the product's current
   * name, branding and limits, and reactivated if it had been taken
   * down.
   *
   * Goes through createGateway and updateGateway rather than touching
   * the repository, so permission checks, organization limits and the
   * transport sync all still happen.
   *
   * `activate: false` hands the caller a gateway that exists but does
   * not answer yet, for a publish that has its own bookkeeping to
   * finish before the surface goes live.
   *
   * `gatewayId` is the gateway the distribution already answers on. It
   * wins over the endpoint, so a surface whose endpoint is not the
   * distribution's (one an app took over rather than stood up) is
   * re-synced rather than joined by a second gateway on the same address.
   */
  async upsertForDistribution(
    dto: CreateGatewayDto,
    organizationId: string,
    userId: string,
    options: { activate?: boolean; gatewayId?: string | null } = {},
  ): Promise<Gateway> {
    const activate = options.activate ?? true;
    const endpoint = dto.endpoint.startsWith('/') ? dto.endpoint : `/${dto.endpoint}`;
    const existing =
      (options.gatewayId
        ? await this.gatewayRepository.findOne({ where: { id: options.gatewayId, organizationId } })
        : null) ??
      (await this.gatewayRepository.findOne({
        where: { endpoint, organizationId },
      }));

    if (!existing) {
      return this.createGateway(
        dto,
        organizationId,
        userId,
        activate ? GatewayStatus.ACTIVE : GatewayStatus.INACTIVE,
      );
    }

    const updated = await this.updateGateway(
      existing.id,
      {
        name: dto.name,
        description: dto.description,
        // Repointed on every publish, so changing which agent an app
        // uses and republishing actually moves the surface.
        agentId: dto.agentId,
        configuration: dto.configuration,
        rateLimitConfig: dto.rateLimitConfig,
        // The surface follows its agent's scope on every publish (a team
        // agent is served through a gateway scoped to its team).
        ...(dto.visibility !== undefined ? { visibility: dto.visibility, teamId: dto.teamId ?? null } : {}),
      },
      organizationId,
      userId,
    );

    if (!activate || updated.status === GatewayStatus.ACTIVE) return updated;
    return this.activateGateway(updated.id, organizationId, userId);
  }

  async deactivateGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<Gateway> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    // Authorization: org owner/admin always, team-scoped requires team lead
    await this.assertCanManage(gateway, userId);

    if (gateway.status === GatewayStatus.INACTIVE) {
      return gateway;
    }

    gateway.status = GatewayStatus.INACTIVE;
    const updatedGateway = await this.gatewayRepository.save(gateway);

    this.logger.log(`Gateway '${gateway.name}' deactivated`);

    this.syncDiscordTransport(updatedGateway);
    this.syncWebhookRegistration(updatedGateway);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, userId, action: AuditAction.GATEWAY_DEACTIVATE, resourceType: AuditResource.GATEWAY, resourceId: gateway.id, resourceName: gateway.name });

    return updatedGateway;
  }

  async incrementRequestCount(gatewayId: string, success: boolean): Promise<void> {
    await this.gatewayRepository
      .createQueryBuilder()
      .update(Gateway)
      .set({
        totalRequests: () => '"totalRequests" + 1',
        successfulRequests: success ? () => '"successfulRequests" + 1' : () => '"successfulRequests"',
        lastRequestAt: new Date(),
      })
      .where('id = :id', { id: gatewayId })
      .execute();
  }

  async deleteGateway(
    gatewayId: string,
    organizationId: string,
    userId: string
  ): Promise<void> {
    const gateway = await this.getGateway(gatewayId, organizationId, false);

    if (gateway.isSystem) {
      throw new BadRequestException('System gateways cannot be deleted');
    }

    // Authorization: org owner/admin always, team-scoped requires team lead
    await this.assertCanManage(gateway, userId);

    await this.releaseChannelCredential(gateway);
    await this.gatewayRepository.remove(gateway);

    this.stopDiscordTransport(gateway);
    this.removeWebhookRegistration(gateway);

    this.logger.log(`Gateway '${gateway.name}' deleted`);

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, userId, AuditResource.GATEWAY, gatewayId, gateway.name);
  }

  /**
   * Ensure the system gateway exists for an organization. Upserts the
   * gateway row and its OAuth auth config. Called during org creation
   * and (via the migration) for all existing orgs.
   */

  private getWeekNumber(date: Date): number {
    const oneJan = new Date(date.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((date.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
    return Math.ceil((date.getDay() + 1 + numberOfDays) / 7);
  }

  // ── Delegations to GatewayInitHelper ──
  ensureSystemGateway(...args: Parameters<GatewayInitHelper['ensureSystemGateway']>) {
    return this.init.ensureSystemGateway(...args);
  }

  // ── Delegations to GatewaysStatsHelper ──
  getGatewayStats(...args: Parameters<GatewaysStatsHelper['getGatewayStats']>) { return this.statsHelper.getGatewayStats(...args); }
  getOrganizationGatewayStats(...args: Parameters<GatewaysStatsHelper['getOrganizationGatewayStats']>) { return this.statsHelper.getOrganizationGatewayStats(...args); }
  performHealthCheck(...args: Parameters<GatewaysStatsHelper['performHealthCheck']>) { return this.statsHelper.performHealthCheck(...args); }
  searchSkillsAcrossGateways(...args: Parameters<GatewaysStatsHelper['searchSkillsAcrossGateways']>) { return this.statsHelper.searchSkillsAcrossGateways(...args); }
  getAllUserGateways(...args: Parameters<GatewaysStatsHelper['getAllUserGateways']>) { return this.statsHelper.getAllUserGateways(...args); }
  getSkillContextOrganization(...args: Parameters<GatewaysStatsHelper['getSkillContextOrganization']>) { return this.statsHelper.getSkillContextOrganization(...args); }
  calculateRequestTrend(...args: Parameters<GatewaysStatsHelper['calculateRequestTrend']>) { return this.statsHelper.calculateRequestTrend(...args); }
}
