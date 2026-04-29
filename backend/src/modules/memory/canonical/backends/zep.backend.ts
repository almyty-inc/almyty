import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
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
import { BackendHealth, MemoryBackend } from './memory-backend.interface';

/**
 * Zep backend. Talks to Zep Cloud (https://api.getzep.com) over
 * HTTPS. Zep models memory as session-scoped with knowledge-graph
 * entities; we use the Sessions + Memory + KG nodes API.
 *
 * Capability story:
 *   ✓ vector_search, mode_memory, batch_writes, multi_tenant
 *   ✓ graph_search (Zep is graph-first)
 *   ✓ bi_temporal — Zep tracks ingestion + valid_at timestamps
 *     so we map our valid_from / valid_until onto Zep's `valid_at`
 *     and filter superseded rows by deletion.
 *   ✗ ttl, fts (Zep does its own retrieval), as_of_queries beyond
 *     `valid_at` start (no `as_of` walk-back), document mode v1.
 *
 * Configuration:
 *   - ZEP_API_KEY (required)
 *   - ZEP_BASE_URL (defaults to https://api.getzep.com)
 *
 * Scope mapping:
 *   Canonical (scope_type, scope_id) → Zep `user_id`. Sessions are
 *   created lazily per (scope, agent_id) so each conversation gets
 *   its own session.
 */
@Injectable()
export class ZepBackend implements MemoryBackend {
  readonly id = 'zep';
  readonly capabilities = new Set<Capability>([
    'mode_memory',
    'vector_search',
    'graph_search',
    'bi_temporal',
    'multi_tenant',
    'batch_writes',
    'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory']);

  private readonly logger = new Logger(ZepBackend.name);
  private http: AxiosInstance | null = null;

  constructor(
    private readonly apiKey: string | undefined = process.env.ZEP_API_KEY,
    private readonly baseUrl: string = process.env.ZEP_BASE_URL || 'https://api.getzep.com',
  ) {}

