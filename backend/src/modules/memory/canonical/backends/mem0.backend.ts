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
import {
  BackendCredentials,
  BackendHealth,
  MemoryBackend,
} from './memory-backend.interface';

/**
 * Mem0 backend. Talks to the Mem0 API (default https://api.mem0.ai)
 * over HTTPS with bearer-token auth. Credentials arrive per-call from
 * the router, which reads the org's Credential row — no process.env.
 *
 * Capability story:
 *   ✓ vector_search, mode_memory, batch_writes
 *   ✗ bi_temporal, ttl, as_of_queries (Mem0 has no temporal model)
 *   ✗ document mode, fts, hybrid_search, change_feed, soft_delete
 *
 * Scope mapping: canonical (scope_type, scope_id) → Mem0 `user_id`
 * as `${scope_type}:${scope_id}`. Each org's tenant isolation rides
 * on Mem0's per-user partitioning.
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
  /** Per-credential HTTP client cache, bounded so a churn of orgs
   *  doesn't leak a client per call. */
  private readonly clientCache = new Map<string, AxiosInstance>();
  private static readonly CLIENT_CACHE_MAX = 64;

  async init(): Promise<void> {
    // Construction is per-call now — nothing to warm up.
  }

  async healthCheck(creds?: BackendCredentials): Promise<BackendHealth> {
    const http = this.client(creds);
    if (!http) return { ok: false, latency_ms: 0, details: { error: 'no_credentials' } };
    const start = Date.now();
    try {
      await http.get('/v1/ping/').catch(() => http.get('/v1/memories/?limit=1'));
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        details: { status: e?.response?.status, error: e.message },
      };
    }
  }

  async get(id: string, creds?: BackendCredentials): Promise<MemoryItem | null> {
    const http = this.requireClient(creds);
    try {
      const res = await http.get(`/v1/memories/${encodeURIComponent(id)}/`);
      return this.toCanonical(res.data);
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async put(item: MemoryItem, creds?: BackendCredentials): Promise<MemoryItem> {
    const http = this.requireClient(creds);
    const res = await http.post('/v1/memories/', this.fromCanonical(item));
    const created = Array.isArray(res.data) ? res.data[0] : res.data;
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
    const http = this.requireClient(creds);
    try {
      await http.delete(`/v1/memories/${encodeURIComponent(id)}/`);
      return true;
    } catch (e: any) {
      if (e?.response?.status === 404) return false;
      throw e;
    }
  }

  async list(query: ListQuery, creds?: BackendCredentials): Promise<Page<MemoryItem>> {
    const http = this.requireClient(creds);
    const userId = scopeToUserId(query.scope);
    const res = await http.get('/v1/memories/', {
      params: { user_id: userId, limit: query.limit ?? 50 },
    });
    const rows = Array.isArray(res.data) ? res.data : res.data?.results ?? [];
    const items = rows.map((r: any) => this.toCanonical(r));
    return { items, total: items.length, cursor: null };
  }

  async search(query: SearchQuery, creds?: BackendCredentials): Promise<RankedItem[]> {
    const http = this.requireClient(creds);
    const userId = scopeToUserId(query.scope);
    const res = await http.post('/v1/memories/search/', {
      query: query.query,
      user_id: userId,
      limit: query.top_k ?? 10,
    });
    const rows = Array.isArray(res.data) ? res.data : res.data?.results ?? [];
    return rows.map((r: any) => ({
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
    const result: BatchResult = { succeeded: 0, failed: 0, errors: [] };
    for (const id of ids) {
      try {
        const ok = await this.delete(id, 'hard', creds);
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
    const content = typeof raw?.memory === 'string' ? raw.memory : String(raw?.text ?? raw?.content ?? '');
    return {
      id: meta.almyty_id ?? raw?.id ?? uuidv7(),
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
      valid_from: raw?.created_at ? new Date(raw.created_at) : now,
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
      created_at: raw?.created_at ? new Date(raw.created_at) : now,
      updated_at: raw?.updated_at ? new Date(raw.updated_at) : now,
      accessed_at: null, access_count: 0, deleted_at: null, deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return {
      messages: [{ role: 'user', content: item.content }],
      user_id: scopeToUserId({ scope_type: item.scope_type, scope_id: item.scope_id }),
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

  // ── HTTP client lifecycle ────────────────────────────────────

  private requireClient(creds?: BackendCredentials): AxiosInstance {
    const c = this.client(creds);
    if (!c) throw new Error('mem0: missing apiKey credential — set in the org credential store');
    return c;
  }

  private client(creds?: BackendCredentials): AxiosInstance | null {
    if (!creds?.apiKey) return null;
    const baseUrl = creds.baseUrl || 'https://api.mem0.ai';
    const cacheKey = `${baseUrl}|${creds.apiKey}`;
    const cached = this.clientCache.get(cacheKey);
    if (cached) return cached;
    const http = axios.create({
      baseURL: baseUrl,
      headers: { Authorization: `Token ${creds.apiKey}` },
      timeout: 15_000,
      maxRedirects: 0,
    });
    if (this.clientCache.size >= Mem0Backend.CLIENT_CACHE_MAX) {
      // drop oldest (Map preserves insertion order)
      const oldest = this.clientCache.keys().next().value;
      if (oldest !== undefined) this.clientCache.delete(oldest);
    }
    this.clientCache.set(cacheKey, http);
    return http;
  }
}

function scopeToUserId(scope: ScopeRef): string {
  return `${scope.scope_type}:${scope.scope_id}`;
}
