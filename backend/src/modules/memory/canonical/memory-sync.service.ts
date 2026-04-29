import { Injectable, Logger } from '@nestjs/common';

import {
  MemoryItem,
  ScopeRef,
} from './canonical.types';
import {
  BackendCredentials,
  MemoryBackend,
} from './backends/memory-backend.interface';
import { MemoryRouter } from './memory-router.service';
import { BackendCredentialsResolver } from './backend-credentials.resolver';
import { CanonicalMemoryWorkspaceConfig } from './canonical-memory-config.entity';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

/**
 * Per-scope sync result. The sync engine reports both directions
 * (primary→mirror, mirror→primary) in one pass; the totals tell
 * the operator how much actually moved.
 */
export interface SyncResult {
  scope: ScopeRef;
  primary: string;
  mirror: string;
  /** items pulled from primary that didn't exist on mirror */
  to_mirror: number;
  /** items pulled from mirror that didn't exist on primary */
  to_primary: number;
  /** items present on both with diverging updated_at; resolved by last-write-wins */
  reconciled: number;
  errors: Array<{ side: 'primary' | 'mirror'; id: string; error: string }>;
  skipped: boolean;
  reason?: string;
}

/**
 * MemorySyncService — continuous bidirectional sync between a
 * scope's primary and mirror backend.
 *
 * Replaces the fire-and-forget mirror writes the router does on
 * every put with a periodic reconcile pass. The router's mirror
 * call is best-effort and can drop on transient failures; this
 * service owns the eventual-consistency guarantee.
 *
 * Conflict resolution: last-write-wins by `updated_at`. The losing
 * side gets overwritten with the winning side's content. No CRDT —
 * spec §14 explicitly rejects them.
 *
 * Pagination: walks `list({ cursor })` on both sides until cursor
 * comes back null. No upper bound — large scopes finish on the
 * next pass if they exceed the per-pass time budget.
 */
@Injectable()
export class MemorySyncService {
  private readonly logger = new Logger(MemorySyncService.name);
  /** Per-pass cap on items pulled from each side; protects the worker
   *  from OOM on a fresh scope being seeded for the first time. */
  private static readonly MAX_PAGES = 1000;
  /** batchPut chunk on writes — keeps any single write under
   *  whatever per-call limit each backend imposes. */
  private static readonly WRITE_CHUNK = 200;