  async init(): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn('ZepBackend has no ZEP_API_KEY — backend will fail health check');
      return;
    }
    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: { Authorization: `Api-Key ${this.apiKey}` },
      timeout: 15_000,
      maxRedirects: 0,
    });
  }

  async healthCheck(): Promise<BackendHealth> {
    if (!this.http) return { ok: false, latency_ms: 0, details: { error: 'no_api_key' } };
    const start = Date.now();
    try {
      // List a single user — cheapest read.
      await this.http.get('/api/v2/users-ordered', { params: { pageSize: 1 } }).catch(() =>
        this.http!.get('/api/v2/users', { params: { limit: 1 } }),
      );
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latency_ms: Date.now() - start, details: { status: e?.response?.status, error: e.message } };
    }
  }

  // ── CRUD ────────────────────────────────────────────────────

  async get(id: string): Promise<MemoryItem | null> {
    if (!this.http) throw new Error('ZepBackend not initialised');
    try {
      // Zep doesn't expose a single-memory endpoint; the closest
      // analogue is fetching a graph node by its UUID.
      const res = await this.http.get(`/api/v2/graph/node/${encodeURIComponent(id)}`);
      return this.toCanonical(res.data);
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async put(item: MemoryItem): Promise<MemoryItem> {
    if (!this.http) throw new Error('ZepBackend not initialised');
    const userId = scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id });

    // Make sure the user exists. Zep returns 200 even on duplicate
    // if `if_not_exists` semantics are honoured by the API.
    await this.ensureUser(userId);

    // Add to the user's graph as a fact node — Zep ingests it into
    // the long-term memory with embedding + entity extraction.
    await this.http.post('/api/v2/graph', {
      data: item.content,
      type: 'message',
      user_id: userId,
    });
    return item;
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft'): Promise<boolean> {
    if (!this.http) throw new Error('ZepBackend not initialised');
    try {
      await this.http.delete(`/api/v2/graph/node/${encodeURIComponent(id)}`);
      return true;
    } catch (e: any) {
      if (e?.response?.status === 404) return false;
      throw e;
    }
  }

  async list(query: ListQuery): Promise<Page<MemoryItem>> {
    if (!this.http) throw new Error('ZepBackend not initialised');
    const userId = scopeToUserId(query.scope);
    const res = await this.http.get(`/api/v2/users/${encodeURIComponent(userId)}/facts`, {
      params: { limit: query.limit ?? 50 },
    }).catch(() =>
      // Fallback to the graph nodes endpoint where /facts isn't enabled.
      this.http!.get(`/api/v2/graph/nodes`, { params: { user_id: userId, limit: query.limit ?? 50 } }),
    );
    const rows = (res.data?.facts ?? res.data?.nodes ?? res.data?.results ?? []) as any[];
    const items = rows.map((r) => this.toCanonical(r));
    return { items, total: items.length, cursor: null };
  }

  async search(query: SearchQuery): Promise<RankedItem[]> {
    if (!this.http) throw new Error('ZepBackend not initialised');
    const userId = scopeToUserId(query.scope);
    const res = await this.http.post('/api/v2/graph/search', {
      query: query.query,
      user_id: userId,
      limit: query.top_k ?? 10,
      scope: 'edges',
    });
    const rows = (res.data?.edges ?? res.data?.results ?? []) as any[];
    return rows.map((r) => ({
      item: this.toCanonical(r),
      score: typeof r.score === 'number' ? r.score : 0,
      signal: 'vector' as const,
    }));
  }

  async supersede(
    oldId: string,
    newItem: MemoryItem,
  ): Promise<{ old: MemoryItem; new: MemoryItem }> {
    if (!this.http) throw new Error('ZepBackend not initialised');
    // Zep's `valid_at` model: write the new fact, expire the old.
    const old = await this.get(oldId);
    if (!old) {
      throw new Error(`zep: cannot supersede missing ${oldId}`);
    }
    await this.put(newItem);
    await this.delete(oldId, 'hard');
    return {
      old: { ...old, valid_until: new Date(), superseded_by: newItem.id },
      new: newItem,
    };
  }

  async asOf(): Promise<never> {
    throw new Error('zep backend does not support as_of_queries beyond ingestion time');
  }

  async batchPut(items: MemoryItem[]): Promise<BatchResult> {
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    for (const item of items) {
      try {
        await this.put(item);
        result.succeeded++;
      } catch (e: any) {
        result.failed++;
        result.errors.push({ id: item.id, error: { kind: 'backend_unavailable', backend: this.id, cause: e.message ?? String(e) } });
      }
    }
    return result;
  }

  async batchDelete(ids: string[]): Promise<BatchResult> {
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        const ok = await this.delete(id, 'hard');
        if (ok) result.succeeded++;
        else result.failed++;
      } catch (e: any) {
        result.failed++;
        result.errors.push({ id, error: { kind: 'backend_unavailable', backend: this.id, cause: e.message ?? String(e) } });
      }
    }
    return result;
  }

  // ── translation ─────────────────────────────────────────────

  toCanonical(raw: any): MemoryItem {
    const meta = raw?.metadata ?? {};
    const now = new Date();
    return {
      id: meta.almyty_id ?? raw?.uuid ?? raw?.id ?? uuidv7(),
      mode: 'memory',
      scope_type: meta.scope_type ?? 'workspace',
      scope_id: meta.scope_id ?? raw?.user_id ?? 'unknown',
      content: String(raw?.fact ?? raw?.summary ?? raw?.message ?? raw?.content ?? ''),
      content_format: 'text',
      content_bytes: Buffer.byteLength(
        String(raw?.fact ?? raw?.summary ?? raw?.message ?? raw?.content ?? ''),
        'utf8',
      ),
      embedding: null,
      embedding_dim: null,
      embedding_model: null,
      embedding_status: 'skipped',
      embedding_error: null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: meta,
      file_refs: [],
      tier: meta.tier ?? 'long',
      valid_from: raw?.valid_at ? new Date(raw.valid_at) : raw?.created_at ? new Date(raw.created_at) : now,
      valid_until: raw?.expired_at ? new Date(raw.expired_at) : null,
      superseded_by: null,
      ttl_seconds: null,
      source_uri: null,
      source_version: null,
      source_checksum: null,
      chunk_index: null,
      chunk_total: null,
      chunk_of: null,
      confidence: typeof raw?.score === 'number' ? raw.score : 1,
      provenance:
        (meta.provenance as Provenance) ??
        ({
          agent_id: null,
          session_id: null,
          collab_id: null,
          model: null,
          provider: null,
          tool_chain: [],
          created_by: 'sync',
          source_backend: 'zep',
        } as Provenance),
      created_at: raw?.created_at ? new Date(raw.created_at) : now,
      updated_at: raw?.updated_at ? new Date(raw.updated_at) : now,
      accessed_at: null,
      access_count: 0,
      deleted_at: null,
      deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return {
      data: item.content,
      type: 'message',
      user_id: scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id }),
      metadata: {
        almyty_id: item.id,
        scope_type: item.scope_type,
        scope_id: item.scope_id,
        tier: item.tier,
        tags: item.tags,
        provenance: item.provenance,
      },
    };
  }

  // ── helpers ─────────────────────────────────────────────────

  private async ensureUser(userId: string): Promise<void> {
    try {
      await this.http!.post('/api/v2/users', { user_id: userId });
    } catch (e: any) {
      // Already exists is fine.
      if (e?.response?.status !== 409 && e?.response?.status !== 400) throw e;
    }
  }
}

function scopeToUserId(scope: ScopeRef): string {
  return `${scope.scope_type}_${scope.scope_id}`;
}
