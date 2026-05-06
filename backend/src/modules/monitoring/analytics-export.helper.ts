import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';

import { RequestLog } from '../../entities/request-log.entity';
import { ToolExecution } from '../../entities/tool-execution.entity';
import { Conversation } from '../../entities/conversation.entity';

export interface ExportQuery {
  type: 'requests' | 'tool-executions' | 'llm-sessions';
  format?: 'json' | 'csv';
  organizationId: string;
  from?: Date;
  to?: Date;
}

/**
 * Data export + CSV serialization extracted from AnalyticsService.
 * Handles the org-scoped fetch for each export type and the safe
 * CSV cell escaping (RFC 4180 quoting plus formula-injection
 * mitigation).
 */
@Injectable()
export class AnalyticsExportHelper {
  constructor(
    @InjectRepository(RequestLog)
    private readonly requestLogRepository: Repository<RequestLog>,
    @InjectRepository(ToolExecution)
    private readonly toolExecutionRepository: Repository<ToolExecution>,
    @InjectRepository(Conversation)
    private readonly conversationRepository: Repository<Conversation>,
  ) {}

  async exportData(query: ExportQuery): Promise<any> {
    if (!query.organizationId) {
      throw new Error('exportData requires organizationId');
    }
    const from = query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const to = query.to || new Date();

    if (query.type === 'requests') {
      const logs = await this.requestLogRepository
        .createQueryBuilder('log')
        .innerJoin('log.gateway', 'gw')
        .where('gw.organizationId = :orgId', { orgId: query.organizationId })
        .andWhere('log.timestamp BETWEEN :from AND :to', { from, to })
        .orderBy('log.timestamp', 'DESC')
        .take(10000)
        .getMany();

      if (query.format === 'csv') {
        return this.toCsv(logs, [
          'id', 'method', 'path', 'statusCode', 'responseTime',
          'userAgent', 'ipAddress', 'gatewayId', 'toolId', 'userId',
          'errorMessage', 'requestSize', 'responseSize', 'timestamp',
        ]);
      }
      return logs;
    }

    if (query.type === 'tool-executions') {
      const execs = await this.toolExecutionRepository.find({
        where: { organizationId: query.organizationId, createdAt: Between(from, to) },
        order: { createdAt: 'DESC' },
        take: 10000,
      });

      if (query.format === 'csv') {
        return this.toCsv(execs, [
          'id', 'toolId', 'userId', 'organizationId', 'success',
          'executionTime', 'cached', 'retryCount', 'error', 'createdAt',
        ]);
      }
      return execs;
    }

    if (query.type === 'llm-sessions') {
      const sessions = await this.conversationRepository.find({
        where: { organizationId: query.organizationId, createdAt: Between(from, to) },
        order: { createdAt: 'DESC' },
        take: 10000,
      });

      if (query.format === 'csv') {
        return this.toCsv(sessions, [
          'id', 'providerId', 'type', 'status', 'messageCount',
          'totalInputTokens', 'totalOutputTokens', 'totalCost',
          'toolCalls', 'successfulToolCalls', 'createdAt', 'completedAt',
        ]);
      }
      return sessions;
    }

    return [];
  }

  private toCsv(data: any[], columns: string[]): string {
    const header = columns.join(',');
    const rows = data.map((item) => columns.map((col) => this.escapeCsvCell(item[col])).join(','));
    return [header, ...rows].join('\n');
  }

  /**
   * Escape a CSV cell value. Handles RFC 4180 quoting and prepends
   * a single quote to any cell starting with `=`, `+`, `-`, `@`,
   * `\t`, or `\r` to defuse the OWASP CSV-formula-injection class.
   */
  private escapeCsvCell(val: any): string {
    if (val === null || val === undefined) return '';
    let str = String(val);

    if (str.length > 0 && /^[=+\-@\t\r]/.test(str)) {
      str = `'${str}`;
    }

    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }
}
