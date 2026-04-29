import { Injectable, Logger } from '@nestjs/common';
import Supermemory, { NotFoundError } from 'supermemory';
import { v7 as uuidv7 } from 'uuid';

import {
  BatchResult,
  Capability,
  ListQuery,
  MemoryItem,
  Mode,
  Page,
  Provenance,
  RankedItem,
  ScopeRef,
  SearchQuery,
} from '../canonical.types';
import { BackendCredentials, BackendHealth, MemoryBackend } from './memory-backend.interface';

/**
 * Supermemory backend, on the official `supermemory` SDK. Per-call
 * credentials. Documents land via `client.documents.add` (auto-chunked
 * by the platform) and memories surface via `client.search.memories`
 * for low-latency retrieval. Listing uses `client.documents.list`
 * filtered on the canonical scope's containerTag.
 *
 * Capability story:
 *   ✓ vector_search, fts, hybrid_search, mode_memory, mode_document,
 *     batch_writes, multi_tenant
 *   ✗ bi_temporal, ttl, as_of_queries, change_feed, soft_delete
 */
@Injectable()
export class SupermemoryBackend implements MemoryBackend {
  readonly id = 'supermemory';
  readonly schema_version = 1;
  readonly capabilities = new Set<Capability>([
    'mode_memory', 'mode_document', 'vector_search', 'fts',
    'hybrid_search', 'multi_tenant', 'batch_writes', 'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory', 'document']);
  private readonly logger = new Logger(SupermemoryBackend.name);
  private readonly clientCache = new Map<string, Supermemory>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {}

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const client = this.client(creds);
    if (!client) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await client.documents.list({ limit: 1 });
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        details: { error: e?.message ?? String(e) },
      };
    }
  }

  async get(id: string, creds?: BackendCredentials): Promise<MemoryItem | null> {
    const client = this.requireClient(creds);
    try {
      const doc = await client.documents.get(id);
      return this.toCanonical(doc);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const client = this.requireClient(creds);
    const tag = scopeToTag({ scope_type: item.scope_type, scope_id: item.scope_id });
    const res = await client.documents.add({
      content: item.content,
      containerTag: tag,
      customId: item.id,
      metadata: this.flattenMetadata(item),
    });
    return this.toCanonical({
      ...res,
      content: item.content,
      metadata: { almyty_id: item.id, supermemory_id: res.id, ...this.flattenMetadata(item) },
    });
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft', creds?: BackendCredentials): Promise<boolean> {
    const client = this.requireClient(creds);
    try {
      await client.documents.delete(id);
      return true;
    } catch (e) {
      if (e instanceof NotFoundError) return false;
      throw e;
    }
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const client = this.requireClient(creds);
    const tag = scopeToTag(query.scope);
    const res = await client.documents.list({
      filters: { OR: [{ key: 'containerTag', value: tag }] },
      limit: query.limit ?? 50,
      includeContent: true,
    });
    const items = res.memories.map((r) => this.toCanonical(r));
    return {
      items,
      total: res.pagination?.totalItems ?? items.length,
      cursor: null,
    };
  }

  async search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]> {
    const client = this.requireClient(creds);
    const tag = scopeToTag(query.scope);
    const res = await client.search.memories({
      q: query.query,
      containerTag: tag,
      limit: query.top_k ?? 10,
    });
    return res.results.map((r) => ({
      item: this.toCanonical({
        id: r.id,
        content: r.memory ?? r.chunk ?? '',
        metadata: r.metadata ?? {},
        updatedAt: r.updatedAt,
      }),
      score: typeof r.similarity === 'number' ? r.similarity : 0,
      signal: 'hybrid' as const,
    }));
  }

  async supersede(): Promise<never> {
    throw new Error('supermemory backend does not support bi_temporal supersede');
  }

  async asOf(): Promise<never> {
    throw new Error('supermemory backend does not support as_of_queries');
  }

  async batchPut(items: MemoryItem[], creds?: BackendCredentials): Promise<BatchResult> {
    const client = this.requireClient(creds);
    if (items.length === 0) return { succeeded: 0, failed: 0, errors: [] };
    try {
      const res = await client.documents.batchAdd({
        documents: items.map((item) => ({
          content: item.content,
          containerTag: scopeToTag({ scope_type: item.scope_type, scope_id: item.scope_id }),
          customId: item.id,
          metadata: this.flattenMetadata(item),
        })),
      });
      const errors = res.results
        .map((r, i) => (r.error ? {
          id: items[i]?.id ?? r.id ?? '',
          error: { kind: 'backend_unavailable' as const, backend: this.id, cause: r.error ?? 'unknown' },
        } : null))
        .filter((e): e is NonNullable<typeof e> => e !== null);
      return {
        succeeded: res.success,
        failed: res.failed,
        errors,
      };
    } catch (e: any) {
      return {
        succeeded: 0,
        failed: items.length,
        errors: items.map((item) => ({
          id: item.id,
          error: { kind: 'backend_unavailable', backend: this.id, cause: e.message ?? String(e) },
        })),
      };
    }
  }

  async batchDelete(ids: string[], creds?: BackendCredentials): Promise<BatchResult> {
    const client = this.requireClient(creds);
    if (ids.length === 0) return { succeeded: 0, failed: 0, errors: [] };
    try {
      const res = await client.documents.deleteBulk({ ids });
      return {
        succeeded: (res as any).deleted ?? ids.length,
        failed: 0,
        errors: [],
      };
    } catch (e: any) {
      return {
        succeeded: 0,
        failed: ids.length,
        errors: ids.map((id) => ({
          id,
          error: { kind: 'backend_unavailable', backend: this.id, cause: e.message ?? String(e) },
        })),
      };
    }
  }

  toCanonical(raw: any): MemoryItem {
    const meta = (raw?.metadata ?? {}) as Record<string, any>;
    const now = new Date();
    const content = String(raw?.content ?? raw?.memory ?? raw?.summary ?? '');
    const isDoc = !!meta.source_uri;
    return {
      id: meta.almyty_id ?? raw?.customId ?? raw?.id ?? uuidv7(),
      mode: isDoc ? 'document' : 'memory',
      scope_type: meta.scope_type ?? 'workspace',
      scope_id: meta.scope_id ?? 'unknown',
      content,
      content_format: meta.content_format ?? 'text',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: meta.embedding_model ?? null,
      embedding_status: 'skipped', embedding_error: null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: meta, file_refs: [],
      tier: isDoc ? null : (meta.tier ?? 'project'),
      valid_from: isDoc ? null : (raw?.createdAt ? new Date(raw.createdAt) : now),
      valid_until: null, superseded_by: null, ttl_seconds: null,
      source_uri: meta.source_uri ?? null,
      source_version: meta.source_version ?? (isDoc ? 1 : null),
      source_checksum: meta.source_checksum ?? null,
      chunk_index: meta.chunk_index ?? null,
      chunk_total: meta.chunk_total ?? null,
      chunk_of: meta.chunk_of ?? null,
      confidence: typeof raw?.similarity === 'number' ? raw.similarity : 1,
      provenance: (meta.provenance as Provenance) ?? ({
        agent_id: null, session_id: null, collab_id: null,
        model: null, provider: null, tool_chain: [],
        created_by: 'sync', source_backend: 'supermemory',
      } as Provenance),
      created_at: raw?.createdAt ? new Date(raw.createdAt) : now,
      updated_at: raw?.updatedAt ? new Date(raw.updatedAt) : now,
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return {
      content: item.content,
      containerTag: scopeToTag({ scope_type: item.scope_type, scope_id: item.scope_id }),
      customId: item.id,
      metadata: this.flattenMetadata(item),
    };
  }

  /**
   * Supermemory's metadata is `Record<string, string | number | boolean | string[]>`,
   * no nested objects. Flatten by JSON-stringifying the structured fields.
   */
  private flattenMetadata(item: MemoryItem): Record<string, string | number | boolean | string[]> {
    return {
      almyty_id: item.id,
      scope_type: item.scope_type,
      scope_id: item.scope_id,
      tier: item.tier ?? '',
      tags: item.tags,
      content_format: item.content_format,
      provenance_json: JSON.stringify(item.provenance),
      confidence: item.confidence,
      source_uri: item.source_uri ?? '',
      source_version: item.source_version ?? 0,
    };
  }

  private requireClient(creds?: BackendCredentials): Supermemory {
    const c = this.client(creds);
    if (!c) throw new Error('supermemory: missing apiKey credential — set in the org credential store');
    return c;
  }

  private client(creds?: BackendCredentials): Supermemory | null {
    if (!creds?.apiKey) return null;
    const baseURL = creds.baseUrl || 'https://api.supermemory.ai';
    const cacheKey = `${baseURL}|${creds.apiKey}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;
    const client = new Supermemory({ apiKey: creds.apiKey, baseURL });
    if (this.clientCache.size >= SupermemoryBackend.CLIENT_CACHE_MAX) {
      const oldest = this.clientCache.keys().next().value;
      if (oldest !== undefined) this.clientCache.delete(oldest);
    }
    this.clientCache.set(cacheKey, client);
    return client;
  }
}

function scopeToTag(scope: ScopeRef): string {
  return `${scope.scope_type}_${scope.scope_id}`;
}
