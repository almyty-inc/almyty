import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { AlmytyNativeBackend } from './backends/almyty-native.backend';
import { AnthropicMemoryToolBackend } from './backends/anthropic-memory-tool.backend';
import { Mem0Backend } from './backends/mem0.backend';
import { ZepBackend } from './backends/zep.backend';
import { SupermemoryBackend } from './backends/supermemory.backend';
import { VertexMemoryBankBackend } from './backends/vertex-memory-bank.backend';
import {
  BackendCredentials,
  BackendRoutingConfig,
  MemoryBackend,
  TransferReport,
  TransferWarning,
} from './backends/memory-backend.interface';
import { BackendCredentialsResolver } from './backend-credentials.resolver';
import {
  CANONICAL_SCHEMA_VERSION,
  Capability,
  ListQuery,
  MemoryError,
  MemoryItem,
  Mode,
  ScopeRef,
  SearchQuery,
} from './canonical.types';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

/**
 * MemoryRouter — picks a backend per (scope, mode) and gates ops by
 * declared capability.
 *
 * Routing rules (highest priority first):
 *
 *   1. The workspace_config row's `overrides.routing` field, if set,
 *      points the scope at a specific backend per mode.
 *   2. Default: Almyty Native for both memory and document modes.
 *
 * Capability gating: when the resolved backend doesn't declare a
 * capability the requested op needs (e.g. supersede on Mem0), the
 * router throws `MemoryError({kind:'unsupported_capability'})` so
 * the caller can either fall back to native or surface a UX error.
 *
 * Mirror writes (overrides.routing.mirror_backend): every successful
 * `put` on the primary fires a best-effort `put` on the mirror. The
 * mirror's failures are logged but never bubble to the caller —
 * mirrors are observability, not durability.
 */
@Injectable()
export class MemoryRouter implements OnModuleInit {
  private readonly logger = new Logger(MemoryRouter.name);
  private readonly backends = new Map<string, MemoryBackend>();

  constructor(
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly configRepo: Repository<CanonicalMemoryWorkspaceConfig>,
    private readonly auditLog: AuditLogService,
    private readonly credsResolver: BackendCredentialsResolver,
    // The backends below are NestJS providers — they self-init on
    // module bootstrap. The router holds references and dispatches
    // by id at runtime.
    private readonly native: AlmytyNativeBackend,
    private readonly anthropic: AnthropicMemoryToolBackend,
    private readonly mem0: Mem0Backend,
    private readonly zep: ZepBackend,
    private readonly supermemory: SupermemoryBackend,
    private readonly vertex: VertexMemoryBankBackend,
  ) {
    for (const b of [native, anthropic, mem0, zep, supermemory, vertex]) {
      this.backends.set(b.id, b);
    }
  }

  async onModuleInit(): Promise<void> {
    // Spec §15: refuse to mount any backend declaring a schema
    // version older than CANONICAL_SCHEMA_VERSION. The adapter's
    // toCanonical/fromCanonical wouldn't know how to round-trip
    // fields the new schema added; routing to it would silently
    // corrupt data. Drop the bad ones from the registry — they
    // never appear in list_backends, never get selected, never
    // get a credential resolved.
    for (const b of Array.from(this.backends.values())) {
      if (b.schema_version < CANONICAL_SCHEMA_VERSION) {
        this.logger.warn(
          `dropping backend ${b.id}: declares schema_version=${b.schema_version}, current is ${CANONICAL_SCHEMA_VERSION}`,
        );
        this.backends.delete(b.id);
      }
    }

    await Promise.all(
      Array.from(this.backends.values()).map((b) =>
        b.init().catch((e) => this.logger.warn(`backend ${b.id} init failed: ${e.message}`)),
      ),
    );
  }

  // ── selection ───────────────────────────────────────────────

  list_backends(): Array<{ id: string; capabilities: Capability[]; modes: Mode[] }> {
    return Array.from(this.backends.values()).map((b) => ({
      id: b.id,
      capabilities: Array.from(b.capabilities),
      modes: Array.from(b.supported_modes),
    }));
  }

  async healthAll(scope?: ScopeRef): Promise<Record<string, { ok: boolean; latency_ms: number }>> {
    const result: Record<string, { ok: boolean; latency_ms: number }> = {};
    await Promise.all(
      Array.from(this.backends.values()).map(async (b) => {
        const creds = scope ? await this.credsResolver.resolve(scope, b.id) : undefined;
        const h = await b.healthCheck(creds ?? undefined).catch((e) => ({
          ok: false, latency_ms: 0, details: { error: e.message },
        }));
        result[b.id] = { ok: h.ok, latency_ms: h.latency_ms };
      }),
    );
    return result;
  }

