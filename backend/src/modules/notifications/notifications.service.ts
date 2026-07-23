import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, MoreThan, Repository } from 'typeorm';

import { Notification } from '../../entities/notification.entity';
import { NotificationPreference } from '../../entities/notification-preference.entity';
import { User } from '../../entities/user.entity';
import { UserOrganization, OrganizationRole } from '../../entities/user-organization.entity';
import { UserTeam, TeamRole } from '../../entities/user-team.entity';
import { MailService } from '../mail/mail.service';
import {
  ChannelPrefs,
  EMAIL_RATE_CAP_MS,
  MANDATORY_EMAIL_TYPES,
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_EVENT_TYPES,
  NotificationEventType,
} from './notification-types';

/**
 * Role-based recipient target, resolved against the org membership
 * tables at emit time. `orgRoles` selects active, accepted org members
 * holding one of the roles; `teamLeadOfTeamId` additionally selects the
 * LEAD(s) of a team (the approvals RBAC shape: org owner/admin plus the
 * resource team's LEAD can decide).
 */
export interface RoleTarget {
  orgRoles?: OrganizationRole[];
  teamLeadOfTeamId?: string | null;
}

export interface EmitNotificationInput {
  type: NotificationEventType;
  organizationId: string;
  /** Explicit recipients (deduplicated with roleTarget resolution). */
  userIds?: string[];
  /** Role-based recipients, resolved via org membership tables. */
  roleTarget?: RoleTarget;
  title: string;
  body: string;
  /** Frontend-relative link the UI navigates to on click. */
  link?: string | null;
  /**
   * Optional email delivery. When present, users whose effective email
   * preference for `type` is on receive a branded email rendered from
   * the given template (see mail/email-templates.ts). Subject defaults
   * to the template's own subject.
   */
  email?: {
    subject?: string;
    template: string;
    params?: Record<string, any>;
  };
  /** Skip creating an in-app row for these users (e.g. the actor). */
  excludeUserIds?: string[];
}

export interface NotificationListResult {
  notifications: Array<{
    id: string;
    type: string;
    title: string;
    body: string;
    link: string | null;
    createdAt: Date;
    readAt: Date | null;
  }>;
  total: number;
  unreadCount: number;
}

export interface PreferencesResult {
  matrix: Record<string, ChannelPrefs>;
  defaults: Record<string, ChannelPrefs>;
}

const MAX_PAGE_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 20;

