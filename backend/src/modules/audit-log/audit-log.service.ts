import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual, MoreThanOrEqual } from 'typeorm';
import { AuditLog, AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { User } from '../../entities/user.entity';
import { AUDIT_STREAM_HOOK, AuditStreamHook } from '../../common/ee-hooks/ee-hooks';

export interface AuditLogOptions {
  organizationId: string;
  userId?: string;
  userEmail?: string;
  action: AuditAction;
  resourceType: AuditResource;
  resourceId: string;
  resourceName?: string;
  details?: Record<string, any>;
  changes?: { field: string; from: any; to: any }[];
  ipAddress?: string;
  userAgent?: string;
  status?: string;
  duration?: number;
  cost?: number;
  metadata?: Record<string, any>;
}

export interface AuditLogFilters {
  organizationId: string;
  resourceType?: AuditResource;
  resourceId?: string;
  action?: AuditAction;
  userId?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: Repository<AuditLog>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    // EE hook (audit_export): SIEM streaming after each write. Absent in
    // the community build — @Optional() resolves to undefined and the
    // write path is byte-for-byte the OSS behavior.
    @Optional()
    @Inject(AUDIT_STREAM_HOOK)
    private readonly auditStreamHook?: AuditStreamHook,
  ) {}

  /**
   * Log an audit event. Fire-and-forget — never throws.
   */
  async log(options: AuditLogOptions): Promise<AuditLog | null> {
    try {
      // Resolve user email if userId is provided but userEmail is not
      let userEmail = options.userEmail;
      if (options.userId && !userEmail) {
        try {
          const user = await this.userRepository.findOne({ where: { id: options.userId }, select: ['id', 'email'] });
          if (user) {
            userEmail = user.email;
          }
        } catch (e) {
          // Never block audit logging for a user lookup failure
        }
      }

      const entry = this.auditLogRepository.create({
        organizationId: options.organizationId,
        userId: options.userId,
        userEmail,
        action: options.action,
        resourceType: options.resourceType,
        resourceId: options.resourceId,
        resourceName: options.resourceName,
        details: options.details,
        changes: options.changes,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        status: options.status,
        duration: options.duration,
        cost: options.cost,
        metadata: options.metadata,
      });
      const saved = await this.auditLogRepository.save(entry);
      this.forwardToStreamHook(saved);
      return saved;
    } catch (error) {
      // Audit logging should never break the main flow
      this.logger.error(`Audit log failed: ${error.message}`, error.stack);
      return null;
    }
  }

  /**
   * EE (audit_export): forward a persisted audit row to the optional SIEM
   * streaming hook. Strictly fire-and-forget — the hook is never awaited
   * and any failure (sync or async) is swallowed so an unreachable SIEM
   * can't slow down or break the request that produced the event.
   */
  private forwardToStreamHook(entry: AuditLog): void {
    if (!this.auditStreamHook) return;
    try {
      Promise.resolve(this.auditStreamHook.afterAuditWrite(entry)).catch(
        (err) => this.logger.warn(`Audit stream hook failed: ${err?.message ?? err}`),
      );
    } catch (err: any) {
      this.logger.warn(`Audit stream hook failed: ${err?.message ?? err}`);
    }
  }

  /**
   * Query audit logs with filters and pagination
   */
  async findAll(filters: AuditLogFilters) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 50, 200);
    const skip = (page - 1) * limit;

    const qb = this.auditLogRepository.createQueryBuilder('audit')
      .where('audit.organizationId = :organizationId', { organizationId: filters.organizationId });

    if (filters.resourceType) {
      qb.andWhere('audit.resourceType = :resourceType', { resourceType: filters.resourceType });
    }
    if (filters.resourceId) {
      qb.andWhere('audit.resourceId = :resourceId', { resourceId: filters.resourceId });
    }
    if (filters.action) {
      qb.andWhere('audit.action = :action', { action: filters.action });
    }
    if (filters.userId) {
      qb.andWhere('audit.userId = :userId', { userId: filters.userId });
    }
    if (filters.from) {
      qb.andWhere('audit.createdAt >= :from', { from: filters.from });
    }
    if (filters.to) {
      qb.andWhere('audit.createdAt <= :to', { to: filters.to });
    }

    qb.orderBy('audit.createdAt', 'DESC');
    qb.skip(skip).take(limit);

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Get audit log for a specific resource
   */
  async getResourceHistory(
    organizationId: string,
    resourceType: AuditResource,
    resourceId: string,
    limit: number = 50,
  ): Promise<AuditLog[]> {
    return this.auditLogRepository.find({
      where: { organizationId, resourceType, resourceId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  /**
   * Compute field-level changes between old and new objects
   */
  computeChanges(oldObj: Record<string, any>, newObj: Record<string, any>, trackFields?: string[]): { field: string; from: any; to: any }[] {
    const changes: { field: string; from: any; to: any }[] = [];
    const fields = trackFields || Object.keys(newObj);

    for (const field of fields) {
      if (field in newObj) {
        const oldVal = oldObj[field];
        const newVal = newObj[field];
        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({ field, from: oldVal, to: newVal });
        }
      }
    }

    return changes;
  }

  // ── Convenience methods ──

  async logCreate(orgId: string, userId: string, resourceType: AuditResource, resourceId: string, resourceName: string, details?: any) {
    return this.log({ organizationId: orgId, userId, action: AuditAction.CREATE, resourceType, resourceId, resourceName, details });
  }

  async logUpdate(orgId: string, userId: string, resourceType: AuditResource, resourceId: string, resourceName: string, changes?: any[], details?: any) {
    return this.log({ organizationId: orgId, userId, action: AuditAction.UPDATE, resourceType, resourceId, resourceName, changes, details });
  }

  async logDelete(orgId: string, userId: string, resourceType: AuditResource, resourceId: string, resourceName: string) {
    return this.log({ organizationId: orgId, userId, action: AuditAction.DELETE, resourceType, resourceId, resourceName });
  }

  async logToolExecution(orgId: string, userId: string, toolId: string, toolName: string, details: { parameters?: any; success: boolean; executionTime?: number; cost?: number }) {
    return this.log({
      organizationId: orgId,
      userId,
      action: AuditAction.TOOL_EXECUTE,
      resourceType: AuditResource.TOOL,
      resourceId: toolId,
      resourceName: toolName,
      status: details.success ? 'success' : 'error',
      duration: details.executionTime,
      cost: details.cost,
      details,
    });
  }

  async logGatewayRequest(orgId: string, gatewayId: string, gatewayName: string, details: { method?: string; path?: string; statusCode?: number; responseTime?: number }) {
    return this.log({
      organizationId: orgId,
      action: AuditAction.INVOKE,
      resourceType: AuditResource.GATEWAY,
      resourceId: gatewayId,
      resourceName: gatewayName,
      status: details.statusCode && details.statusCode < 400 ? 'success' : 'error',
      duration: details.responseTime,
      details,
    });
  }

  async logRunEvent(orgId: string, userId: string, runId: string, agentName: string, action: AuditAction, details?: any) {
    return this.log({
      organizationId: orgId,
      userId,
      action,
      resourceType: AuditResource.AGENT_RUN,
      resourceId: runId,
      resourceName: agentName,
      details,
    });
  }
}
