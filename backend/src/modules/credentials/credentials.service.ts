import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';

import { Credential } from '../../entities/credential.entity';
import { ApiKey } from '../../entities/api-key.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Api } from '../../entities/api.entity';
import { Gateway } from '../../entities/gateway.entity';
import { Agent } from '../../entities/agent.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { batchAsync } from '../../common/utils/batch-async';

@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);

  constructor(
    @InjectRepository(Credential)
    private credentialRepository: Repository<Credential>,
    @InjectRepository(ApiKey)
    private apiKeyRepository: Repository<ApiKey>,
    @InjectRepository(LlmProvider)
    private llmProviderRepository: Repository<LlmProvider>,
    @InjectRepository(Api)
    private apiRepository: Repository<Api>,
    @InjectRepository(Gateway)
    private gatewayRepository: Repository<Gateway>,
    @InjectRepository(Agent)
    private agentRepository: Repository<Agent>,
    private readonly auditLogService: AuditLogService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  // ──────────────────────────────────────────────
  // Outbound credentials (secrets vault)
  // ──────────────────────────────────────────────

  async findAll(organizationId: string): Promise<any[]> {
    const credentials = await this.credentialRepository.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });

    // Also surface LLM provider keys not yet linked to a credential
    const providers = await this.llmProviderRepository.find({
      where: { organizationId },
    });

    const results: any[] = credentials.map((cred) => this.maskCredential(cred));

    for (const provider of providers) {
      // Skip if already linked to a credential
      if (provider.credentialId) continue;
      // Skip if no API key stored inline
      if (!provider.configuration?.apiKey) continue;

      results.push({
        id: `llm-${provider.id}`,
        name: `${provider.name} API Key`,
        description: `Auto-detected from ${provider.name} (${provider.type})`,
        type: 'api_key',
        isActive: provider.status === 'active',
        lastUsedAt: provider.lastRequestAt,
        createdAt: provider.createdAt,
        organizationId,
        config: { apiKey: '***masked***' },
        usedBy: [{ type: 'llm_provider', id: provider.id, name: provider.name }],
        _source: 'llm_provider',
        _sourceId: provider.id,
      });
    }

    return results;
  }

  async findById(id: string, organizationId: string): Promise<Credential> {
    const credential = await this.credentialRepository.findOne({
      where: { id, organizationId },
    });

    if (!credential) {
      throw new NotFoundException('Credential not found');
    }

    return this.maskCredential(credential);
  }

  async create(
    data: {
      name: string;
      description?: string;
      type: string;
      config: Record<string, any>;
      keyName?: string;
      keyLocation?: string;
      apiId?: string;
      scopes?: string[];
      expiresAt?: string;
      metadata?: Record<string, any>;
      // Team-scoping fields sent by the dashboard's VisibilityField.
      // Both columns exist on the Credential entity; the service used
      // to silently drop them so every UI-created credential ended up
      // org-visible regardless of what the user picked.
      visibility?: 'org' | 'team';
      teamId?: string | null;
    },
    organizationId: string,
  ): Promise<Credential> {
    const credential = this.credentialRepository.create({
      name: data.name,
      description: data.description,
      type: data.type as any,
      config: data.config || {},
      keyName: data.keyName,
      keyLocation: data.keyLocation,
      apiId: data.apiId,
      organizationId,
      scopes: data.scopes,
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      metadata: data.metadata,
      visibility: data.visibility ?? 'org',
      teamId: data.visibility === 'team' ? (data.teamId ?? null) : null,
    });

    // Encrypt sensitive data before saving
    credential.encryptSensitiveData();

    const saved = await this.credentialRepository.save(credential);
    this.logger.log(`Credential created: ${saved.id} (${saved.name}) for org ${organizationId}`);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.CREDENTIAL_CREATE, resourceType: AuditResource.CREDENTIAL, resourceId: saved.id, resourceName: saved.name, details: { type: saved.type } });

    return this.maskCredential(saved);
  }

  async update(
    id: string,
    data: {
      name?: string;
      description?: string;
      type?: string;
      config?: Record<string, any>;
      keyName?: string;
      keyLocation?: string;
      apiId?: string;
      scopes?: string[];
      expiresAt?: string;
      isActive?: boolean;
      metadata?: Record<string, any>;
      // Team-scoping fields sent by the dashboard's VisibilityField.
      visibility?: 'org' | 'team';
      teamId?: string | null;
    },
    organizationId: string,
    userId?: string,
  ): Promise<Credential> {
    const credential = await this.credentialRepository.findOne({
      where: { id, organizationId },
    });

    if (!credential) {
      throw new NotFoundException('Credential not found');
    }

    // Authorization: org owner/admin always, team-scoped requires team lead.
    // userId may be undefined for legacy callers; skip the check in that
    // case so the migration doesn't break existing internal callers.
    if (userId) {
      const decision = await this.accessPolicy.canAccess({ id: userId }, credential, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }
    }
    if (data.name !== undefined) credential.name = data.name;
    if (data.description !== undefined) credential.description = data.description;
    if (data.type !== undefined) credential.type = data.type as any;
    if (data.keyName !== undefined) credential.keyName = data.keyName;
    if (data.keyLocation !== undefined) credential.keyLocation = data.keyLocation;
    if (data.apiId !== undefined) credential.apiId = data.apiId;
    if (data.scopes !== undefined) credential.scopes = data.scopes;
    if (data.expiresAt !== undefined) credential.expiresAt = data.expiresAt ? new Date(data.expiresAt) : null;
    if (data.isActive !== undefined) credential.isActive = data.isActive;
    if (data.metadata !== undefined) credential.metadata = data.metadata;
    if (data.visibility !== undefined) {
      credential.visibility = data.visibility;
      // Clear teamId when flipping back to 'org' so we don't leave a
      // dangling team reference on a now-org-wide credential.
      credential.teamId = data.visibility === 'team' ? (data.teamId ?? null) : null;
    } else if (data.teamId !== undefined && credential.visibility === 'team') {
      credential.teamId = data.teamId;
    }

    if (data.config !== undefined) {
      credential.config = data.config;
      credential.encryptSensitiveData();
    }

    const saved = await this.credentialRepository.save(credential);
    this.logger.log(`Credential updated: ${saved.id} (${saved.name})`);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.CREDENTIAL_UPDATE, resourceType: AuditResource.CREDENTIAL, resourceId: saved.id, resourceName: saved.name });

    return this.maskCredential(saved);
  }

  async delete(id: string, organizationId: string, userId?: string): Promise<void> {
    const credential = await this.credentialRepository.findOne({
      where: { id, organizationId },
    });

    if (!credential) {
      throw new NotFoundException('Credential not found');
    }

    // Authorization: org owner/admin always, team-scoped requires team lead.
    if (userId) {
      const decision = await this.accessPolicy.canAccess({ id: userId }, credential, 'manage');
      if (!decision.allowed) {
        throw new ForbiddenException(decision.reason);
      }
    }

    await this.credentialRepository.remove(credential);
    this.logger.log(`Credential deleted: ${id} (${credential.name})`);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.CREDENTIAL_DELETE, resourceType: AuditResource.CREDENTIAL, resourceId: id, resourceName: credential.name });
  }

  async getUsage(
    id: string,
    organizationId: string,
  ): Promise<{ llmProviders: any[]; apis: any[] }> {
    const credential = await this.credentialRepository.findOne({
      where: { id, organizationId },
    });

    if (!credential) {
      throw new NotFoundException('Credential not found');
    }

    // Find LLM providers using this credential
    const llmProviders = await this.llmProviderRepository.find({
      where: { credentialId: id, organizationId },
      select: ['id', 'name', 'type', 'status'],
    });

    // Find APIs that have credentials with this id
    const apis = await this.apiRepository.find({
      where: { organizationId },
      relations: ['credentials'],
    });

    const matchingApis = apis
      .filter((api) => api.credentials?.some((cred) => cred.id === id))
      .map((api) => ({ id: api.id, name: api.name, type: api.type }));

    return { llmProviders, apis: matchingApis };
  }

  // ──────────────────────────────────────────────
  // Inbound access keys
  // ──────────────────────────────────────────────

  async findAllAccessKeys(organizationId: string): Promise<any[]> {
    const keys = await this.apiKeyRepository.find({
      where: { organizationId },
      relations: ['gateway'],
      order: { createdAt: 'DESC' },
    });

    // Enrich with agent info where applicable
    const enriched = await batchAsync(keys, 5, async (key) => {
      let agent = null;
      if (key.agentId) {
        agent = await this.agentRepository.findOne({
          where: { id: key.agentId },
          select: ['id', 'name'],
        });
      }

      return {
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        isActive: key.isActive,
        scopes: key.scopes,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        rateLimits: key.rateLimits,
        createdAt: key.createdAt,
        gateway: key.gateway
          ? { id: key.gateway.id, name: key.gateway.name }
          : null,
        agent: agent ? { id: agent.id, name: agent.name } : null,
      };
    });

    return enriched;
  }

  async createAccessKey(
    data: {
      name: string;
      scopes?: string[];
      gatewayId?: string;
      agentId?: string;
      expiresAt?: string;
      rateLimits?: { requestsPerMinute?: number; requestsPerHour?: number; requestsPerDay?: number };
    },
    organizationId: string,
    userId: string,
  ): Promise<{ key: ApiKey; plainTextKey: string }> {
    if (!data.name) {
      throw new BadRequestException('Access key name is required');
    }

    // Generate a plain-text key: almyty_sk_ + 32 random hex chars
    const rawKey = `almyty_sk_${crypto.randomBytes(32).toString('hex')}`;
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 18); // "almyty_sk_" + first 8 hex chars

    const apiKey = this.apiKeyRepository.create({
      name: data.name,
      keyHash,
      keyPrefix,
      userId,
      organizationId,
      gatewayId: data.gatewayId || null,
      agentId: data.agentId || null,
      scopes: data.scopes || [],
      expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
      rateLimits: data.rateLimits || null,
      isActive: true,
    });

    const saved = await this.apiKeyRepository.save(apiKey);
    this.logger.log(`Access key created: ${saved.id} (${saved.name}) for org ${organizationId}`);

    return { key: saved, plainTextKey: rawKey };
  }

  async revokeAccessKey(id: string, organizationId: string): Promise<void> {
    const key = await this.apiKeyRepository.findOne({
      where: { id, organizationId },
    });

    if (!key) {
      throw new NotFoundException('Access key not found');
    }

    key.isActive = false;
    await this.apiKeyRepository.save(key);
    this.logger.log(`Access key revoked: ${id} (${key.name})`);
  }

  // ──────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────

  private maskCredential(credential: Credential): Credential {
    const sensitiveFields = [
      'password',
      'secret',
      'token',
      'key',
      'client_secret',
      'apiKey',
      'accessToken',
      'refreshToken',
      'headerValue',
      'clientSecret',
    ];

    if (credential.config && typeof credential.config === 'object') {
      const masked = { ...credential.config };
      for (const field of sensitiveFields) {
        if (masked[field]) {
          const val = String(masked[field]);
          if (val.length > 8) {
            masked[field] = val.substring(0, 4) + '****' + val.substring(val.length - 4);
          } else {
            masked[field] = '********';
          }
        }
      }
      credential.config = masked;
    }

    return credential;
  }
}
