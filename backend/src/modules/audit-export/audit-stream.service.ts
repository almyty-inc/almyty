import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  AuditStreamConfig,
  AuditStreamTarget,
} from '../../entities/audit-stream-config.entity';
import { AuditLog } from '../../entities/audit-log.entity';

export interface CreateStreamConfigInput {
  organizationId: string;
  target: AuditStreamTarget;
  endpoint: string;
  token?: string;
  actionFilter?: string[];
  enabled?: boolean;
}

export interface DeliveryResult {
  configId: string;
  target: AuditStreamTarget;
  ok: boolean;
  status?: number;
  error?: string;
}

const VALID_TARGETS: AuditStreamTarget[] = ['webhook', 'splunk_hec', 'datadog'];

/**
 * EE (audit_export): per-org config for streaming audit events to an
 * external SIEM, plus the outbound dispatcher. Uses the global `fetch`
 * (Node 18+) so it stays trivially mockable in tests — no HTTP client
 * dependency. Delivery is best-effort: a target failure is recorded on
 * the config row (`lastError`) but never propagated to the caller, so an
 * unreachable SIEM can't break the request that produced the event.
 */
@Injectable()
export class AuditStreamService {
  private readonly logger = new Logger(AuditStreamService.name);

  constructor(
    @InjectRepository(AuditStreamConfig)
    private readonly configs: Repository<AuditStreamConfig>,
  ) {}

  // ── Config CRUD ──

  async create(input: CreateStreamConfigInput): Promise<AuditStreamConfig> {
    if (!VALID_TARGETS.includes(input.target)) {
      throw new BadRequestException(`unsupported target: ${input.target}`);
    }
    if (!input.endpoint?.trim()) throw new BadRequestException('endpoint is required');
    const row = this.configs.create({
      organizationId: input.organizationId,
      target: input.target,
      endpoint: input.endpoint.trim(),
      token: input.token ?? null,
      actionFilter: input.actionFilter?.length ? input.actionFilter : null,
      enabled: input.enabled ?? true,
    });
    return this.configs.save(row);
  }

  async list(organizationId: string): Promise<AuditStreamConfig[]> {
    return this.configs.find({ where: { organizationId }, order: { createdAt: 'ASC' } });
  }

  async remove(organizationId: string, id: string): Promise<void> {
    const row = await this.configs.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('stream config not found');
    await this.configs.remove(row);
  }

  async setEnabled(
    organizationId: string,
    id: string,
    enabled: boolean,
  ): Promise<AuditStreamConfig> {
    const row = await this.configs.findOne({ where: { id, organizationId } });
    if (!row) throw new NotFoundException('stream config not found');
    row.enabled = enabled;
    return this.configs.save(row);
  }

  // ── Dispatch ──

  /**
   * Forward a single audit event to every enabled target for its org.
   * Best-effort — returns per-target results and records the outcome on
   * each config, but never throws.
   */
  async dispatch(event: Partial<AuditLog>): Promise<DeliveryResult[]> {
    if (!event.organizationId) return [];
    const targets = await this.configs.find({
      where: { organizationId: event.organizationId, enabled: true },
    });
    const results: DeliveryResult[] = [];
    for (const cfg of targets) {
      if (cfg.actionFilter?.length && event.action && !cfg.actionFilter.includes(event.action)) {
        continue;
      }
      results.push(await this.deliver(cfg, event));
    }
    return results;
  }

  /** Deliver to one target; records success/failure on the config row. */
  async deliver(cfg: AuditStreamConfig, event: Partial<AuditLog>): Promise<DeliveryResult> {
    const { url, headers, body } = this.buildRequest(cfg, event);
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      const ok = res.status >= 200 && res.status < 300;
      if (ok) {
        cfg.lastDeliveredAt = new Date();
        cfg.lastError = null;
      } else {
        cfg.lastError = `HTTP ${res.status}`;
      }
      await this.configs.save(cfg).catch(() => undefined);
      return { configId: cfg.id, target: cfg.target, ok, status: res.status };
    } catch (err: any) {
      const message = err?.message ?? 'delivery failed';
      cfg.lastError = message;
      await this.configs.save(cfg).catch(() => undefined);
      this.logger.warn(`audit stream delivery to ${cfg.target} failed: ${message}`);
      return { configId: cfg.id, target: cfg.target, ok: false, error: message };
    }
  }

  /**
   * Shape the outbound request per target. Kept public for unit testing
   * the payload/header mapping without a live fetch.
   */
  buildRequest(
    cfg: AuditStreamConfig,
    event: Partial<AuditLog>,
  ): { url: string; headers: Record<string, string>; body: string } {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    switch (cfg.target) {
      case 'splunk_hec': {
        if (cfg.token) headers.Authorization = `Splunk ${cfg.token}`;
        return {
          url: cfg.endpoint,
          headers,
          body: JSON.stringify({ event, sourcetype: 'almyty:audit', source: 'almyty' }),
        };
      }
      case 'datadog': {
        if (cfg.token) headers['DD-API-KEY'] = cfg.token;
        return {
          url: cfg.endpoint,
          headers,
          body: JSON.stringify([
            {
              ddsource: 'almyty',
              service: 'almyty-audit',
              ddtags: `action:${event.action ?? 'unknown'}`,
              message: JSON.stringify(event),
            },
          ]),
        };
      }
      case 'webhook':
      default: {
        if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
        return {
          url: cfg.endpoint,
          headers,
          body: JSON.stringify({ type: 'audit.event', event }),
        };
      }
    }
  }
}
