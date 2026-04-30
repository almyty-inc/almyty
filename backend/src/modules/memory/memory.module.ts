import { Module, OnApplicationBootstrap, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule, InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

import { Organization } from '../../entities/organization.entity';
import { LlmProvider } from '../../entities/llm-provider.entity';
import { Credential } from '../../entities/credential.entity';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { CredentialsModule } from '../credentials/credentials.module';

import { EmbeddingService } from './embedding.service';

import { CanonicalMemory } from './canonical/canonical-memory.entity';
import { CanonicalMemoryWorkspaceConfig } from './canonical/canonical-memory-config.entity';
import { CanonicalMemorySoftcapWarning } from './canonical/canonical-memory-softcap-warning.entity';
import {
  CanonicalMemoryService,
  EMBEDDING_QUEUE_NAME,
} from './canonical/canonical-memory.service';
import { CanonicalSearchHelper } from './canonical/canonical-search.helper';
import { CanonicalMemoryOpsHelper } from './canonical/canonical-ops.helper';
import { CanonicalMemoryController } from './canonical/canonical-memory.controller';
import { CanonicalMemoryEmbeddingProcessor } from './canonical/embedding-worker.processor';
import {
  CanonicalMemoryTtlSweeperProcessor,
  TTL_SWEEPER_QUEUE_NAME,
} from './canonical/ttl-sweeper.processor';
import {
  CanonicalMemoryConsolidationProcessor,
  CONSOLIDATION_QUEUE_NAME,
} from './canonical/consolidation.processor';
import { ConsolidationService } from './canonical/consolidation.service';
import {
  CanonicalMemorySyncProcessor,
  SYNC_QUEUE_NAME,
} from './canonical/memory-sync.processor';
import { MemorySyncService } from './canonical/memory-sync.service';
import { AlmytyNativeBackend } from './canonical/backends/almyty-native.backend';
import { AnthropicMemoryToolBackend } from './canonical/backends/anthropic-memory-tool.backend';
import { Mem0Backend } from './canonical/backends/mem0.backend';
import { ZepBackend } from './canonical/backends/zep.backend';
import { SupermemoryBackend } from './canonical/backends/supermemory.backend';
import { VertexMemoryBankBackend } from './canonical/backends/vertex-memory-bank.backend';
import { MemoryRouter } from './canonical/memory-router.service';
import { BackendCredentialsResolver } from './canonical/backend-credentials.resolver';
import { DocumentChunkerService } from './canonical/document-chunker.service';

/**
 * Memory module.
 *
 * Houses the canonical-schema-v1 implementation. The legacy
 * `MemoryService` / `MemoryController` / `Memory` entity have been
 * removed (see canonical-schema spec §13: greenfield). Callers
 * outside this module use `CanonicalMemoryService`.
 *
 * Background jobs:
 *   - canonical-memory-embedding (per-write async embedding)
 *   - canonical-memory-ttl-sweeper (every 60s — flips valid_until on
 *     memory-mode rows whose TTL has expired, per spec §7.5)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CanonicalMemory,
      CanonicalMemoryWorkspaceConfig,
      CanonicalMemorySoftcapWarning,
      Organization,
      LlmProvider,
      Credential,
    ]),
    BullModule.registerQueue(
      { name: EMBEDDING_QUEUE_NAME },
      { name: TTL_SWEEPER_QUEUE_NAME },
      { name: CONSOLIDATION_QUEUE_NAME },
      { name: SYNC_QUEUE_NAME },
    ),
    forwardRef(() => LlmProvidersModule),
    forwardRef(() => CredentialsModule),
  ],
  providers: [
    EmbeddingService,
    CanonicalMemoryService,
    CanonicalSearchHelper,
    CanonicalMemoryOpsHelper,
    CanonicalMemoryEmbeddingProcessor,
    CanonicalMemoryTtlSweeperProcessor,
    CanonicalMemoryConsolidationProcessor,
    ConsolidationService,
    CanonicalMemorySyncProcessor,
    MemorySyncService,
    AlmytyNativeBackend,
    AnthropicMemoryToolBackend,
    Mem0Backend,
    ZepBackend,
    SupermemoryBackend,
    VertexMemoryBankBackend,
    MemoryRouter,
    BackendCredentialsResolver,
    DocumentChunkerService,
  ],
  controllers: [CanonicalMemoryController],
  exports: [CanonicalMemoryService, EmbeddingService, MemoryRouter, DocumentChunkerService],
})
export class MemoryModule implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(TTL_SWEEPER_QUEUE_NAME) private readonly ttlQueue: Queue,
    @InjectQueue(CONSOLIDATION_QUEUE_NAME) private readonly consolidationQueue: Queue,
    @InjectQueue(SYNC_QUEUE_NAME) private readonly syncQueue: Queue,
  ) {}

  /**
   * Schedule the TTL sweeper + consolidation passes as repeating
   * BullMQ jobs. Idempotent — BullMQ deduplicates repeatable jobs
   * by their key (queue + name + cron), so module reloads
   * (HMR / blue-green deploys / autoscaling) don't pile up
   * duplicate schedules.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.ttlQueue.add(
      'sweep',
      {},
      {
        repeat: { every: 60_000 },
        jobId: 'canonical-memory-ttl-sweeper:repeat',
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
    // Consolidation runs hourly across every workspace that has it
    // enabled. The hourly cadence balances LLM cost against staleness;
    // a workspace can also trigger a manual run via
    // POST /memory/canonical/consolidate.
    await this.consolidationQueue.add(
      'consolidate-all',
      {},
      {
        repeat: { every: 60 * 60 * 1000 },
        jobId: 'canonical-memory-consolidation:repeat',
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
    // Sync runs every 5 minutes for any scope that has a
    // mirror_backend wired up. The router still does a fire-and-
    // forget mirror put on every successful primary write, but
    // that path drops on transient failures; this scheduled
    // reconcile is the eventual-consistency guarantee.
    await this.syncQueue.add(
      'sync-all',
      {},
      {
        repeat: { every: 5 * 60 * 1000 },
        jobId: 'canonical-memory-sync:repeat',
        removeOnComplete: 50,
        removeOnFail: 50,
      },
    );
  }
}
