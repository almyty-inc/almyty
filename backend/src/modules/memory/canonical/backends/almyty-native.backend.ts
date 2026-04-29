import { Injectable } from '@nestjs/common';

import { CanonicalMemoryService } from '../canonical-memory.service';
import {
  BatchResult,
  Capability,
  ListQuery,
  MemoryItem,
  Mode,
  Page,
  RankedItem,
  ScopeRef,
  SearchQuery,
} from '../canonical.types';
import { BackendHealth, MemoryBackend } from './memory-backend.interface';

/**
 * Almyty Native backend — the default. Wraps `CanonicalMemoryService`
 * (which owns the validation pipeline, soft caps, embedding queue,
 * and audit log) so the router can treat it like any other adapter.
 *
 * Native is the only backend that supports every capability in v1:
 *   bi_temporal, ttl, soft_delete, as_of_queries, transactional_writes,
 *   vector_search, fts, hybrid_search, mode_memory, mode_document,
 *   shared_scope, multi_tenant, batch_writes, export.
 */
@Injectable()
export class AlmytyNativeBackend implements MemoryBackend {
  readonly id = 'almyty-native';
  readonly capabilities = new Set<Capability>([
    'mode_memory',
    'mode_document',
    'vector_search',
    'fts',
    'hybrid_search',
    'bi_temporal',
    'ttl',
    'soft_delete',
    'as_of_queries',
    'transactional_writes',
    'shared_scope',
    'multi_tenant',
    'batch_writes',
    'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory', 'document']);

  constructor(private readonly service: CanonicalMemoryService) {}

  async init(): Promise<void> {
    // CanonicalMemoryService is a NestJS singleton — no extra setup
    // beyond what the module's TypeOrm + BullMQ wiring already does.
  }

  async healthCheck(): Promise<BackendHealth> {
    const start = Date.now();
    // Trivial round-trip through the workspace_config table — proves
    // the DB is reachable and the canonical schema is in place.
    try {
      await this.service.getOrCreateConfig('workspace', '__healthcheck__');
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        details: { error: e.message ?? String(e) },
      };
    }
  }

  get(id: string): Promise<MemoryItem | null> {
    return this.service.get(id);
  }

  /**
   * `put` accepts a canonical MemoryItem (already-built shape — used
   * by the router on transfer). The HTTP / MCP path goes through
   * `CanonicalMemoryService.put(input, actor)` instead so the full
   * 17-step validation pipeline runs. This entrypoint trusts the
   * caller (the router validates the canonical shape itself before
   * forwarding).
   */
  async put(item: MemoryItem): Promise<MemoryItem> {
    return this.service.putCanonical(item);
  }

  delete(id: string, mode: 'soft' | 'hard' = 'soft'): Promise<boolean> {
    return this.service.delete(id, mode, {});
  }

  list(query: ListQuery): Promise<Page<MemoryItem>> {
    return this.service.list(query);
  }

  search(query: SearchQuery): Promise<RankedItem[]> {
    return this.service.search(query);
  }

  async supersede(
    oldId: string,
    newItem: MemoryItem,
  ): Promise<{ old: MemoryItem; new: MemoryItem }> {
    return this.service.supersedeCanonical(oldId, newItem);
  }

  asOf(time: Date, query: ListQuery): Promise<Page<MemoryItem>> {
    return this.service.asOf(time, query);
  }

  batchPut(items: MemoryItem[]): Promise<BatchResult> {
    return this.service.batchPut(items);
  }

  batchDelete(ids: string[]): Promise<BatchResult> {
    return this.service.batchDelete(ids);
  }

  // Native backend's wire format IS canonical — translation is a no-op.
  toCanonical(raw: unknown): MemoryItem {
    return raw as MemoryItem;
  }
  fromCanonical(item: MemoryItem): unknown {
    return item;
  }

  // No streaming change feed in v1.
  subscribeChanges?(_scope: ScopeRef, _since: Date) {
    return undefined as any;
  }
}
