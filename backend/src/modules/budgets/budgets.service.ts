import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';

import {
  SpendBudget, SpendBudgetBehavior, SpendBudgetPeriod,
} from '../../entities/spend-budget.entity';
import { SpendAlert, SpendAlertLevel } from '../../entities/spend-alert.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { User } from '../../entities/user.entity';
import { MailService } from '../mail/mail.service';
import { SpendService } from './spend.service';
import { startOfPeriod } from './spend-period.util';
import { BudgetExceededException } from './budget-exceeded.exception';

export interface CreateBudgetDto {
  agentId?: string | null;
  llmProviderId?: string | null;
  periodType?: SpendBudgetPeriod;
  limitCents: number;
  behavior?: SpendBudgetBehavior;
  softThresholdPct?: number;
  active?: boolean;
}

export type UpdateBudgetDto = Partial<CreateBudgetDto>;

const PERIODS: SpendBudgetPeriod[] = ['day', 'month'];
const BEHAVIORS: SpendBudgetBehavior[] = ['warn_log', 'reject'];

/**
 * Cost-governance service: CRUD for SpendBudget, the pre-run
 * enforcement hook (T2.5), and append-only SpendAlert emission with
 * per-period dedup + email delivery (T2.6/T2.7).
 */
@Injectable()
export class BudgetsService {
  private readonly logger = new Logger(BudgetsService.name);

  constructor(
    @InjectRepository(SpendBudget)
    private readonly budgetRepo: Repository<SpendBudget>,
    @InjectRepository(SpendAlert)
    private readonly alertRepo: Repository<SpendAlert>,
    @InjectRepository(UserOrganization)
    private readonly userOrgRepo: Repository<UserOrganization>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly spend: SpendService,
    private readonly mail: MailService,
  ) {}

  // ── CRUD (T2.4) ──────────────────────────────────────────────────

  list(organizationId: string): Promise<SpendBudget[]> {
    return this.budgetRepo.find({
      where: { organizationId },
      order: { createdAt: 'DESC' },
    });
  }

  async get(id: string, organizationId: string): Promise<SpendBudget> {
    const budget = await this.budgetRepo.findOne({ where: { id, organizationId } });
    if (!budget) throw new NotFoundException('Budget not found');
    return budget;
  }

  async create(organizationId: string, dto: CreateBudgetDto): Promise<SpendBudget> {
    this.validate(dto, true);
    const budget = this.budgetRepo.create({
      organizationId,
      agentId: dto.agentId ?? null,
      llmProviderId: dto.llmProviderId ?? null,
      periodType: dto.periodType ?? 'month',
      limitCents: Math.floor(dto.limitCents),
      behavior: dto.behavior ?? 'warn_log',
      softThresholdPct: dto.softThresholdPct ?? 80,
      active: dto.active ?? true,
    });
    return this.budgetRepo.save(budget);
  }

  async update(id: string, organizationId: string, dto: UpdateBudgetDto): Promise<SpendBudget> {
    const budget = await this.get(id, organizationId);
    this.validate(dto, false);
    if (dto.agentId !== undefined) budget.agentId = dto.agentId ?? null;
    if (dto.llmProviderId !== undefined) budget.llmProviderId = dto.llmProviderId ?? null;
    if (dto.periodType !== undefined) budget.periodType = dto.periodType;
    if (dto.limitCents !== undefined) budget.limitCents = Math.floor(dto.limitCents);
    if (dto.behavior !== undefined) budget.behavior = dto.behavior;
    if (dto.softThresholdPct !== undefined) budget.softThresholdPct = dto.softThresholdPct;
    if (dto.active !== undefined) budget.active = dto.active;
    return this.budgetRepo.save(budget);
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const res = await this.budgetRepo.delete({ id, organizationId });
    if (!res.affected) throw new NotFoundException('Budget not found');
  }

  private validate(dto: UpdateBudgetDto, isCreate: boolean): void {
    if (isCreate || dto.limitCents !== undefined) {
      if (!Number.isFinite(dto.limitCents as number) || (dto.limitCents as number) <= 0) {
        throw new BadRequestException('limitCents must be a positive integer');
      }
    }
    if (dto.periodType !== undefined && !PERIODS.includes(dto.periodType)) {
      throw new BadRequestException(`periodType must be one of: ${PERIODS.join(', ')}`);
    }
    if (dto.behavior !== undefined && !BEHAVIORS.includes(dto.behavior)) {
      throw new BadRequestException(`behavior must be one of: ${BEHAVIORS.join(', ')}`);
    }
    if (dto.softThresholdPct !== undefined) {
      const pct = dto.softThresholdPct;
      if (!Number.isInteger(pct) || pct < 1 || pct > 100) {
        throw new BadRequestException('softThresholdPct must be an integer between 1 and 100');
      }
    }
  }

  // ── Alerts read-side ─────────────────────────────────────────────

