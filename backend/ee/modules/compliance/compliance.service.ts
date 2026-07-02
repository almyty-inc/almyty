import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  CompliancePolicy,
  ComplianceSeverity,
  EnforceablePlugin,
} from '../../../src/entities/compliance-policy.entity';
import { AuditLog } from '../../../src/entities/audit-log.entity';
import { PiiFilterPlugin } from '../../../src/modules/plugins/built-in/pii-filter.plugin';
import { SecurityScannerPlugin } from '../../../src/modules/plugins/built-in/security-scanner.plugin';

/** Valid security severities, in ascending order of risk. */
const SEVERITIES: ComplianceSeverity[] = ['low', 'medium', 'high', 'critical'];
const ENFORCEABLE: EnforceablePlugin[] = ['pii-filter', 'security-scanner'];

export interface UpsertCompliancePolicyInput {
  enforcedPlugins?: EnforceablePlugin[];
  securityThreshold?: ComplianceSeverity;
  blockOnViolation?: boolean;
  piiCategories?: string[];
}

/**
 * The effective policy actually enforced. When no row exists we fall back
 * to a documented "secure default" so the compliance layer is safe even
 * before an admin configures it.
 */
export interface EffectiveCompliancePolicy {
  organizationId: string;
  configured: boolean;
  enforcedPlugins: EnforceablePlugin[];
  securityThreshold: ComplianceSeverity;
  blockOnViolation: boolean;
  piiCategories: string[];
}

export interface ComplianceReport {
  organizationId: string;
  window: { from: string; to: string };
  policy: EffectiveCompliancePolicy;
  /** Which enforced plugins are active + a snapshot of their config. */
  enforcedControls: Array<{
    plugin: EnforceablePlugin;
    enforced: boolean;
    settings: Record<string, any>;
  }>;
  /** Audit-derived activity counts scoped to the window. */
  activity: {
    totalEvents: number;
    byAction: Record<string, number>;
    /** Events over data-bearing surfaces the controls apply to. */
    scannableEvents: number;
    credentialAccessEvents: number;
  };
  /** Coarse posture score 0-100 derived from enforced controls. */
  postureScore: number;
}

/** Audit actions that flow through the scannable request/response surface. */
const SCANNABLE_ACTIONS = new Set([
  'execute',
  'invoke',
  'tool_execute',
  'run_start',
  'run_complete',
  'run_input',
]);
const CREDENTIAL_ACTIONS = new Set([
  'credential_create',
  'credential_update',
  'credential_use',
  'credential_delete',
]);

/**
 * EE (compliance_pack): the org-policy layer over the OSS built-in
 * pii-filter + security-scanner plugins. It stores which controls are
 * mandatory, resolves the effective policy, and scores a compliance
 * report from existing audit data — no new event pipeline required.
 */
@Injectable()
export class ComplianceService {
  private readonly pii = new PiiFilterPlugin();
  private readonly scanner = new SecurityScannerPlugin();

  constructor(
    @InjectRepository(CompliancePolicy)
    private readonly policies: Repository<CompliancePolicy>,
    @InjectRepository(AuditLog)
    private readonly audit: Repository<AuditLog>,
  ) {}

  /** Secure default when an org has not configured a policy yet. */
  private defaultEffective(organizationId: string): EffectiveCompliancePolicy {
    return {
      organizationId,
      configured: false,
      enforcedPlugins: [...ENFORCEABLE],
      securityThreshold: 'medium',
      blockOnViolation: true,
      piiCategories: [],
    };
  }

  async getEffectivePolicy(
    organizationId: string,
  ): Promise<EffectiveCompliancePolicy> {
    const row = await this.policies.findOne({ where: { organizationId } });
    if (!row) return this.defaultEffective(organizationId);
    return {
      organizationId,
      configured: true,
      enforcedPlugins: row.enforcedPlugins ?? [],
      securityThreshold: row.securityThreshold,
      blockOnViolation: row.blockOnViolation,
      piiCategories: row.piiCategories ?? [],
    };
  }

