import { LIMITS, softCapForTier, SoftCapBehavior, EMBEDDING_QUEUE_NAME } from './canonical.constants';
import { EmbeddingStatus } from './canonical.types';
import { scopeToOrganizationId } from './canonical-memory.service';
import { Injectable, Logger, BadRequestException, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { CanonicalMemory } from './canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from './canonical-memory-softcap-warning.entity';
import { ScopeType } from './canonical.types';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';
import { EmbeddingService } from '../embedding.service';
import { CanonicalMemoryService } from './canonical-memory.service';

@Injectable()
export class CanonicalMemoryOpsHelper {
  private readonly logger = new Logger(CanonicalMemoryOpsHelper.name);

  constructor(
    @InjectRepository(CanonicalMemory)
    private readonly repo: Repository<CanonicalMemory>,
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly configRepo: Repository<CanonicalMemoryWorkspaceConfig>,
    @InjectRepository(CanonicalMemorySoftcapWarning)
    private readonly warningRepo: Repository<CanonicalMemorySoftcapWarning>,
    @InjectQueue(EMBEDDING_QUEUE_NAME)
    private readonly embeddingQueue: Queue,
    private readonly auditLog: AuditLogService,
    private readonly embedding: EmbeddingService,
    @Inject(forwardRef(() => CanonicalMemoryService))
    private readonly service: CanonicalMemoryService,
  ) {}

  async enqueueEmbeddingFor(memoryId: string): Promise<void> {
    await this.embeddingQueue.add(
      'embed',
      { memory_id: memoryId },
      {
        jobId: `embed:${memoryId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }

  async fillEmbedding(memoryId: string): Promise<void> {
    const row = await this.repo.findOne({ where: { id: memoryId } });
    if (!row) {
      this.logger.warn(`fillEmbedding: memory ${memoryId} no longer exists`);
      return;
    }
    if (row.embeddingStatus === 'ready' || row.embeddingStatus === 'skipped') return;

    const orgId = scopeToOrganizationId(row.scopeType, row.scopeId);
    // Ensure the workspace config row exists (first write into a fresh
    // scope creates it). The recorded model below comes from the actual
    // embedding result, not the config's wish — the two can differ when
    // the org's provider set changes.
    await this.getOrCreateConfig(row.scopeType, row.scopeId);

    try {
      const result = await this.embedding.generateEmbedding(row.content, orgId);
      if (!result) {
        await this.repo.update(
          { id: memoryId },
          {
            embeddingStatus: 'failed' as EmbeddingStatus,
            embeddingError: 'embedding generation returned null',
          },
        );
        return;
      }
      // The DB column is `vector(EMBEDDING_DEFAULT_DIM)`. Normalise
      // truncate or zero-pad incoming vectors to that length so a
      // workspace using a different-dim embedder (e.g. mistral-embed's
      // 1024) still produces insertable rows. The recorded
      // `embedding_dim` reflects the raw model output so consumers know
      // what shape to expect on the read side, and `embedding_model`
      // records which model actually produced the vector — the vector
      // search only compares rows whose model matches the query
      // embedding's model, so mixed-model vectors are never silently
      // cosine-compared.
      const normalised = EmbeddingService.padToDim(result.vector, LIMITS.EMBEDDING_DEFAULT_DIM);
      await this.repo.update(
        { id: memoryId },
        {
          embedding: normalised,
          embeddingDim: result.dim,
          embeddingModel: result.model,
          embeddingStatus: 'ready' as EmbeddingStatus,
          embeddingError: null,
        },
      );
    } catch (e: any) {
      await this.repo.update(
        { id: memoryId },
        {
          embeddingStatus: 'failed' as EmbeddingStatus,
          embeddingError: e.message ?? String(e),
        },
      );
      throw e;
    }
  }

  // ────────────────────────────────────────────────────────────────────

  async getOrCreateConfig(
    scopeType: ScopeType,
    scopeId: string,
  ): Promise<CanonicalMemoryWorkspaceConfig> {
    const existing = await this.configRepo.findOne({ where: { scopeType, scopeId } });
    if (existing) return existing;
    const created = this.configRepo.create({
      scopeType,
      scopeId,
      embeddingModel: LIMITS.EMBEDDING_DEFAULT_MODEL,
      embeddingDim: LIMITS.EMBEDDING_DEFAULT_DIM,
      embeddingProvider: 'openai',
      softcapBehavior: LIMITS.SOFTCAP_BEHAVIOR_DEFAULT,
      overrides: {},
    });
    return this.configRepo.save(created);
  }

  /**
   * Update a workspace's canonical-memory config. Used by the
   * settings UI to wire backend routing, mirror, credential ids,
   * and softcap behavior. Only the fields the caller passes are
   * touched; `overrides` is shallow-merged so partial edits don't
   * wipe sibling keys (e.g. setting routing.memory_backend leaves
   * routing.credentials in place).
   *
   * Invalidates the credentials resolver's cache so a freshly
   * wired credential id is observed on the next dispatch without
   * waiting for the TTL.
   */
  async updateConfig(
    scopeType: ScopeType,
    scopeId: string,
    patch: {
      embedding_model?: string;
      embedding_dim?: number;
      embedding_provider?: string;
      softcap_behavior?: SoftCapBehavior;
      overrides?: Record<string, unknown>;
    },
    actor: { user_id?: string } = {},
  ): Promise<CanonicalMemoryWorkspaceConfig> {
    const cfg = await this.getOrCreateConfig(scopeType, scopeId);
    if (patch.embedding_model !== undefined) cfg.embeddingModel = patch.embedding_model;
    if (patch.embedding_dim !== undefined) cfg.embeddingDim = patch.embedding_dim;
    if (patch.embedding_provider !== undefined) cfg.embeddingProvider = patch.embedding_provider;
    if (patch.softcap_behavior !== undefined) cfg.softcapBehavior = patch.softcap_behavior;
    if (patch.overrides !== undefined) {
      cfg.overrides = { ...(cfg.overrides ?? {}), ...patch.overrides };
    }
    const saved = await this.configRepo.save(cfg);

    this.auditLog.log({
      organizationId: scopeId,
      userId: actor.user_id,
      action: AuditAction.MEMORY_UPDATE,
      resourceType: AuditResource.MEMORY,
      resourceId: '',
      details: {
        scope_type: scopeType,
        scope_id: scopeId,
        config_keys: Object.keys(patch),
      },
    });
    return saved;
  }

  /**
   * List recent soft-cap warning rows for a scope. Powers the audit
   * dashboard tab — lets operators see agents that consistently
   * over-write into a tier whose soft cap they keep tripping.
   */
  async listSoftcapWarnings(
    scopeType: ScopeType,
    scopeId: string,
    limit: number = 50,
  ): Promise<CanonicalMemorySoftcapWarning[]> {
    return this.warningRepo.find({
      where: { scopeType, scopeId },
      order: { at: 'DESC' },
      take: limit,
    });
  }
}
