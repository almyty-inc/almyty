import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditLog, AuditAction, AuditResource } from '../../../src/entities/audit-log.entity';

export interface AuditExportFilters {
  organizationId: string;
  resourceType?: AuditResource;
  action?: AuditAction;
  userId?: string;
  from?: Date;
  to?: Date;
  /** Hard cap on rows exported in one shot. */
  limit?: number;
}

export interface ExportResult {
  format: 'json' | 'csv';
  contentType: string;
  filename: string;
  body: string;
  count: number;
}

const MAX_EXPORT_ROWS = 50_000;

/** Columns emitted (in order) for CSV / flat consumers. */
const EXPORT_COLUMNS = [
  'id',
  'createdAt',
  'organizationId',
  'userId',
  'userEmail',
  'action',
  'resourceType',
  'resourceId',
  'resourceName',
  'status',
  'ipAddress',
  'details',
] as const;

/**
 * EE (audit_export): bulk export of the org's audit trail as a
 * downloadable JSON or CSV document. Reuses the OSS audit-log table but
 * lifts the in-app query cap (200) so compliance teams can pull a full
 * window at once.
 */
@Injectable()
export class AuditExportService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogs: Repository<AuditLog>,
  ) {}

  async collect(filters: AuditExportFilters): Promise<AuditLog[]> {
    const limit = Math.min(filters.limit ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);
    const qb = this.auditLogs
      .createQueryBuilder('audit')
      .where('audit.organizationId = :organizationId', {
        organizationId: filters.organizationId,
      });
    if (filters.resourceType)
      qb.andWhere('audit.resourceType = :resourceType', { resourceType: filters.resourceType });
    if (filters.action) qb.andWhere('audit.action = :action', { action: filters.action });
    if (filters.userId) qb.andWhere('audit.userId = :userId', { userId: filters.userId });
    if (filters.from) qb.andWhere('audit.createdAt >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('audit.createdAt <= :to', { to: filters.to });
    return qb.orderBy('audit.createdAt', 'DESC').take(limit).getMany();
  }

  async export(format: 'json' | 'csv', filters: AuditExportFilters): Promise<ExportResult> {
    const rows = await this.collect(filters);
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      return {
        format,
        contentType: 'text/csv',
        filename: `audit-export-${stamp}.csv`,
        body: this.toCsv(rows),
        count: rows.length,
      };
    }
    return {
      format: 'json',
      contentType: 'application/json',
      filename: `audit-export-${stamp}.json`,
      body: JSON.stringify(rows, null, 2),
      count: rows.length,
    };
  }

  private toCsv(rows: AuditLog[]): string {
    const header = EXPORT_COLUMNS.join(',');
    const lines = rows.map((row) =>
      EXPORT_COLUMNS.map((col) => this.csvCell((row as any)[col])).join(','),
    );
    return [header, ...lines].join('\n');
  }

  private csvCell(value: unknown): string {
    if (value == null) return '';
    let s: string;
    if (value instanceof Date) s = value.toISOString();
    else if (typeof value === 'object') s = JSON.stringify(value);
    else s = String(value);
    // RFC 4180 quoting: wrap in quotes and double any embedded quote when
    // the value contains a comma, quote, or newline.
    if (/[",\n\r]/.test(s)) {
      s = `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }
}