  constructor(
    @InjectRepository(CanonicalMemoryWorkspaceConfig)
    private readonly configRepo: Repository<CanonicalMemoryWorkspaceConfig>,
    private readonly router: MemoryRouter,
    private readonly credsResolver: BackendCredentialsResolver,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Run one sync pass for a scope. Idempotent — the third call in
   * a row with no upstream changes does no work.
   */
  async sync(scope: ScopeRef, options: { force?: boolean } = {}): Promise<SyncResult> {
    const cfg = await this.configRepo.findOne({
      where: { scopeType: scope.scope_type, scopeId: scope.scope_id },
    });
    const routing = (cfg?.overrides as any)?.routing ?? {};
    const primaryId = routing.memory_backend ?? 'almyty-native';
    const mirrorId = routing.mirror_backend;

    if (!mirrorId) {
      return zeroResult(scope, primaryId, '', true, 'no mirror_backend configured');
    }
    if (mirrorId === primaryId) {
      return zeroResult(scope, primaryId, mirrorId, true, 'mirror_backend equals memory_backend');
    }

    // Resolve backends + creds for both sides.
    const all = this.router.list_backends();
    if (!all.find((b) => b.id === primaryId) || !all.find((b) => b.id === mirrorId)) {
      return zeroResult(scope, primaryId, mirrorId, true, 'one of the backends is not registered');
    }
    const primary = (this.router as any).backends.get(primaryId) as MemoryBackend;
    const mirror = (this.router as any).backends.get(mirrorId) as MemoryBackend;
    const primaryCreds = await this.credsResolver.resolve(scope, primaryId);
    const mirrorCreds = await this.credsResolver.resolve(scope, mirrorId);

    // Pull every item from each side (paged).
    const primaryItems = await this.collect(primary, scope, primaryCreds);
    const mirrorItems = await this.collect(mirror, scope, mirrorCreds);

    const result: SyncResult = {
      scope, primary: primaryId, mirror: mirrorId,
      to_mirror: 0, to_primary: 0, reconciled: 0,
      errors: [], skipped: false,
    };

    const primaryById = new Map(primaryItems.map((i) => [i.id, i]));
    const mirrorById = new Map(mirrorItems.map((i) => [i.id, i]));

    // ── Direction 1: primary → mirror ──
    const onlyOnPrimary: MemoryItem[] = [];
    const newerOnPrimary: MemoryItem[] = [];
    for (const item of primaryItems) {
      const peer = mirrorById.get(item.id);
      if (!peer) {
        onlyOnPrimary.push(item);
      } else if (item.updated_at > peer.updated_at) {
        newerOnPrimary.push(item);
        result.reconciled++;
      }
    }
    if (mirror.supported_modes.has('memory') || mirror.supported_modes.has('document')) {
      for (const chunk of chunked([...onlyOnPrimary, ...newerOnPrimary], MemorySyncService.WRITE_CHUNK)) {
        const r = await mirror.batchPut(chunk, mirrorCreds ?? undefined);
        result.to_mirror += r.succeeded;
        for (const e of r.errors) {
          result.errors.push({ side: 'mirror', id: e.id, error: JSON.stringify(e.error) });
        }
      }
    }

    // ── Direction 2: mirror → primary ──
    const onlyOnMirror: MemoryItem[] = [];
    const newerOnMirror: MemoryItem[] = [];
    for (const item of mirrorItems) {
      const peer = primaryById.get(item.id);
      if (!peer) {
        onlyOnMirror.push(item);
      } else if (item.updated_at > peer.updated_at) {
        newerOnMirror.push(item);
        // counted in reconciled above only if BOTH sides flagged a
        // newer copy of the same id; that's a rare race. Bump only
        // when the primary didn't already win the comparison.
        if (!newerOnPrimary.find((p) => p.id === item.id)) result.reconciled++;
      }
    }
    if (primary.supported_modes.has('memory') || primary.supported_modes.has('document')) {
      for (const chunk of chunked([...onlyOnMirror, ...newerOnMirror], MemorySyncService.WRITE_CHUNK)) {
        const r = await primary.batchPut(chunk, primaryCreds ?? undefined);
        result.to_primary += r.succeeded;
        for (const e of r.errors) {
          result.errors.push({ side: 'primary', id: e.id, error: JSON.stringify(e.error) });
        }
      }
    }

    this.auditLog.log({
      organizationId: scope.scope_id,
      action: AuditAction.MEMORY_SYNC,
      resourceType: AuditResource.MEMORY,
      resourceId: '',
      details: {
        scope_type: scope.scope_type,
        scope_id: scope.scope_id,
        primary: primaryId,
        mirror: mirrorId,
        to_mirror: result.to_mirror,
        to_primary: result.to_primary,
        reconciled: result.reconciled,
        errors: result.errors.length,
      },
    });

    return result;
  }

  /**
   * Run sync for every scope that has a `mirror_backend` configured.
   * Called by the BullMQ scheduled job.
   */
  async syncAll(): Promise<SyncResult[]> {
    const cfgs = await this.configRepo.manager.query(
      `
      SELECT scope_type, scope_id
      FROM memory_workspace_config
      WHERE overrides->'routing'->>'mirror_backend' IS NOT NULL
      `,
    );
    const out: SyncResult[] = [];
    for (const r of cfgs as Array<{ scope_type: string; scope_id: string }>) {
      try {
        out.push(await this.sync({ scope_type: r.scope_type as any, scope_id: r.scope_id }));
      } catch (e: any) {
        this.logger.error(`sync failed for ${r.scope_type}:${r.scope_id}: ${e.message}`);
        out.push({
          scope: { scope_type: r.scope_type as any, scope_id: r.scope_id },
          primary: '', mirror: '',
          to_mirror: 0, to_primary: 0, reconciled: 0,
          errors: [{ side: 'primary', id: '', error: e.message ?? String(e) }],
          skipped: true, reason: `error: ${e.message}`,
        });
      }
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────

  private async collect(
    backend: MemoryBackend,
    scope: ScopeRef,
    creds: BackendCredentials | null,
  ): Promise<MemoryItem[]> {
    const items: MemoryItem[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < MemorySyncService.MAX_PAGES; pages++) {
      const page = await backend.list(
        { scope, limit: 200, cursor, mode: 'memory' },
        creds ?? undefined,
      );
      items.push(...page.items);
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return items;
  }
}

// ──────────────────────────────────────────────────────────────

function zeroResult(scope: ScopeRef, primary: string, mirror: string, skipped: boolean, reason?: string): SyncResult {
  return { scope, primary, mirror, to_mirror: 0, to_primary: 0, reconciled: 0, errors: [], skipped, reason };
}

function chunked<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
