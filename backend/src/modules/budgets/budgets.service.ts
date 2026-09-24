import { Injectable, Logger, NotFoundException, BadRequestException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, IsNull, Not } from 'typeorm';

import { Agent } from '../../entities/agent.entity';
import { isOthersPrivate } from '../../common/authorization/private-visibility';
import { resourceOwnerId } from '../../common/authorization/access-policy.service';

import {
  SpendBudget, SpendBudgetBehavior, SpendBudgetPeriod,
} from '../../entities/spend-budget.entity';
import { SpendAlert, SpendAlertLevel } from '../../entities/spend-alert.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam } from '../../entities/user-team.entity';
import { isEffectiveMembership } from '../../common/authorization/membership';
import { User } from '../../entities/user.entity';
import { MailService } from '../mail/mail.service';
import { renderEmailTemplate } from '../mail/email-templates';
import { NotificationsService } from '../notifications/notifications.service';
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
    // @Global notifications pipeline; @Optional() so a module without it
    // still boots.
    @Optional()
    private readonly notifications: NotificationsService | undefined,
    // Agent visibility: a budget or breach on another member's private
    // agent is hidden from the caller, and notifies only that agent's owner.
    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,
    // Team agents: a budget on one is visible to that team and the org's
    // owners/admins only.
    @InjectRepository(UserTeam)
    private readonly userTeamRepo: Repository<UserTeam>,
  ) {}

  // ── CRUD (T2.4) ──────────────────────────────────────────────────
  //
  // `viewerId` is the calling user. A budget scoped to an agent the caller
  // may not see (another member's private agent, or a team agent outside
  // the caller's teams -- see hiddenAgentIds) answers exactly like a
  // missing budget: it is not listed, and get/update/delete are 404. The
  // breach alerts below follow the same rule. Such a budget is still
  // enforced (enforceForRun): the ceiling was set on the org's spend, and
  // hiding it must not turn into a way to shed it.

  async list(organizationId: string, viewerId: string | null | undefined): Promise<SpendBudget[]> {
    const hidden = await this.hiddenAgentIds(organizationId, viewerId);
    return this.budgetRepo.find({
      where: this.visibleScope(organizationId, hidden) as any,
      order: { createdAt: 'DESC' },
    });
  }

  async get(
    id: string,
    organizationId: string,
    viewerId: string | null | undefined,
  ): Promise<SpendBudget> {
    const budget = await this.budgetRepo.findOne({ where: { id, organizationId } });
    if (!budget) throw new NotFoundException('Budget not found');
    if (budget.agentId) {
      const hidden = await this.hiddenAgentIds(organizationId, viewerId);
      if (hidden.includes(budget.agentId)) throw new NotFoundException('Budget not found');
    }
    return budget;
  }

  async create(
    organizationId: string,
    dto: CreateBudgetDto,
    viewerId: string | null | undefined,
  ): Promise<SpendBudget> {
    this.validate(dto, true);
    if (dto.agentId) await this.assertTargetableAgent(organizationId, dto.agentId, viewerId);
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

  async update(
    id: string,
    organizationId: string,
    dto: UpdateBudgetDto,
    viewerId: string | null | undefined,
  ): Promise<SpendBudget> {
    const budget = await this.get(id, organizationId, viewerId);
    this.validate(dto, false);
    if (dto.agentId) await this.assertTargetableAgent(organizationId, dto.agentId, viewerId);
    if (dto.agentId !== undefined) budget.agentId = dto.agentId ?? null;
    if (dto.llmProviderId !== undefined) budget.llmProviderId = dto.llmProviderId ?? null;
    if (dto.periodType !== undefined) budget.periodType = dto.periodType;
    if (dto.limitCents !== undefined) budget.limitCents = Math.floor(dto.limitCents);
    if (dto.behavior !== undefined) budget.behavior = dto.behavior;
    if (dto.softThresholdPct !== undefined) budget.softThresholdPct = dto.softThresholdPct;
    if (dto.active !== undefined) budget.active = dto.active;
    return this.budgetRepo.save(budget);
  }

  async remove(id: string, organizationId: string, viewerId: string | null | undefined): Promise<void> {
    await this.get(id, organizationId, viewerId);
    const res = await this.budgetRepo.delete({ id, organizationId });
    if (!res.affected) throw new NotFoundException('Budget not found');
  }

  private validate(dto: UpdateBudgetDto, isCreate: boolean): void {
    if (isCreate || dto.limitCents !== undefined) {
      if (!Number.isFinite(dto.limitCents as number) || (dto.limitCents as number) <= 0) {
        throw new BadRequestException('limitCents must be a positive integer');
      }
    }
    // Spend is recorded per org and per agent only — nothing records the
    // LLM provider a run was billed to — so a provider-scoped budget is a
    // ceiling nothing can measure. Refused at the edge instead of being
    // silently evaluated against org-wide spend (see enforceForRun).
    if (dto.llmProviderId) {
      throw new BadRequestException(
        'Provider-scoped budgets are not supported: spend is not attributed per LLM provider. ' +
          'Scope the budget to the organization (agentId and llmProviderId both null) or to a single agent.',
      );
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

  /**
   * Recent breaches, without those on another member's private agent:
   * a breach row carries that agent's id and spend. The filter is in the
   * query, so `limit` still means "this many rows the caller may see".
   */
  async listAlerts(
    organizationId: string,
    viewerId: string | null | undefined,
    limit = 100,
  ): Promise<SpendAlert[]> {
    const hidden = await this.hiddenAgentIds(organizationId, viewerId);
    return this.alertRepo.find({
      where: this.visibleScope(organizationId, hidden) as any,
      order: { at: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  // ── Agent visibility ─────────────────────────────────────────────

  /**
   * The org's agents `viewerId` may not see, by the same rule as the agent
   * itself (AccessPolicyService.canAccess, 'read'):
   *  - a private agent is hidden from everyone but its owner, org
   *    owners/admins included; one with no recorded owner is nobody's;
   *  - a team agent is hidden from members outside its team; org
   *    owners/admins see it; one with no team is hidden from non-admins.
   * With no known viewer, or a viewer who is not an effective member of
   * the org, every private and team agent is hidden.
   *
   * A budget or breach row names its agent and that agent's spend, so it
   * is visible exactly when the agent is.
   */
  async hiddenAgentIds(
    organizationId: string,
    viewerId: string | null | undefined,
  ): Promise<string[]> {
    const agents = await this.agentRepo.find({
      where: [
        { organizationId, visibility: 'private' },
        { organizationId, visibility: 'team' },
      ],
      select: { id: true, visibility: true, teamId: true, createdBy: true },
    });
    if (agents.length === 0) return [];

    const membership = viewerId
      ? await this.userOrgRepo.findOne({ where: { userId: viewerId, organizationId, isActive: true } })
      : null;
    const role = isEffectiveMembership(membership) ? membership!.role : null;
    const isAdmin = role === OrganizationRole.OWNER || role === OrganizationRole.ADMIN;

    const teamIds = [...new Set(agents.map((a) => a.teamId).filter((t): t is string => !!t))];
    const myTeams = new Set<string>();
    if (role && !isAdmin && teamIds.length > 0) {
      const rows = await this.userTeamRepo.find({
        where: { userId: viewerId!, teamId: In(teamIds), isActive: true },
        select: { teamId: true },
      });
      for (const row of rows) myTeams.add(row.teamId);
    }

    return agents
      .filter((a) => {
        if (a.visibility === 'private') return isOthersPrivate(a, viewerId);
        if (!role) return true;
        if (isAdmin) return false;
        return !a.teamId || !myTeams.has(a.teamId);
      })
      .map((a) => a.id);
  }

  /**
   * `where` for budget and alert rows the viewer may see: org-wide rows,
   * and agent-scoped rows whose agent is not in `hidden`. The IsNull arm
   * is needed because NOT IN never matches a NULL agentId.
   */
  private visibleScope(organizationId: string, hidden: string[]) {
    if (hidden.length === 0) return { organizationId };
    return [
      { organizationId, agentId: IsNull() },
      { organizationId, agentId: Not(In(hidden)) },
    ];
  }

  /**
   * 404 when `agentId` is not an agent of this org, or is an agent the
   * caller may not see (another member's private agent, or a team agent
   * outside the caller's teams). Used before a budget is pointed at an
   * agent; the answer for a hidden agent is the same as for a missing one.
   */
  private async assertTargetableAgent(
    organizationId: string,
    agentId: string,
    viewerId: string | null | undefined,
  ): Promise<void> {
    const agent = await this.agentRepo.findOne({
      where: { id: agentId, organizationId },
      select: { id: true, visibility: true, createdBy: true },
    });
    if (!agent || (await this.hiddenAgentIds(organizationId, viewerId)).includes(agent.id)) {
      throw new NotFoundException('Agent not found');
    }
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

      // A provider-scoped budget cannot be evaluated here: neither spend
      // table (agent_runs / agent_executions) records which LLM provider
      // was billed, so SpendService has no provider dimension to filter
      // on and `periodToDateCents` below would return ORG-WIDE spend.
      // Comparing that to a single provider's limit is a ceiling firing
      // on the wrong meter: an "OpenAI, $10/month, reject" budget would
      // block every run in the org once $10 of Anthropic spend landed.
      // `validate()` now refuses to create one; a row inserted before
      // that guard is skipped loudly rather than mis-enforced.
      if (budget.llmProviderId) {
        this.logger.warn(
          `Skipping provider-scoped budget ${budget.id}: spend is not attributed per LLM ` +
            'provider, so this budget cannot be enforced. Re-scope it to the organization ' +
            'or to a single agent.',
        );
        continue;
      }

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

  /**
   * Notify a threshold breach to the recipients resolveRecipients picks
   * (owners/admins, or a private agent's owner alone): branded
   * email (rendered from the shared budget.alert template) plus an
   * in-app notification row. Triggering logic is unchanged — this
   * fires exactly once per budget/period/level via recordAlert's
   * dedup. When the notification pipeline is available, the email
   * list additionally honors each user's `budget.alert` email
   * preference (the per-period dedup already storms-proofs delivery).
   */
  private async sendAlertEmail(
    budget: SpendBudget,
    level: SpendAlertLevel,
    spentCents: number,
  ): Promise<void> {
    const recipients = await this.resolveRecipients(budget);
    if (recipients.length === 0) return;

    const spent = `$${(spentCents / 100).toFixed(2)}`;
    const limit = `$${(budget.limitCents / 100).toFixed(2)}`;
    const pct = Math.round((spentCents / budget.limitCents) * 100);
    const scope = budget.agentId ? 'this agent' : 'your organization';
    const params = {
      level,
      spent,
      limit,
      pct,
      scope,
      periodType: budget.periodType,
      behavior: budget.behavior,
    };
    const rendered = renderEmailTemplate('budget.alert', params);

    // Honor per-user email preferences when the pipeline is available.
    let emailTargets = recipients;
    if (this.notifications) {
      try {
        const allowedIds = new Set(
          await this.notifications.filterUsersWithEmailEnabled(
            'budget.alert',
            recipients.map((r) => r.userId),
          ),
        );
        emailTargets = recipients.filter((r) => allowedIds.has(r.userId));
      } catch {
        // Preference lookup failure degrades to "email everyone".
      }
    }

    await Promise.all(
      emailTargets.map(({ email }) =>
        this.mail.send({
          to: email,
          subject: rendered.subject,
          html: rendered.html,
          text: rendered.text,
        }),
      ),
    );

    // In-app rows for all owner/admin recipients (email deliberately
    // omitted from the emit — it was handled above so the existing
    // per-period dedup, not the 10-minute digest guard, governs it).
    if (this.notifications) {
      this.notifications
        .emit({
          type: 'budget.alert',
          organizationId: budget.organizationId,
          userIds: recipients.map((r) => r.userId),
          title:
            level === 'hard'
              ? `Spend budget reached (${spent} of ${limit})`
              : `Spend at ${pct}% of budget (${spent} of ${limit})`,
          body: `${spent} of ${limit} used this ${budget.periodType} for ${scope}.${level === 'hard' && budget.behavior === 'reject' ? ' New runs are blocked until the budget resets.' : ''}`,
          link: '/analytics',
        })
        .catch(() => {});
    }
  }

  /**
   * Who hears about a breach.
   *
   * An org-wide budget, or one on an agent other members can see, goes to
   * the org's owners/admins. A budget on a private agent goes to that
   * agent's owner alone: the alert reports the agent's spend, and a "just
   * me" agent is invisible to admins everywhere else. A private agent with
   * no recorded owner, or whose owner is no longer an active member,
   * notifies nobody rather than falling back to the admins.
   */
  private async resolveRecipients(
    budget: SpendBudget,
  ): Promise<Array<{ userId: string; email: string }>> {
    const { organizationId } = budget;
    let where: Array<Record<string, unknown>> = [
      { organizationId, role: OrganizationRole.OWNER, isActive: true },
      { organizationId, role: OrganizationRole.ADMIN, isActive: true },
    ];
    if (budget.agentId) {
      const agent = await this.agentRepo.findOne({
        where: { id: budget.agentId, organizationId },
        select: { id: true, visibility: true, createdBy: true },
      });
      if (agent?.visibility === 'private') {
        const owner = resourceOwnerId(agent);
        if (!owner) return [];
        where = [{ organizationId, userId: owner, isActive: true }];
      }
    }
    const memberships = await this.userOrgRepo.find({
      where: where as any,
      select: { userId: true },
    });
    if (memberships.length === 0) return [];
    const users = await this.userRepo.find({
      where: { id: In(memberships.map((m) => m.userId)) },
      select: { id: true, email: true },
    });
    return users
      .filter((u): u is User => !!u.email)
      .map((u) => ({ userId: u.id, email: u.email }));
  }
}
