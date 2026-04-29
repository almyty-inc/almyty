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
 * Mem0 backend. Talks to the public Mem0 API (https://api.mem0.ai)
 * over HTTPS with bearer-token auth. Mem0 is a vector-store memory
 * service that supports add / search / list / delete by user id.
 *
 * Capability story:
 *   ✓ vector_search, mode_memory, batch_writes
 *   ✗ bi_temporal, ttl, as_of_queries (Mem0 has no temporal model)
 *   ✗ document mode, fts, hybrid_search, change_feed, soft_delete
 *
 * Configuration:
 *   - MEM0_API_KEY (required)
 *   - MEM0_BASE_URL (defaults to https://api.mem0.ai)
 *
 * Scope mapping:
 *   The canonical (scope_type, scope_id) tuple becomes Mem0's
 *   `user_id` parameter as `${scope_type}:${scope_id}`. Mem0 has no
 *   nested scope concept beyond user, so we encode our scope into
 *   the user id and rely on Mem0's per-user isolation.
 *
 * Translation:
 *   - id: we keep our canonical UUID v7 in metadata.almyty_id; Mem0
 *     returns its own ids (we map back via metadata on read).
 *   - tags: forwarded as Mem0 metadata.tags
 *   - provenance: forwarded as metadata.provenance
 *   - tier / mode / etc.: forwarded as metadata so reads can rebuild
 *     the canonical shape.
 */
@Injectable()
export class Mem0Backend implements MemoryBackend {
  readonly id = 'mem0';
  readonly capabilities = new Set<Capability>([
    'mode_memory',
    'vector_search',
    'multi_tenant',
    'batch_writes',
    'export',
  ]);
  readonly supported_modes = new Set<Mode>(['memory']);

  private readonly logger = new Logger(Mem0Backend.name);
  private http: AxiosInstance | null = null;

  constructor(
    private readonly apiKey: string | undefined = process.env.MEM0_API_KEY,
    private readonly baseUrl: string = process.env.MEM0_BASE_URL || 'https://api.mem0.ai',
  ) {}

  async init(): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn('Mem0Backend has no MEM0_API_KEY — backend will fail health check');
      return;
    }
    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: { Authorization: `Token ${this.apiKey}` },
      timeout: 15_000,
      maxRedirects: 0,
    });
  }

  async healthCheck(): Promise<BackendHealth> {
    if (!this.http) return { ok: false, latency_ms: 0, details: { error: 'no_api_key' } };
    const start = Date.now();
    try {
      // Mem0's `/v1/ping/` is the lightest read; some deployments
      // expose `/v1/users/` which works too. We'll try ping and fall
      // back to a tiny list call.
      await this.http.get('/v1/ping/').catch(() => this.http!.get('/v1/memories/?limit=1'));
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        details: { status: e?.response?.status, error: e.message },
      };
    }
  }

  // ── CRUD ────────────────────────────────────────────────────

  async get(id: string): Promise<MemoryItem | null> {
    if (!this.http) throw new Error('Mem0Backend not initialised');
    try {
      const res = await this.http.get(`/v1/memories/${encodeURIComponent(id)}/`);
      return this.toCanonical(res.data);
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async put(item: MemoryItem): Promise<MemoryItem> {
    if (!this.http) throw new Error('Mem0Backend not initialised');
    const res = await this.http.post('/v1/memories/', this.fromCanonical(item));
    // Mem0 returns either the created memory or an array of one;
    // normalise both shapes.
    const created = Array.isArray(res.data) ? res.data[0] : res.data;
    return this.toCanonical({
      ...created,
      // Preserve the canonical id we sent so downstream lookups
      // remain stable. Mem0's `id` lives in metadata.mem0_id.
      metadata: { ...(created?.metadata || {}), mem0_id: created?.id, almyty_id: item.id },
    });
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft'): Promise<boolean> {
    if (!this.http) throw new Error('Mem0Backend not initialised');
    try {
      // Mem0's only delete is hard delete — soft-delete capability
      // isn't declared, so callers are warned upstream.
      await this.http.delete(`/v1/memories/${encodeURIComponent(id)}/`);
      return true;
    } catch (e: any) {
      if (e?.response?.status === 404) return false;
      throw e;
    }
  }

  async list(query: ListQuery): Promise<Page<MemoryItem>> {
    if (!this.http) throw new Error('Mem0Backend not initialised');
    const userId = scopeToUserId(query.scope);
    const res = await this.http.get('/v1/memories/', {
      params: { user_id: userId, limit: query.limit ?? 50 },
    });
    const rows = Array.isArray(res.data) ? res.data : res.data?.results ?? [];
    const items = rows.map((r: any) => this.toCanonical(r));
    return { items, total: items.length, cursor: null };
  }

  async search(query: SearchQuery): Promise<RankedItem[]> {
    if (!this.http) throw new Error('Mem0Backend not initialised');
    const userId = scopeToUserId(query.scope);
    const res = await this.http.post('/v1/memories/search/', {
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
    // Mem0 has no bi-temporal model. The router gates this op via
    // capabilities and never calls through, but defend the method.
    throw new Error('mem0 backend does not support bi_temporal supersede');
  }

  async asOf(): Promise<never> {
    throw new Error('mem0 backend does not support as_of_queries');
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
      id: meta.almyty_id ?? raw?.id ?? uuidv7(),
      mode: 'memory',
      scope_type: meta.scope_type ?? 'workspace',
      scope_id: meta.scope_id ?? 'unknown',
      content: typeof raw?.memory === 'string' ? raw.memory : String(raw?.text ?? raw?.content ?? ''),
      content_format: meta.content_format ?? 'text',
      content_bytes: Buffer.byteLength(
        typeof raw?.memory === 'string' ? raw.memory : String(raw?.text ?? raw?.content ?? ''),
        'utf8',
      ),
      embedding: null,
      embedding_dim: null,
      embedding_model: meta.embedding_model ?? null,
      embedding_status: 'skipped',
      embedding_error: null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      metadata: meta,
      file_refs: Array.isArray(meta.file_refs) ? meta.file_refs : [],
      tier: meta.tier ?? 'project',
      valid_from: raw?.created_at ? new Date(raw.created_at) : now,
      valid_until: null,
      superseded_by: null,
      ttl_seconds: null,
      source_uri: null,
      source_version: null,
      source_checksum: null,
      chunk_index: null,
      chunk_total: null,
      chunk_of: null,
      confidence: meta.confidence ?? 1,
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
          source_backend: 'mem0',
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
      messages: [{ role: 'user', content: item.content }],
      user_id: scopeToUserId({
        scope_type: item.scope_type,
        scope_id: item.scope_id,
      }),
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
}

function scopeToUserId(scope: ScopeRef): string {
  return `${scope.scope_type}:${scope.scope_id}`;
}