  listAlerts(organizationId: string, limit = 100): Promise<SpendAlert[]> {
    return this.alertRepo.find({
      where: { organizationId },
      order: { at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  // ── Enforcement (T2.5) ───────────────────────────────────────────

  /**
   * Called before a run starts. For every active budget matching the
   * org (and the run's agent, if the budget is agent-scoped), compares
   * period-to-date spend to the limit:
   *   - >= limit + behavior 'reject'   → throw BudgetExceededException
   *   - >= limit + behavior 'warn_log' → record hard alert, proceed
   *   - >= soft threshold              → record soft alert, proceed
   * No matching budget → no-op (unchanged behavior). Never throws for
   * anything other than a deliberate reject — alert/email failures are
   * swallowed so governance can't take down the run path.
   */
  async enforceForRun(organizationId: string, agentId: string): Promise<void> {
    const budgets = await this.budgetRepo.find({
      where: { organizationId, active: true },
    });
    if (budgets.length === 0) return;

    const now = new Date();
    for (const budget of budgets) {
      // Skip agent-scoped budgets that don't target this agent.
      if (budget.agentId && budget.agentId !== agentId) continue;

      const periodStart = startOfPeriod(budget.periodType, now);
      const spentCents = await this.spend.periodToDateCents({
        organizationId,
        agentId: budget.agentId ?? undefined,
        from: periodStart,
      });

      const softLimit = Math.floor((budget.limitCents * budget.softThresholdPct) / 100);

      if (spentCents >= budget.limitCents) {
        await this.recordAlert(budget, 'hard', periodStart, spentCents);
        if (budget.behavior === 'reject') {
          throw new BudgetExceededException({
            budgetId: budget.id,
            organizationId,
            agentId: budget.agentId ?? null,
            spentCents,
            limitCents: budget.limitCents,
            periodType: budget.periodType,
          });
        }
      } else if (spentCents >= softLimit) {
        await this.recordAlert(budget, 'soft', periodStart, spentCents);
      }
    }
  }

  /**
   * Append a SpendAlert once per (budget, period, level). Returns true
   * when a new row was written (i.e. first breach this period) — that
   * is also when the email fires, giving us dedup for free. Relies on
   * the unique index as the race backstop.
   */
  async recordAlert(
    budget: SpendBudget,
    level: SpendAlertLevel,
    periodStart: Date,
    spentCents: number,
  ): Promise<boolean> {
    try {
      const existing = await this.alertRepo.findOne({
        where: { budgetId: budget.id, periodStart, level },
      });
      if (existing) return false;

      const alert = this.alertRepo.create({
        budgetId: budget.id,
        organizationId: budget.organizationId,
        agentId: budget.agentId ?? null,
        llmProviderId: budget.llmProviderId ?? null,
        level,
        periodType: budget.periodType,
        periodStart,
        spentCents,
        limitCents: budget.limitCents,
      });
      await this.alertRepo.save(alert);

      // Fire-and-forget email; delivery failures must not break the run.
      this.sendAlertEmail(budget, level, spentCents).catch((err) =>
        this.logger.warn(`Spend alert email failed for budget ${budget.id}: ${err?.message}`),
      );
      return true;
    } catch (err: any) {
      // Unique-index violation = another worker already recorded it.
      this.logger.warn(`recordAlert skipped for budget ${budget.id}/${level}: ${err?.message}`);
      return false;
    }
  }

  /** Email the org's owners/admins about a threshold breach. */
  private async sendAlertEmail(
    budget: SpendBudget,
    level: SpendAlertLevel,
    spentCents: number,
  ): Promise<void> {
    const recipients = await this.resolveRecipients(budget.organizationId);
    if (recipients.length === 0) return;

    const spent = `$${(spentCents / 100).toFixed(2)}`;
    const limit = `$${(budget.limitCents / 100).toFixed(2)}`;
    const pct = Math.round((spentCents / budget.limitCents) * 100);
    const subject =
      level === 'hard'
        ? `almyty spend budget reached (${spent} of ${limit})`
        : `almyty spend at ${pct}% of budget (${spent} of ${limit})`;
    const scope = budget.agentId ? 'this agent' : 'your organization';
    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
        <h2 style="color: #8b5cf6; margin-bottom: 8px;">almyty</h2>
        <p style="font-size: 16px; color: #18181b;">
          ${level === 'hard' ? 'The spend budget for' : `Spend has reached ${pct}% of the budget for`}
          <strong>${scope}</strong> this ${budget.periodType}.
        </p>
        <p style="font-size: 16px; color: #18181b;">
          <strong>${spent}</strong> of <strong>${limit}</strong> used.
          ${level === 'hard' && budget.behavior === 'reject' ? 'New runs are blocked until the budget resets.' : ''}
        </p>
        <p style="font-size: 12px; color: #a1a1aa; margin-top: 32px;">
          almyty — cost governance
        </p>
      </div>`;
    const text =
      `${subject}. ${spent} of ${limit} used this ${budget.periodType} for ${scope}.`;

    await Promise.all(
      recipients.map((to) => this.mail.send({ to, subject, html, text })),
    );
  }

  /** Owner/admin emails for the org (budget-breach notification targets). */
  private async resolveRecipients(organizationId: string): Promise<string[]> {
    const memberships = await this.userOrgRepo.find({
      where: [
        { organizationId, role: OrganizationRole.OWNER, isActive: true },
        { organizationId, role: OrganizationRole.ADMIN, isActive: true },
      ],
      select: ['userId'],
    });
    if (memberships.length === 0) return [];
    const users = await this.userRepo.find({
      where: { id: In(memberships.map((m) => m.userId)) },
      select: ['email'],
    });
    return users.map((u) => u.email).filter((e): e is string => !!e);
  }
}