  async upsertPolicy(
    organizationId: string,
    input: UpsertCompliancePolicyInput,
  ): Promise<EffectiveCompliancePolicy> {
    this.validate(input);
    let row = await this.policies.findOne({ where: { organizationId } });
    if (!row) {
      row = this.policies.create({
        organizationId,
        enforcedPlugins: input.enforcedPlugins ?? [...ENFORCEABLE],
        securityThreshold: input.securityThreshold ?? 'medium',
        blockOnViolation: input.blockOnViolation ?? true,
        piiCategories: input.piiCategories ?? [],
      });
    } else {
      if (input.enforcedPlugins !== undefined) row.enforcedPlugins = input.enforcedPlugins;
      if (input.securityThreshold !== undefined) row.securityThreshold = input.securityThreshold;
      if (input.blockOnViolation !== undefined) row.blockOnViolation = input.blockOnViolation;
      if (input.piiCategories !== undefined) row.piiCategories = input.piiCategories;
    }
    await this.policies.save(row);
    return this.getEffectivePolicy(organizationId);
  }

  private validate(input: UpsertCompliancePolicyInput): void {
    if (input.enforcedPlugins !== undefined) {
      if (!Array.isArray(input.enforcedPlugins)) {
        throw new Error('enforcedPlugins must be an array');
      }
      for (const p of input.enforcedPlugins) {
        if (!ENFORCEABLE.includes(p)) {
          throw new Error(`unknown enforceable plugin: ${p}`);
        }
      }
    }
    if (
      input.securityThreshold !== undefined &&
      !SEVERITIES.includes(input.securityThreshold)
    ) {
      throw new Error(`invalid securityThreshold: ${input.securityThreshold}`);
    }
  }

  /**
   * Build a compliance report from the effective policy + audit activity
   * over `[from, to)`. `to` defaults to now, `from` to 30 days back.
   */
  async getReport(
    organizationId: string,
    opts: { from?: Date; to?: Date } = {},
  ): Promise<ComplianceReport> {
    const to = opts.to ?? new Date();
    const from = opts.from ?? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [policy, byActionRows] = await Promise.all([
      this.getEffectivePolicy(organizationId),
      this.audit
        .createQueryBuilder('log')
        .select('log.action', 'action')
        .addSelect('COUNT(*)', 'count')
        .where('log.organizationId = :orgId', { orgId: organizationId })
        .andWhere('log.createdAt >= :from', { from })
        .andWhere('log.createdAt < :to', { to })
        .groupBy('log.action')
        .getRawMany<{ action: string; count: string }>(),
    ]);

    const byAction: Record<string, number> = {};
    let totalEvents = 0;
    let scannableEvents = 0;
    let credentialAccessEvents = 0;
    for (const r of byActionRows) {
      const n = parseInt(r.count, 10) || 0;
      byAction[r.action] = n;
      totalEvents += n;
      if (SCANNABLE_ACTIONS.has(r.action)) scannableEvents += n;
      if (CREDENTIAL_ACTIONS.has(r.action)) credentialAccessEvents += n;
    }

    const piiDef = this.pii.getPluginDefinition();
    const scannerDef = this.scanner.getPluginDefinition();
    const enforcedSet = new Set(policy.enforcedPlugins);
    const enforcedControls = [
      {
        plugin: 'pii-filter' as EnforceablePlugin,
        enforced: enforcedSet.has('pii-filter'),
        settings: {
          ...piiDef.configuration.settings,
          categories:
            policy.piiCategories.length > 0 ? policy.piiCategories : 'all',
        },
      },
      {
        plugin: 'security-scanner' as EnforceablePlugin,
        enforced: enforcedSet.has('security-scanner'),
        settings: {
          ...scannerDef.configuration.settings,
          severityThreshold: policy.securityThreshold,
          blockOnThreat: policy.blockOnViolation,
        },
      },
    ];

    const postureScore = this.scorePosture(policy);

    return {
      organizationId,
      window: { from: from.toISOString(), to: to.toISOString() },
      policy,
      enforcedControls,
      activity: {
        totalEvents,
        byAction,
        scannableEvents,
        credentialAccessEvents,
      },
      postureScore,
    };
  }

  /**
   * Coarse 0-100 posture: 40 points per enforced control + up to 20 for
   * blocking (vs monitor-only). A fully-enforced blocking policy = 100.
   */
  private scorePosture(policy: EffectiveCompliancePolicy): number {
    let score = 0;
    if (policy.enforcedPlugins.includes('pii-filter')) score += 40;
    if (policy.enforcedPlugins.includes('security-scanner')) score += 40;
    if (policy.blockOnViolation) score += 20;
    return Math.min(100, score);
  }
}
