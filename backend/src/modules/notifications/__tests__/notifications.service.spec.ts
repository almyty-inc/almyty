import { FindOperator } from 'typeorm';
import { NotFoundException } from '@nestjs/common';

import { NotificationsService } from '../notifications.service';
import {
  NOTIFICATION_DEFAULTS,
  NOTIFICATION_EVENT_TYPES,
} from '../notification-types';
import { OrganizationRole } from '../../../entities/user-organization.entity';
import { TeamRole } from '../../../entities/user-team.entity';

/**
 * In-memory repository fake covering the subset NotificationsService
 * uses: findOne/find/findAndCount/count with plain equality plus the
 * In / IsNull / MoreThan operators, create, save, update.
 */
function makeRepo(prefix: string, seed: any[] = []) {
  let idCounter = 0;
  const store: any[] = [...seed];

  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      const actual = row[key];
      if (expected instanceof FindOperator) {
        const type = (expected as any).type ?? (expected as any)._type;
        const value = (expected as any).value ?? (expected as any)._value;
        switch (type) {
          case 'isNull':
            return actual === null || actual === undefined;
          case 'in':
            return (value as any[]).includes(actual);
          case 'moreThan':
            return actual > value;
          default:
            throw new Error(`fake repo: unsupported operator "${type}"`);
        }
      }
      return actual === expected;
    });
  };

  const whereMatches = (row: any, where: any): boolean =>
    Array.isArray(where) ? where.some((w) => matches(row, w)) : matches(row, where);

  return {
    store,
    create: (data: any) => ({ ...data }),
    save: jest.fn(async (row: any) => {
      if (!row.id) {
        row.id = `${prefix}-${++idCounter}`;
        row.createdAt = row.createdAt ?? new Date();
        if (!('readAt' in row)) row.readAt = null;
        store.push(row);
      } else if (!store.includes(row)) {
        const idx = store.findIndex((r) => r.id === row.id);
        if (idx >= 0) store[idx] = row;
        else store.push(row);
      }
      return row;
    }),
    findOne: jest.fn(async ({ where }: any) => {
      const rows = store.filter((r) => whereMatches(r, where));
      rows.sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0));
      return rows[0] ?? null;
    }),
    find: jest.fn(async ({ where }: any = {}) => store.filter((r) => whereMatches(r, where))),
    findAndCount: jest.fn(async ({ where, skip = 0, take }: any = {}) => {
      const rows = store
        .filter((r) => whereMatches(r, where))
        .sort((a, b) => +new Date(b.createdAt ?? 0) - +new Date(a.createdAt ?? 0));
      return [rows.slice(skip, take ? skip + take : undefined), rows.length];
    }),
    count: jest.fn(async ({ where }: any = {}) => store.filter((r) => whereMatches(r, where)).length),
    update: jest.fn(async (criteria: any, patch: any) => {
      const rows = store.filter((r) => whereMatches(r, criteria));
      rows.forEach((r) => Object.assign(r, patch));
      return { affected: rows.length };
    }),
  };
}

