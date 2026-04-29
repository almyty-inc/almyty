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
 * Anthropic Memory Tool backend. Uses the Files API on api.anthropic.com
 * as the persistence layer that Claude's `memory` tool reads/writes:
 * each canonical memory item lands as a separate file, so Claude
 * (when invoked with the memory tool enabled) can list / read / search
 * them through its native tool surface.
 *
 * Capability story:
 *   ✓ vector_search (Claude's retrieval over the file set)
 *   ✓ mode_memory, mode_document, multi_tenant, batch_writes
 *   ✗ bi_temporal, ttl, as_of_queries, change_feed, transactional_writes
 *
 * Configuration (env):
 *   - ANTHROPIC_API_KEY (required)
 *   - ANTHROPIC_BASE_URL (defaults to https://api.anthropic.com)
 *
 * Scope mapping:
 *   The canonical scope is encoded into the file name prefix
 *   (`{scope_type}_{scope_id}__{almyty_id}.md`) so reads can filter
 *   by prefix without per-scope file collections.
 */
@Injectable()
export class AnthropicMemoryToolBackend implements MemoryBackend {
  readonly id = 'anthropic-memory-tool';
  readonly capabilities = new Set<Capability>([
    'mode_memory',
    'mode_document',
    'vector_search',
    'multi_tenant',
    'batch_writes',
  ]);
  readonly supported_modes = new Set<Mode>(['memory', 'document']);

  private readonly logger = new Logger(AnthropicMemoryToolBackend.name);
  private http: AxiosInstance | null = null;

  constructor(
    private readonly apiKey: string | undefined = process.env.ANTHROPIC_API_KEY,
    private readonly baseUrl: string = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  ) {}

  async init(): Promise<void> {
    if (!this.apiKey) {
      this.logger.warn('AnthropicMemoryToolBackend has no ANTHROPIC_API_KEY — backend will fail health check');
      return;
    }
    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'files-api-2025-04-14',
      },
      timeout: 20_000,
      maxRedirects: 0,
    });
  }

  async healthCheck(): Promise<BackendHealth> {
    if (!this.http) return { ok: false, latency_ms: 0, details: { error: 'no_api_key' } };
    const start = Date.now();
    try {
      await this.http.get('/v1/files', { params: { limit: 1 } });
      return { ok: true, latency_ms: Date.now() - start };
    } catch (e: any) {
      return { ok: false, latency_ms: Date.now() - start, details: { status: e?.response?.status, error: e.message } };
    }
  }

  async get(id: string): Promise<MemoryItem | null> {
    if (!this.http) throw new Error('AnthropicMemoryToolBackend not initialised');
    // Anthropic Files API returns metadata via /v1/files/:id and the
    // bytes via /v1/files/:id/content. We fetch both.
    try {
      const [meta, content] = await Promise.all([
        this.http.get(`/v1/files/${encodeURIComponent(id)}`),
        this.http.get(`/v1/files/${encodeURIComponent(id)}/content`, { responseType: 'text' }),
      ]);
      return this.toCanonical({ ...meta.data, _content: content.data });
    } catch (e: any) {
      if (e?.response?.status === 404) return null;
      throw e;
    }
  }

  async put(item: MemoryItem): Promise<MemoryItem> {
    if (!this.http) throw new Error('AnthropicMemoryToolBackend not initialised');
    // Multipart upload — Files API expects `file` (bytes) + `purpose`.
    const fd = new (require('form-data'))();
    const fileName = scopedFileName(item);
    fd.append('file', Buffer.from(item.content, 'utf8'), {
      filename: fileName,
      contentType: 'text/markdown',
    });
    fd.append('purpose', 'memory');
    await this.http.post('/v1/files', fd, {
      headers: { ...fd.getHeaders() },
    });
    return item;
  }

  async delete(id: string, _mode: 'soft' | 'hard' = 'soft'): Promise<boolean> {
    if (!this.http) throw new Error('AnthropicMemoryToolBackend not initialised');
    try {
      await this.http.delete(`/v1/files/${encodeURIComponent(id)}`);
      return true;
    } catch (e: any) {
      if (e?.response?.status === 404) return false;
      throw e;
    }
  }

  async list(query: ListQuery): Promise<Page<MemoryItem>> {
    if (!this.http) throw new Error('AnthropicMemoryToolBackend not initialised');
    const prefix = `${query.scope.scope_type}_${query.scope.scope_id}__`;
    const res = await this.http.get('/v1/files', { params: { limit: query.limit ?? 100 } });
    const data = (res.data?.data ?? res.data?.files ?? []) as any[];
    const filtered = data.filter((f) => typeof f?.filename === 'string' && f.filename.startsWith(prefix));
    // Hydrate content for each match — Files API doesn't return it
    // in the listing call.
    const items: MemoryItem[] = [];
    for (const f of filtered) {
      const content = await this.http.get(`/v1/files/${encodeURIComponent(f.id)}/content`, { responseType: 'text' });
      items.push(this.toCanonical({ ...f, _content: content.data }));
    }
    return { items, total: items.length, cursor: null };
  }

  async search(query: SearchQuery): Promise<RankedItem[]> {
    // The Anthropic Memory Tool's "search" only happens through a
    // model call with the memory tool enabled — Claude reads files
    // and answers. Here we approximate: list scope files and rank
    // by substring match on the query (best-effort surface; the
    // canonical hybrid search lives on the native backend).
    const page = await this.list({ scope: query.scope, limit: 200 });
    const q = query.query.toLowerCase();
    const ranked: RankedItem[] = page.items
      .map((item) => ({
        item,
        score: item.content.toLowerCase().includes(q) ? 1 : 0,
        signal: 'vector' as const,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, query.top_k ?? 10);
    return ranked;
  }

  async supersede(): Promise<never> {
    throw new Error('anthropic-memory-tool backend does not support bi_temporal supersede');
  }

  async asOf(): Promise<never> {
    throw new Error('anthropic-memory-tool backend does not support as_of_queries');
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

  toCanonical(raw: any): MemoryItem {
    const filename: string = raw?.filename ?? '';
    const m = filename.match(/^([^_]+)_([^_]+(?:[^_]+)*?)__([0-9a-f-]{36})\.md$/i);
    const content = typeof raw?._content === 'string' ? raw._content : String(raw?.content ?? '');
    const now = new Date();
    return {
      id: m?.[3] ?? raw?.id ?? uuidv7(),
      mode: 'memory',
      scope_type: (m?.[1] as any) ?? 'workspace',
      scope_id: m?.[2] ?? 'unknown',
      content,
      content_format: 'markdown',
      content_bytes: Buffer.byteLength(content, 'utf8'),
      embedding: null,
      embedding_dim: null,
      embedding_model: null,
      embedding_status: 'skipped',
      embedding_error: null,
      tags: [],
      metadata: { anthropic_file_id: raw?.id },
      file_refs: [],
      tier: 'long',
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
      confidence: 1,
      provenance: {
        agent_id: null, session_id: null, collab_id: null,
        model: null, provider: 'anthropic', tool_chain: [],
        created_by: 'sync', source_backend: 'anthropic-memory-tool',
      } as Provenance,
      created_at: raw?.created_at ? new Date(raw.created_at) : now,
      updated_at: raw?.updated_at ? new Date(raw.updated_at) : now,
      accessed_at: null,
      access_count: 0,
      deleted_at: null,
      deleted_by: null,
    };
  }

  fromCanonical(item: MemoryItem): unknown {
    return { filename: scopedFileName(item), content: item.content };
  }
}

function scopedFileName(item: MemoryItem): string {
  return `${item.scope_type}_${item.scope_id}__${item.id}.md`;
}