/**
 * Single event pipeline for user-facing notifications: one emit() call
 * fans out to persistent in-app rows and branded emails, honoring
 * per-user channel preferences and a per-type email rate cap.
 *
 * emit() NEVER throws — notification delivery is always best-effort
 * side-band work; a failure here must not break the business flow that
 * triggered it (registration, approval creation, sweeps, ...).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    @InjectRepository(NotificationPreference)
    private readonly preferences: Repository<NotificationPreference>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(UserOrganization)
    private readonly userOrgs: Repository<UserOrganization>,
    @InjectRepository(UserTeam)
    private readonly userTeams: Repository<UserTeam>,
    private readonly mail: MailService,
  ) {}

  // ── Emission ─────────────────────────────────────────────────────

  async emit(input: EmitNotificationInput): Promise<void> {
    try {
      const targetIds = await this.resolveTargets(input);
      if (targetIds.length === 0) return;

      const prefRows = await this.preferences.find({
        where: { userId: In(targetIds), type: input.type },
      });
      const prefByUser = new Map(prefRows.map((p) => [p.userId, p]));
      const defaults = NOTIFICATION_DEFAULTS[input.type] ?? { inApp: true, email: true };

      // Load recipient emails only when the emission carries an email.
      let userById = new Map<string, User>();
      if (input.email) {
        const rows = await this.users.find({
          where: { id: In(targetIds) },
          select: { id: true, email: true, firstName: true },
        });
        userById = new Map(rows.map((u) => [u.id, u]));
      }

      for (const userId of targetIds) {
        try {
          const pref = prefByUser.get(userId);
          const inApp = pref ? pref.inApp : defaults.inApp;
          const emailOn = pref ? pref.email : defaults.email;
          const mandatoryEmail = MANDATORY_EMAIL_TYPES.has(input.type);

          // Digest guard — checked BEFORE inserting the new row so the
          // row we are about to write doesn't rate-limit itself.
          let emailAllowed = false;
          if (input.email && (emailOn || mandatoryEmail)) {
            emailAllowed =
              mandatoryEmail || !(await this.isEmailRateCapped(userId, input.type));
          }

          if (inApp) {
            await this.notifications.save(
              this.notifications.create({
                userId,
                organizationId: input.organizationId,
                type: input.type,
                title: input.title,
                body: input.body,
                link: input.link ?? null,
              }),
            );
          }

          if (emailAllowed && input.email) {
            const user = userById.get(userId);
            if (user?.email) {
              // Fire-and-forget: MailService.send never throws, but do
              // not serialize the fan-out on SMTP round-trips either.
              void this.mail
                .sendTemplate(
                  user.email,
                  input.email.template,
                  {
                    firstName: user.firstName,
                    ...(input.email.params ?? {}),
                  },
                  input.email.subject,
                )
                .catch((err) =>
                  this.logger.warn(`notification email failed: ${err?.message ?? err}`),
                );
            }
          }
        } catch (err: any) {
          this.logger.warn(
            `notification fan-out failed for user ${userId} (${input.type}): ${err?.message ?? err}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(`notification emit failed (${input.type}): ${err?.message ?? err}`);
    }
  }

  /**
   * Resolve the final recipient set: explicit userIds plus role-target
   * expansion, deduplicated, minus exclusions. Role targets resolve to
   * active, accepted memberships only (a pending invitee must not get
   * org-internal notifications).
   */
  private async resolveTargets(input: EmitNotificationInput): Promise<string[]> {
    const ids = new Set<string>(input.userIds ?? []);

    if (input.roleTarget?.orgRoles?.length) {
      const memberships = await this.userOrgs.find({
        where: {
          organizationId: input.organizationId,
          role: In(input.roleTarget.orgRoles),
          isActive: true,
        },
        select: { userId: true, inviteAccepted: true, inviteToken: true },
      });
      for (const m of memberships) {
        // Skip memberships that are pending invites (row exists but the
        // user never accepted). Accepted rows either have
        // inviteAccepted=true or were created directly (no token).
        if (m.inviteAccepted || !m.inviteToken) ids.add(m.userId);
      }
    }

    if (input.roleTarget?.teamLeadOfTeamId) {
      const leads = await this.userTeams.find({
        where: {
          teamId: input.roleTarget.teamLeadOfTeamId,
          role: TeamRole.LEAD,
          isActive: true,
        },
        select: { userId: true },
      });
      for (const l of leads) ids.add(l.userId);
    }

    for (const excluded of input.excludeUserIds ?? []) ids.delete(excluded);
    ids.delete(null as any);
    ids.delete(undefined as any);
    return [...ids];
  }

  /**
   * Digest guard: true when this user already got a notification of
   * this type inside the rate-cap window (max 1 email per type per
   * 10 minutes; in-app rows are never capped).
   */
  private async isEmailRateCapped(userId: string, type: string): Promise<boolean> {
    const since = new Date(Date.now() - EMAIL_RATE_CAP_MS);
    const recent = await this.notifications.findOne({
      where: { userId, type, createdAt: MoreThan(since) },
      order: { createdAt: 'DESC' },
    });
    return !!recent;
  }

  /**
   * Org-level dedupe helper for periodic emitters (e.g. the retention
   * sweep sends at most one summary per org per day).
   */
  async hasRecentOrgNotification(
    organizationId: string,
    type: NotificationEventType,
    windowMs: number,
  ): Promise<boolean> {
    const since = new Date(Date.now() - windowMs);
    const recent = await this.notifications.findOne({
      where: { organizationId, type, createdAt: MoreThan(since) },
      order: { createdAt: 'DESC' },
    });
    return !!recent;
  }

  /**
   * Filter a recipient list down to the users whose effective email
   * preference for `type` is on. Lets senders that manage their own
   * email delivery (e.g. budget alerts) still honor user preferences.
   */
  async filterUsersWithEmailEnabled(
    type: NotificationEventType,
    userIds: string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const defaults = NOTIFICATION_DEFAULTS[type] ?? { inApp: true, email: true };
    const rows = await this.preferences.find({
      where: { userId: In(userIds), type },
    });
    const byUser = new Map(rows.map((p) => [p.userId, p]));
    return userIds.filter((id) => {
      const pref = byUser.get(id);
      return pref ? pref.email : defaults.email;
    });
  }

  // ── In-app listing / read state ──────────────────────────────────

  async list(
    userId: string,
    opts: { unreadOnly?: boolean; page?: number; limit?: number } = {},
  ): Promise<NotificationListResult> {
    const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_PAGE_LIMIT), MAX_PAGE_LIMIT);
    const page = Math.max(1, opts.page ?? 1);

    const where = opts.unreadOnly ? { userId, readAt: IsNull() } : { userId };
    const [rows, total] = await this.notifications.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const unreadCount = await this.notifications.count({
      where: { userId, readAt: IsNull() },
    });

    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        link: n.link,
        createdAt: n.createdAt,
        readAt: n.readAt,
      })),
      total,
      unreadCount,
    };
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    const res = await this.notifications.update(
      { id: notificationId, userId },
      { readAt: new Date() },
    );
    if (!res.affected) {
      throw new NotFoundException('notification not found');
    }
  }

  async markAllRead(userId: string): Promise<void> {
    await this.notifications.update({ userId, readAt: IsNull() }, { readAt: new Date() });
  }

  // ── Preferences ──────────────────────────────────────────────────

  async getPreferences(userId: string): Promise<PreferencesResult> {
    const rows = await this.preferences.find({ where: { userId } });
    const byType = new Map(rows.map((p) => [p.type, p]));

    const matrix: Record<string, ChannelPrefs> = {};
    for (const type of NOTIFICATION_EVENT_TYPES) {
      const row = byType.get(type);
      const d = NOTIFICATION_DEFAULTS[type];
      matrix[type] = row ? { inApp: row.inApp, email: row.email } : { ...d };
    }
    return { matrix, defaults: { ...NOTIFICATION_DEFAULTS } };
  }

  /**
   * Merge a partial preference matrix into the user's stored overrides
   * and return the full merged result. Unknown event types are ignored
   * (forward compatibility for a frontend built against a newer list);
   * each entry may set inApp and/or email independently.
   */
  async updatePreferences(
    userId: string,
    partial: Record<string, Partial<ChannelPrefs>>,
  ): Promise<PreferencesResult> {
    for (const [type, value] of Object.entries(partial ?? {})) {
      if (!(NOTIFICATION_EVENT_TYPES as readonly string[]).includes(type)) continue;
      if (!value || typeof value !== 'object') continue;

      const existing = await this.preferences.findOne({ where: { userId, type } });
      const base = existing
        ? { inApp: existing.inApp, email: existing.email }
        : { ...NOTIFICATION_DEFAULTS[type as NotificationEventType] };

      const next = {
        inApp: typeof value.inApp === 'boolean' ? value.inApp : base.inApp,
        email: typeof value.email === 'boolean' ? value.email : base.email,
      };

      if (existing) {
        existing.inApp = next.inApp;
        existing.email = next.email;
        await this.preferences.save(existing);
      } else {
        await this.preferences.save(
          this.preferences.create({ userId, type, inApp: next.inApp, email: next.email }),
        );
      }
    }
    return this.getPreferences(userId);
  }
}
