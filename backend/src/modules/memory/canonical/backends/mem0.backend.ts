import { Injectable, Logger } from '@nestjs/common';
import { MemoryClient, MemoryNotFoundError, type Memory } from 'mem0ai';
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
import {
  BackendCredentials,
  BackendHealth,
  MemoryBackend,
} from './memory-backend.interface';

/**
 * Mem0 backend, on the official `mem0ai` SDK. Credentials arrive
 * per-call from the router (which decrypts the org's Credential row);
 * we cache one MemoryClient per (host, apiKey) pair so we don't
 * reconstruct on every request.
 *
 * Capability story:
 *   ✓ vector_search, mode_memory, batch_writes
 *   ✗ bi_temporal, ttl, as_of_queries (Mem0 has no temporal model)
 *   ✗ document mode, fts, hybrid_search, change_feed, soft_delete
 *
 * Scope mapping: canonical (scope_type, scope_id) → Mem0 `userId`
 * as `${scope_type}:${scope_id}`.
 */
@Injectable()
export class Mem0Backend implements MemoryBackend {
  readonly id = 'mem0';
  readonly schema_version = 1;
  readonly capabilities = new Set<Capability>([
    'mode_memory',
    'vector_search',
    'multi_tenant',
    'batch_writes',
    'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory']);

  private readonly logger = new Logger(Mem0Backend.name);
  private readonly clientCache = new Map<string, MemoryClient>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {}

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const client = this.client(creds);
    if (!client) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await client.ping();
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
      const memory = await client.get(id);
      return this.toCanonical(memory);
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return null;
      throw e;
    }
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const client = this.requireClient(creds);
    const memories = await client.add(
      [{ role: 'user', content: item.content }],
      {
        userId: scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id }),
        metadata: {
          almyty_id: item.id,
          scope_type: item.scope_type,
          scope_id: item.scope_id,
          tier: item.tier,
          tags: item.tags,
          content_format: item.content_format,
          provenance: item.provenance,
          confidence: item.confidence,
        },
      },
    );
    const created = memories[0];
    return this.toCanonical({
      ...created,
      metadata: { ...(created?.metadata || {}), mem0_id: created?.id, almyty_id: item.id },
    });
  }

  async delete(
    id: string,
    _mode: 'soft' | 'hard' = 'soft',
    creds?: BackendCredentials,
  ): Promise<boolean> {
    const client = this.requireClient(creds);
    try {
      await client.delete(id);
      return true;
    } catch (e) {
      if (e instanceof MemoryNotFoundError) return false;
      throw e;
    }
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const client = this.requireClient(creds);
    const userId = scopeToUserId(query.scope);
    const page = await client.getAll({
      filters: { user_id: userId },
      pageSize: query.limit ?? 50,
    });
    const items = page.results.map((r) => this.toCanonical(r));
    return { items, total: page.count ?? items.length, cursor: page.next ?? null };
  }

  async search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]> {
    const client = this.requireClient(creds);
    const userId = scopeToUserId(query.scope);
    const res = await client.search(query.query, {
      filters: { user_id: userId },
      topK: query.top_k ?? 10,
    });
    return res.results.map((r) => ({
      item: this.toCanonical(r),
      score: typeof r.score === 'number' ? r.score : 0,
      signal: 'vector' as const,
    }));
  }

  async supersede(): Promise<never> {
    throw new Error('mem0 backend does not support bi_temporal supersede');
  }

  async asOf(): Promise<never> {
    throw new Error('mem0 backend does not support as_of_queries');
  }

  async batchPut(items: MemoryItem[], creds?: BackendCredentials): Promise<BatchResult> {
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    for (const item of items) {
      try {
        await this.put(item, creds);
        result.succeeded++;
      } catch (e: any) {
        result.failed++;
        result.errors.push({ id: item.id, error: { kind: 'backend_unavailable', backend: this.id, cause: e.message ?? String(e) } });
      }
    }
    return result;
  }

  async batchDelete(ids: string[], creds?: BackendCredentials): Promise<BatchResult> {
    const client = this.requireClient(creds);
    try {
      await client.batchDelete(ids);
      return { succeeded: ids.length, failed: 0, errors: [] };
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

  // ── translation ─────────────────────────────────────────────

  toCanonical(raw: any): MemoryItem {
    const m = raw as Memory;
    const meta = (m?.metadata ?? {}) as Record<string, any>;
    const now = new Date();
    const content =
      typeof m?.memory === 'string' ? m.memory :
      typeof m?.data?.memory === 'string' ? m.data.memory :
      String((raw as any)?.text ?? (raw as any)?.content ?? '');
    return {
      id: meta.almyty_id ?? m?.id ?? uuidv7(),
      mode: 'memory',
      scope_type: meta.scope_type ?? 'workspace',
      scope_id: meta.scope_id ?? 'unknown',
      content,
      content_format: meta.content_format ?? 'text',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null, embedding_dim: null, embedding_model: meta.embedding_model ?? null,
      embedding_status: 'skipped', embedding_error: null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: meta,
      file_refs: Array.isArray(meta.file_refs) ? meta.file_refs : [],
      tier: meta.tier ?? 'project',
      valid_from: m?.createdAt ? new Date(m.createdAt) : now,
      valid_until: null, superseded_by: null, ttl_seconds: null,
      source_uri: null, source_version: null, source_checksum: null,
      chunk_index: null, chunk_total: null, chunk_of: null,
      confidence: meta.confidence ?? 1,
      provenance:
        (meta.provenance as Provenance) ??
        ({
          agent_id: null, session_id: null, collab_id: null,
          model: null, provider: null, tool_chain: [],
          created_by: 'sync', source_backend: 'mem0',
        } as Provenance),
      created_at: m?.createdAt ? new Date(m.createdAt) : now,
      updated_at: m?.updatedAt ? new Date(m.updatedAt) : now,
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return {
      messages: [{ role: 'user', content: item.content }],
      userId: scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id }),
      metadata: {
        almyty_id: item.id,
        scope_type: item.scope_type,
        scope_id: item.scope_id,
        tier: item.tier,
        tags: item.tags,
        content_format: item.content_format,
        provenance: item.provenance,
        confidence: item.confidence,
      },
    };
  }

  // ── client lifecycle ────────────────────────────────────────

  private requireClient(creds?: BackendCredentials): MemoryClient {
    const c = this.client(creds);
    if (!c) throw new Error('mem0: missing apiKey credential — set in the org credential store');
    return c;
  }

  private client(creds?: BackendCredentials): MemoryClient | null {
    if (!creds?.apiKey) return null;
    const host = creds.baseUrl || 'https://api.mem0.ai';
    const cacheKey = `${host}|${creds.apiKey}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;
    const client = new MemoryClient({ apiKey: creds.apiKey, host });
    if (this.clientCache.size >= Mem0Backend.CLIENT_CACHE_MAX) {
      const oldest = this.clientCache.keys().next().value;
      if (oldest !== undefined) this.clientCache.delete(oldest);
    }
    this.clientCache.set(cacheKey, client);
    return client;
  }
}

function scopeToUserId(scope: ScopeRef): string {
  return `${scope.scope_type}:${scope.scope_id}`;
}