  /**
   * Resolve the backend for `(scope, mode)`. Falls back to native
   * when the scope has no override OR the chosen backend doesn't
   * support the requested mode.
   */
  async resolve(scope: ScopeRef, mode: Mode): Promise<MemoryBackend> {
    const cfg = await this.configRepo.findOne({
      where: { scopeType: scope.scope_type, scopeId: scope.scope_id },
    });
    const routing: BackendRoutingConfig =
      ((cfg?.overrides as any)?.routing as BackendRoutingConfig) ?? {};
    const wantedId = mode === 'memory' ? routing.memory_backend : routing.document_backend;
    if (wantedId) {
      const b = this.backends.get(wantedId);
      if (b && b.supported_modes.has(mode)) return b;
      this.logger.warn(
        `scope ${scope.scope_type}:${scope.scope_id} requested ${wantedId} but backend missing/unsupports ${mode}; falling back to native`,
      );
    }
    return this.native;
  }

  /**
   * Optional mirror — best-effort secondary backend. Returns null
   * when no mirror is configured for the scope.
   */
  private async mirror(scope: ScopeRef): Promise<MemoryBackend | null> {
    const cfg = await this.configRepo.findOne({
      where: { scopeType: scope.scope_type, scopeId: scope.scope_id },
    });
    const routing: BackendRoutingConfig =
      ((cfg?.overrides as any)?.routing as BackendRoutingConfig) ?? {};
    if (!routing.mirror_backend) return null;
    return this.backends.get(routing.mirror_backend) ?? null;
  }

  private require(b: MemoryBackend, cap: Capability): void {
    if (!b.capabilities.has(cap)) {
      throw new MemoryError({ kind: 'unsupported_capability', backend: b.id, capability: cap });
    }
  }

  // ── routed operations ───────────────────────────────────────

  async put(item: MemoryItem): Promise<MemoryItem> {
    const scope: ScopeRef = { scope_type: item.scope_type, scope_id: item.scope_id };
    const primary = await this.resolve(scope, item.mode);
    if (!primary.supported_modes.has(item.mode)) {
      throw new MemoryError({ kind: 'unsupported_capability', backend: primary.id, capability: item.mode === 'memory' ? 'mode_memory' : 'mode_document' });
    }
    const creds = await this.credsResolver.resolve(scope, primary.id);
    const result = await primary.put(item, creds ?? undefined);
    const mir = await this.mirror(scope);
    if (mir && mir.supported_modes.has(item.mode)) {
      const mirCreds = await this.credsResolver.resolve(scope, mir.id);
      mir.put(item, mirCreds ?? undefined).catch((e) => this.logger.warn(`mirror ${mir.id} put failed for ${item.id}: ${e.message}`));
    }
    return result;
  }

  async get(scope: ScopeRef, mode: Mode, id: string): Promise<MemoryItem | null> {
    const b = await this.resolve(scope, mode);
    const creds = await this.credsResolver.resolve(scope, b.id);
    return b.get(id, creds ?? undefined);
  }

  async list(query: ListQuery): Promise<ReturnType<MemoryBackend['list']>> {
    const mode = query.mode ?? 'memory';
    const b = await this.resolve(query.scope, mode);
    const creds = await this.credsResolver.resolve(query.scope, b.id);
    return b.list(query, creds ?? undefined);
  }

  async search(query: SearchQuery): Promise<ReturnType<MemoryBackend['search']>> {
    const mode = query.mode ?? 'memory';
    const b = await this.resolve(query.scope, mode);
    this.require(b, 'vector_search');
    const creds = await this.credsResolver.resolve(query.scope, b.id);
    return b.search(query, creds ?? undefined);
  }

  async delete(scope: ScopeRef, mode: Mode, id: string, deleteMode: 'soft' | 'hard' = 'soft'): Promise<boolean> {
    const b = await this.resolve(scope, mode);
    if (deleteMode === 'soft') this.require(b, 'soft_delete');
    const creds = await this.credsResolver.resolve(scope, b.id);
    return b.delete(id, deleteMode, creds ?? undefined);
  }

