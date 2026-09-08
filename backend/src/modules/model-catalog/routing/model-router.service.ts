import { Injectable, Logger, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Model } from '../../../entities/model.entity';
import { ModelDeployment } from '../../../entities/model-deployment.entity';
import { LlmProvider, LlmProviderStatus, LlmProviderType } from '../../../entities/llm-provider.entity';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { RouteCandidate, RoutingPolicy, selectCandidates } from './model-router';

/** What a run records about the card that answered, and the ones it walked past. */
export interface RouteAttribution {
  modelId: string;
  modelVersionId: string | null;
  vendorModelId: string;
  providerId: string | null;
  rationale: string;
  /** 1-based position of the answering candidate in the plan. */
  attempt: number;
  /** Candidates tried before this one, with why each was skipped. */
  tried: Array<{ modelId: string; reason: string }>;
  /** Cards the policy filtered out before any call was made. */
  rejected: Array<{ modelId: string; reason: string }>;
}

export interface ResolvedCandidate extends RouteCandidate {
  card: Model;
  /** A stored provider row (secrets included) or a transient one built from the card's endpoint. */
  provider: LlmProvider;
}

export interface RoutePlan {
  candidates: ResolvedCandidate[];
  rejected: Array<{ modelId: string; reason: string }>;
}

export class NoRouteError extends Error {
  readonly code = 'NO_ROUTE';
  constructor(readonly rejected: Array<{ modelId: string; reason: string }>) {
    super(
      rejected.length === 0
        ? 'No models are registered for this organization'
        : `No registered model satisfies the routing policy (${rejected.length} rejected)`,
    );
    this.name = 'NoRouteError';
  }
}

/**
 * Turns an org's catalog plus a policy into an ordered list of callable
 * providers. Selection itself is pure (model-router.ts); this service adds
 * the data access, provider resolution and the audit trail.
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  constructor(
    @InjectRepository(Model) private readonly models: Repository<Model>,
    @InjectRepository(LlmProvider) private readonly providers: Repository<LlmProvider>,
    @InjectRepository(ModelDeployment) private readonly deployments: Repository<ModelDeployment>,
    @Optional() private readonly auditLog?: AuditLogService,
  ) {}

  async plan(organizationId: string, policy: RoutingPolicy = {}): Promise<RoutePlan> {
    const cards = await this.models.find({ where: { organizationId }, order: { createdAt: 'ASC' } });
    const { candidates, rejected } = selectCandidates(cards, policy);
    const resolved: ResolvedCandidate[] = [];
    for (const c of candidates) {
      const card = cards.find((k) => k.id === c.modelId)!;
      const provider = await this.providerFor(card);
      if (!provider) {
        rejected.push({ modelId: card.id, reason: 'no callable provider' });
        continue;
      }
      if (!provider.isHealthy || provider.status !== LlmProviderStatus.ACTIVE) {
        rejected.push({ modelId: card.id, reason: `provider ${provider.name} is ${provider.isHealthy ? provider.status : 'unhealthy'}` });
        continue;
      }
      resolved.push({ ...c, card, provider });
    }
    return { candidates: resolved, rejected };
  }

  /**
   * The provider a card is called through. A stored provider row wins; a
   * card that only has an endpoint (a deployment we made) gets a transient
   * custom provider pointed at that URL, with the deployment's token as
   * bearer when there is one.
   */
  async providerFor(card: Model): Promise<LlmProvider | null> {
    if (card.providerId) {
      return this.providers.findOne({ where: { id: card.providerId, organizationId: card.organizationId } });
    }
    const url = card.endpointRef?.url;
    if (!url) return null;
    let apiKey: string | undefined;
    if (card.endpointRef?.deploymentId) {
      const deployment = await this.deployments.findOne({ where: { id: card.endpointRef.deploymentId, organizationId: card.organizationId } });
      if (deployment) {
        const config = deployment.getDecryptedProviderConfig();
        const secret = Object.keys(config).find((k) => ModelDeployment.isSecretKey(k) && typeof config[k] === 'string');
        apiKey = secret ? config[secret] : undefined;
      }
    }
    return Object.assign(new LlmProvider(), {
      id: `endpoint:${card.id}`,
      organizationId: card.organizationId,
      name: card.name,
      type: LlmProviderType.CUSTOM,
      status: LlmProviderStatus.ACTIVE,
      isHealthy: true,
      configuration: { baseUrl: url, model: card.vendorModelId, ...(apiKey ? { apiKey } : {}) },
      capabilities: {},
      metadata: {},
    });
  }

  /** Fire-and-forget audit row: which card answered and why. */
  recordRoute(organizationId: string, attribution: RouteAttribution, context?: { userId?: string; conversationId?: string }): void {
    if (!this.auditLog) return;
    void this.auditLog
      .log({
        organizationId,
        userId: context?.userId,
        action: AuditAction.MODEL_ROUTED,
        resourceType: AuditResource.MODEL,
        resourceId: attribution.modelId,
        resourceName: attribution.vendorModelId,
        details: {
          modelVersionId: attribution.modelVersionId,
          providerId: attribution.providerId,
          rationale: attribution.rationale,
          attempt: attribution.attempt,
          tried: attribution.tried,
          rejected: attribution.rejected.length,
          conversationId: context?.conversationId,
        },
      })
      .catch((err) => this.logger.warn(`route audit failed: ${err?.message ?? err}`));
  }
}
