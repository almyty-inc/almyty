import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { gzipSync } from 'zlib';

import {
  detectBlob,
  overrideOrDefault,
  parseScheme,
  scopeToOrganizationId,
  uriSchemeAllowList,
} from './canonical-memory.helpers';
import { CanonicalMemorySoftcapWarning } from './canonical-memory-softcap-warning.entity';
import { LIMITS, softCapForTier, SoftCapBehavior } from './canonical.constants';
import { MemoryError, MemoryItem } from './canonical.types';
import { PutInput } from './dto/canonical-memory.dto';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../../entities/audit-log.entity';

interface WorkspaceConfig {
  overrides?: Record<string, any>;
  softcapBehavior: SoftCapBehavior;
}

/**
 * The put-pipeline validation phases (steps 4-10b in the spec)
 * extracted from CanonicalMemoryService:
 *  - blob detection
 *  - compression-ratio rejection
 *  - per-agent + workspace + system size ceilings
 *  - per-tier soft cap with workspace behavior
 *  - URI scheme allow-list
 *
 * Each side effect (audit log, softcap warning row) goes through
 * the helper's own deps, mirroring the original pipeline.
 */
@Injectable()
export class CanonicalPutValidators {
  constructor(
    @InjectRepository(CanonicalMemorySoftcapWarning)
    private readonly warningRepo: Repository<CanonicalMemorySoftcapWarning>,
    private readonly auditLog: AuditLogService,
  ) {}

  async run(
    item: MemoryItem,
    input: PutInput,
    contentBytes: number,
    actor: { user_id?: string },
    config: WorkspaceConfig,
  ): Promise<void> {
    // ── 4 & 5. Anti-dump: blob detection + compression ratio ─────────
    const blobKind = detectBlob(input.content);
    if (blobKind) {
      this.auditLog.log({
        organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
        userId: actor.user_id,
        action: AuditAction.MEMORY_DENIED,
        resourceType: AuditResource.MEMORY,
        resourceId: item.id,
        details: { reason: 'looks_like_blob', detected: blobKind, size: contentBytes },
      });
      throw new MemoryError({ kind: 'looks_like_blob', detected: blobKind, suggest: 'file' });
    }
    if (contentBytes > 1024) {
      const ratio = gzipSync(input.content).length / contentBytes;
      if (ratio < LIMITS.COMPRESSION_RATIO_REJECT_THRESHOLD) {
        this.auditLog.log({
          organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
          userId: actor.user_id,
          action: AuditAction.MEMORY_DENIED,
          resourceType: AuditResource.MEMORY,
          resourceId: item.id,
          details: { reason: 'compression_ratio', ratio, size: contentBytes },
        });
        throw new MemoryError({ kind: 'looks_like_blob', detected: 'binary', suggest: 'file' });
      }
    }

    // ── 6 & 7. Per-agent throttle / max single write ─────────────────
    if (item.mode === 'memory' && contentBytes > LIMITS.AGENT_MAX_SINGLE_WRITE_BYTES_DEFAULT) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: LIMITS.AGENT_MAX_SINGLE_WRITE_BYTES_DEFAULT,
        suggest: 'document',
      });
    }
    if (item.mode === 'document' && contentBytes > LIMITS.AGENT_MAX_IMPORT_BYTES_DEFAULT) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: LIMITS.AGENT_MAX_IMPORT_BYTES_DEFAULT,
        suggest: 'file',
      });
    }

    // ── 8 & 9. Workspace hard cap + system ceiling ───────────────────
    const hardCap =
      item.mode === 'memory'
        ? overrideOrDefault(
            config.overrides,
            'hard_cap_memory_bytes',
            LIMITS.WORKSPACE_DEFAULT_HARD_CAP_MEMORY_BYTES,
          )
        : overrideOrDefault(
            config.overrides,
            'hard_cap_document_bytes',
            LIMITS.WORKSPACE_DEFAULT_HARD_CAP_DOCUMENT_BYTES,
          );
    if (contentBytes > hardCap) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: hardCap,
        suggest: item.mode === 'memory' ? 'document' : 'file',
      });
    }
    const systemCeiling =
      item.mode === 'memory'
        ? LIMITS.SYSTEM_CEILING_MEMORY_BYTES
        : LIMITS.SYSTEM_CEILING_DOCUMENT_BYTES;
    if (contentBytes > systemCeiling) {
      throw new MemoryError({
        kind: 'too_large',
        size: contentBytes,
        hard_cap: systemCeiling,
        suggest: item.mode === 'memory' ? 'document' : 'file',
      });
    }

    // ── 10. Per-tier soft cap with workspace behavior ────────────────
    if (item.mode === 'memory' && item.tier !== null) {
      const softCap = softCapForTier(item.tier);
      if (contentBytes > softCap) {
        const behavior: SoftCapBehavior = config.softcapBehavior;
        if (behavior === 'reject') {
          throw new MemoryError({
            kind: 'too_large',
            size: contentBytes,
            soft_cap: softCap,
            hard_cap: hardCap,
            suggest: 'document',
          });
        }
        if (behavior === 'warn_log') {
          await this.warningRepo.save({
            memoryId: item.id,
            scopeType: item.scope_type,
            scopeId: item.scope_id,
            tier: item.tier,
            mode: item.mode,
            sizeBytes: contentBytes,
            softCap,
          } as CanonicalMemorySoftcapWarning);
          this.auditLog.log({
            organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
            userId: actor.user_id,
            action: AuditAction.MEMORY_SOFTCAP_WARNING,
            resourceType: AuditResource.MEMORY,
            resourceId: item.id,
            details: { tier: item.tier, size: contentBytes, soft_cap: softCap },
          });
        }
        // 'silent' → fall through.
      }
    }

    // ── 10b. URI scheme allow-list ───────────────────────────────────
    const allowed = uriSchemeAllowList(config.overrides);
    const refs: string[] = [
      ...item.file_refs,
      ...(item.source_uri ? [item.source_uri] : []),
    ];
    for (const ref of refs) {
      const scheme = parseScheme(ref);
      if (!scheme) continue;
      if (!allowed.has(scheme)) {
        this.auditLog.log({
          organizationId: scopeToOrganizationId(item.scope_type, item.scope_id),
          userId: actor.user_id,
          action: AuditAction.MEMORY_DENIED,
          resourceType: AuditResource.MEMORY,
          resourceId: item.id,
          details: { reason: 'uri_scheme_blocked', scheme, ref },
        });
        throw new MemoryError({
          kind: 'validation',
          issues: [
            {
              path: item.source_uri === ref ? 'source_uri' : 'file_refs',
              message: `URI scheme "${scheme}:" is not in this workspace's allow-list`,
            },
          ],
        });
      }
    }
  }
}