  async supersede(
    scope: ScopeRef,
    oldId: string,
    newItem: MemoryItem,
  ): ReturnType<MemoryBackend['supersede']> {
    const b = await this.resolve(scope, 'memory');
    this.require(b, 'bi_temporal');
    const creds = await this.credsResolver.resolve(scope, b.id);
    return b.supersede(oldId, newItem, creds ?? undefined);
  }

  async asOf(scope: ScopeRef, time: Date, query: ListQuery): ReturnType<MemoryBackend['asOf']> {
    const b = await this.resolve(scope, query.mode ?? 'memory');
    this.require(b, 'as_of_queries');
    const creds = await this.credsResolver.resolve(scope, b.id);
    return b.asOf(time, query, creds ?? undefined);
  }

  // ── transfer ────────────────────────────────────────────────

  /**
   * Move items from one backend to another for a given scope.
   * Computes capability deltas first so the caller knows what
   * fields will be lost (bi-temporal history when targeting Mem0,
   * etc.) and returns a per-row result. The transfer is NOT
   * transactional across backends — each row is independent.
   */
  async transfer(
    scope: ScopeRef,
    sourceId: string,
    targetId: string,
    options: { dry_run?: boolean; mode?: Mode } = {},
  ): Promise<TransferReport> {
    const source = this.backends.get(sourceId);
    const target = this.backends.get(targetId);
    if (!source) throw new Error(`unknown source backend: ${sourceId}`);
    if (!target) throw new Error(`unknown target backend: ${targetId}`);
    const mode = options.mode ?? 'memory';

    const sourceCreds = await this.credsResolver.resolve(scope, source.id);
    const targetCreds = await this.credsResolver.resolve(scope, target.id);

    const all: MemoryItem[] = [];
    let cursor: string | null = null;
    while (true) {
      const page = await source.list({ scope, mode, limit: 100, cursor }, sourceCreds ?? undefined);
      all.push(...page.items);
      if (!page.cursor) break;
      cursor = page.cursor;
      if (all.length > 100_000) {
        this.logger.warn(`transfer ${sourceId}→${targetId} exceeded 100k items; truncating`);
        break;
      }
    }

    // Compute capability-degradation warnings.
    const warnings = computeTransferWarnings(source, target, all);

    const report: TransferReport = {
      source: sourceId,
      target: targetId,
      scope,
      total_source: all.length,
      succeeded: 0,
      failed: 0,
      warnings,
      errors: [],
    };

    if (options.dry_run) return report;

    // Stream the items into the target. We use batchPut so backends
    // that bulk under the hood (Mem0 does) get the chance.
    const bp = await target.batchPut(all, targetCreds ?? undefined);
    report.succeeded = bp.succeeded;
    report.failed = bp.failed;
    for (const e of bp.errors) {
      report.errors.push({ id: e.id, error: JSON.stringify(e.error) });
    }

    this.auditLog.log({
      organizationId: scope.scope_id,
      action: AuditAction.MEMORY_TRANSFER,
      resourceType: AuditResource.MEMORY,
      resourceId: '',
      details: {
        source: sourceId,
        target: targetId,
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        total: report.total_source,
        succeeded: report.succeeded,
        failed: report.failed,
        warnings: report.warnings,
      },
    });
    return report;
  }
}

/**
 * For each capability the source has and the target lacks, count
 * how many items in the batch would lose information on transfer.
 * Surfaces those counts so operators can decide whether the cost
 * of a one-way migration is acceptable.
 */
function computeTransferWarnings(
  source: MemoryBackend,
  target: MemoryBackend,
  items: MemoryItem[],
): TransferWarning[] {
  const warnings: TransferWarning[] = [];
  const lost: Array<{ cap: Capability; field: keyof MemoryItem; pred: (i: MemoryItem) => boolean }> = [
    { cap: 'bi_temporal', field: 'valid_until', pred: (i) => i.valid_until !== null },
    { cap: 'bi_temporal', field: 'superseded_by', pred: (i) => i.superseded_by !== null },
    { cap: 'ttl', field: 'ttl_seconds', pred: (i) => i.ttl_seconds !== null },
    { cap: 'soft_delete', field: 'deleted_at', pred: (i) => i.deleted_at !== null },
    { cap: 'mode_document', field: 'source_uri', pred: (i) => i.source_uri !== null },
  ];
  for (const { cap, field, pred } of lost) {
    if (source.capabilities.has(cap) && !target.capabilities.has(cap)) {
      const count = items.filter(pred).length;
      if (count > 0) warnings.push({ capability: cap, field, count });
    }
  }
  return warnings;
}