describe('NotificationsService', () => {
  let notifRepo: ReturnType<typeof makeRepo>;
  let prefRepo: ReturnType<typeof makeRepo>;
  let userRepo: ReturnType<typeof makeRepo>;
  let userOrgRepo: ReturnType<typeof makeRepo>;
  let userTeamRepo: ReturnType<typeof makeRepo>;
  let mail: { sendTemplate: jest.Mock };
  let service: NotificationsService;

  beforeEach(() => {
    notifRepo = makeRepo('n');
    prefRepo = makeRepo('p');
    userRepo = makeRepo('u', [
      { id: 'user-1', email: 'one@example.com', firstName: 'One' },
      { id: 'user-2', email: 'two@example.com', firstName: 'Two' },
      { id: 'admin-1', email: 'admin@example.com', firstName: 'Admin' },
      { id: 'owner-1', email: 'owner@example.com', firstName: 'Owner' },
      { id: 'lead-1', email: 'lead@example.com', firstName: 'Lead' },
    ]);
    userOrgRepo = makeRepo('uo', [
      { userId: 'owner-1', organizationId: 'org-1', role: OrganizationRole.OWNER, isActive: true, inviteAccepted: true, inviteToken: null },
      { userId: 'admin-1', organizationId: 'org-1', role: OrganizationRole.ADMIN, isActive: true, inviteAccepted: true, inviteToken: null },
      { userId: 'user-1', organizationId: 'org-1', role: OrganizationRole.MEMBER, isActive: true, inviteAccepted: true, inviteToken: null },
      // Pending invite (never accepted) — must NOT receive role-targeted rows.
      { userId: 'user-2', organizationId: 'org-1', role: OrganizationRole.ADMIN, isActive: true, inviteAccepted: false, inviteToken: 'tok' },
    ]);
    userTeamRepo = makeRepo('ut', [
      { userId: 'lead-1', teamId: 'team-1', role: TeamRole.LEAD, isActive: true },
      { userId: 'user-1', teamId: 'team-1', role: TeamRole.MEMBER, isActive: true },
    ]);
    mail = { sendTemplate: jest.fn().mockResolvedValue(true) };
    service = new NotificationsService(
      notifRepo as any,
      prefRepo as any,
      userRepo as any,
      userOrgRepo as any,
      userTeamRepo as any,
      mail as any,
    );
  });

  const emitApproval = (extra: any = {}) =>
    service.emit({
      type: 'approval.pending',
      organizationId: 'org-1',
      title: 'Approval requested',
      body: 'why',
      link: '/approvals/x',
      email: { template: 'approval.pending', params: { reason: 'why' } },
      ...extra,
    });

  // ── Fan-out + preferences ──────────────────────────────────────────

  describe('emit', () => {
    it('writes an in-app row and sends an email per default-on prefs', async () => {
      await emitApproval({ userIds: ['user-1'] });

      expect(notifRepo.store).toHaveLength(1);
      expect(notifRepo.store[0]).toMatchObject({
        userId: 'user-1',
        organizationId: 'org-1',
        type: 'approval.pending',
        title: 'Approval requested',
        body: 'why',
        link: '/approvals/x',
        readAt: null,
      });
      expect(mail.sendTemplate).toHaveBeenCalledTimes(1);
      expect(mail.sendTemplate.mock.calls[0][0]).toBe('one@example.com');
      expect(mail.sendTemplate.mock.calls[0][1]).toBe('approval.pending');
    });

    it('honors an explicit inApp=false preference (email still sent)', async () => {
      await prefRepo.save({ userId: 'user-1', type: 'approval.pending', inApp: false, email: true });

      await emitApproval({ userIds: ['user-1'] });

      expect(notifRepo.store.filter((n) => n.type === 'approval.pending')).toHaveLength(0);
      expect(mail.sendTemplate).toHaveBeenCalledTimes(1);
    });

    it('honors an explicit email=false preference (in-app still written)', async () => {
      await prefRepo.save({ userId: 'user-1', type: 'approval.pending', inApp: true, email: false });

      await emitApproval({ userIds: ['user-1'] });

      expect(notifRepo.store).toHaveLength(1);
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });

    it('applies the defaults matrix when no preference row exists (run.failed email OFF)', async () => {
      await service.emit({
        type: 'run.failed',
        organizationId: 'org-1',
        userIds: ['user-1'],
        title: 'Run failed',
        body: 'boom',
        email: { template: 'run.failed', params: {} },
      });

      expect(notifRepo.store).toHaveLength(1); // in-app default on
      expect(mail.sendTemplate).not.toHaveBeenCalled(); // email default off
    });

    it('never throws even when the store is broken', async () => {
      (notifRepo.save as jest.Mock).mockRejectedValue(new Error('db down'));
      await expect(emitApproval({ userIds: ['user-1'] })).resolves.toBeUndefined();
    });

    it('skips users without an email address for the email channel', async () => {
      userRepo.store.push({ id: 'no-mail', email: null, firstName: 'X' });
      await emitApproval({ userIds: ['no-mail'] });
      expect(notifRepo.store).toHaveLength(1);
      expect(mail.sendTemplate).not.toHaveBeenCalled();
    });
  });

  // ── roleTarget resolution ──────────────────────────────────────────

  describe('roleTarget resolution', () => {
    it('resolves org owners + admins, excluding pending invitees and plain members', async () => {
      await emitApproval({
        roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] },
      });

      const recipients = notifRepo.store.map((n) => n.userId).sort();
      expect(recipients).toEqual(['admin-1', 'owner-1']);
    });

    it('adds the team LEAD (not team members) when teamLeadOfTeamId is set', async () => {
      await emitApproval({
        roleTarget: {
          orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN],
          teamLeadOfTeamId: 'team-1',
        },
      });

      const recipients = notifRepo.store.map((n) => n.userId).sort();
      expect(recipients).toEqual(['admin-1', 'lead-1', 'owner-1']);
    });

    it('deduplicates explicit userIds against roleTarget expansion and honors excludeUserIds', async () => {
      await emitApproval({
        userIds: ['owner-1', 'user-1'],
        roleTarget: { orgRoles: [OrganizationRole.OWNER] },
        excludeUserIds: ['user-1'],
      });

      const recipients = notifRepo.store.map((n) => n.userId).sort();
      expect(recipients).toEqual(['owner-1']);
    });
  });

  // ── Digest guard ───────────────────────────────────────────────────

  describe('email rate cap', () => {
    it('caps at one email per user per type per 10 minutes (in-app always written)', async () => {
      await emitApproval({ userIds: ['user-1'] });
      await emitApproval({ userIds: ['user-1'] });

      expect(notifRepo.store).toHaveLength(2);
      expect(mail.sendTemplate).toHaveBeenCalledTimes(1);
    });

    it('sends again once the window has passed', async () => {
      await emitApproval({ userIds: ['user-1'] });
      notifRepo.store[0].createdAt = new Date(Date.now() - 11 * 60 * 1000);

      await emitApproval({ userIds: ['user-1'] });
      expect(mail.sendTemplate).toHaveBeenCalledTimes(2);
    });

    it('does not cap a different event type', async () => {
      await emitApproval({ userIds: ['user-1'] });
      await service.emit({
        type: 'approval.decided',
        organizationId: 'org-1',
        userIds: ['user-1'],
        title: 'Decided',
        body: 'ok',
        email: { template: 'approval.decided', params: {} },
      });
      expect(mail.sendTemplate).toHaveBeenCalledTimes(2);
    });

    it('mandatory transactional types bypass the cap and an email=false pref', async () => {
      await prefRepo.save({ userId: 'user-1', type: 'account.password_reset', inApp: true, email: false });
      const send = () =>
        service.emit({
          type: 'account.password_reset',
          organizationId: 'org-1',
          userIds: ['user-1'],
          title: 'Reset',
          body: 'reset',
          email: { template: 'account.password_reset', params: { resetUrl: 'https://x' } },
        });

      await send();
      await send();
      expect(mail.sendTemplate).toHaveBeenCalledTimes(2);
    });
  });

  // ── Listing / read state ───────────────────────────────────────────

  describe('list / markRead', () => {
    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        await notifRepo.save({
          userId: 'user-1',
          organizationId: 'org-1',
          type: 'budget.alert',
          title: `t${i}`,
          body: 'b',
          link: null,
          readAt: null,
          createdAt: new Date(Date.now() - i * 1000),
        });
      }
      await notifRepo.save({
        userId: 'user-2',
        organizationId: 'org-1',
        type: 'budget.alert',
        title: 'other user',
        body: 'b',
        link: null,
        readAt: null,
      });
    });

    it('returns the contract shape with total and unreadCount, scoped to the user', async () => {
      const res = await service.list('user-1', {});
      expect(res.total).toBe(3);
      expect(res.unreadCount).toBe(3);
      expect(res.notifications).toHaveLength(3);
      expect(res.notifications[0]).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          type: 'budget.alert',
          title: expect.any(String),
          body: 'b',
          link: null,
          createdAt: expect.any(Date),
          readAt: null,
        }),
      );
    });

    it('supports unreadOnly and pagination', async () => {
      await service.markRead('user-1', notifRepo.store[0].id);

      const unread = await service.list('user-1', { unreadOnly: true });
      expect(unread.total).toBe(2);
      expect(unread.unreadCount).toBe(2);

      const page2 = await service.list('user-1', { page: 2, limit: 1 });
      expect(page2.notifications).toHaveLength(1);
      expect(page2.total).toBe(3);
    });

    it('markRead 404s for another user\'s notification', async () => {
      const foreign = notifRepo.store.find((n) => n.userId === 'user-2');
      await expect(service.markRead('user-1', foreign.id)).rejects.toThrow(NotFoundException);
    });

    it('markAllRead clears the unread count for the caller only', async () => {
      await service.markAllRead('user-1');
      expect((await service.list('user-1', {})).unreadCount).toBe(0);
      expect((await service.list('user-2', {})).unreadCount).toBe(1);
    });
  });

  // ── Preferences ────────────────────────────────────────────────────

  describe('preferences', () => {
    it('returns the full matrix (all 13 event types) plus defaults when nothing is stored', async () => {
      const res = await service.getPreferences('user-1');
      expect(Object.keys(res.matrix).sort()).toEqual([...NOTIFICATION_EVENT_TYPES].sort());
      expect(res.matrix['run.failed']).toEqual({ inApp: true, email: false });
      expect(res.matrix['security.sso_install']).toEqual({ inApp: true, email: true });
      expect(res.defaults).toEqual(NOTIFICATION_DEFAULTS);
    });

    it('merges partial updates per field and returns the merged matrix', async () => {
      const res = await service.updatePreferences('user-1', {
        'run.failed': { email: true },
        'budget.alert': { inApp: false },
      });

      // Only the provided field changes; the other keeps its effective value.
      expect(res.matrix['run.failed']).toEqual({ inApp: true, email: true });
      expect(res.matrix['budget.alert']).toEqual({ inApp: false, email: true });
      // Untouched types stay at defaults.
      expect(res.matrix['approval.pending']).toEqual({ inApp: true, email: true });

      // Second partial update merges against the stored override.
      const res2 = await service.updatePreferences('user-1', {
        'run.failed': { inApp: false },
      });
      expect(res2.matrix['run.failed']).toEqual({ inApp: false, email: true });
    });

    it('ignores unknown event types and non-object values', async () => {
      const res = await service.updatePreferences('user-1', {
        'not.a.type': { email: false },
        'run.failed': 'bogus' as any,
      });
      expect(res.matrix['run.failed']).toEqual(NOTIFICATION_DEFAULTS['run.failed']);
      expect(prefRepo.store).toHaveLength(0);
    });
  });

  // ── Helpers used by other modules ──────────────────────────────────

  describe('helpers', () => {
    it('filterUsersWithEmailEnabled applies overrides on top of defaults', async () => {
      await prefRepo.save({ userId: 'user-1', type: 'budget.alert', inApp: true, email: false });
      const out = await service.filterUsersWithEmailEnabled('budget.alert', ['user-1', 'user-2']);
      expect(out).toEqual(['user-2']);
    });

    it('hasRecentOrgNotification detects rows inside the window', async () => {
      await notifRepo.save({
        userId: 'user-1',
        organizationId: 'org-1',
        type: 'retention.sweep',
        title: 't',
        body: 'b',
        readAt: null,
        createdAt: new Date(),
      });
      expect(await service.hasRecentOrgNotification('org-1', 'retention.sweep', 24 * 3600_000)).toBe(true);
      expect(await service.hasRecentOrgNotification('org-2', 'retention.sweep', 24 * 3600_000)).toBe(false);

      notifRepo.store[0].createdAt = new Date(Date.now() - 25 * 3600_000);
      expect(await service.hasRecentOrgNotification('org-1', 'retention.sweep', 24 * 3600_000)).toBe(false);
    });
  });
});
