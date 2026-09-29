import { ForbiddenException } from '@nestjs/common';

import { InvitesController } from '../../organizations/invites.controller';
import { NotificationsController } from '../../notifications/notifications.controller';
import { NotificationsService } from '../../notifications/notifications.service';

/**
 * An organization's IdP can sign an assertion for any of its members, so
 * an SSO session is confined to that organization (sso-session.ts). Two
 * user-level routes were outside that fence: the notification list, which
 * holds the person's notifications from every organization including the
 * invite links other organizations sent them, and invite acceptance. The
 * owner of org X could sign in as a member through X's IdP, read an invite
 * that org Y sent that member, and accept it for them.
 */
describe('an SSO session does not reach past its organization through user-level routes', () => {
  const ORG_X = '11111111-1111-4111-8111-111111111111';
  const ssoUser = { id: 'u-1', email: 'member@y.test', ssoOrganizationId: ORG_X };
  const passwordUser = { id: 'u-1', email: 'member@y.test' };

  describe('accepting an invite', () => {
    it('is refused on an SSO session, before the invite is touched', async () => {
      const organizations = { acceptInvite: jest.fn() };
      const controller = new InvitesController(organizations as any);

      await expect(controller.acceptInvite('invite-token', { user: ssoUser })).rejects.toThrow(ForbiddenException);
      expect(organizations.acceptInvite).not.toHaveBeenCalled();
    });

    it('still works on a password session', async () => {
      const organizations = { acceptInvite: jest.fn(async () => ({ organizationId: 'org-y' })) };
      const controller = new InvitesController(organizations as any);

      await controller.acceptInvite('invite-token', { user: passwordUser });
      expect(organizations.acceptInvite).toHaveBeenCalledWith('invite-token', 'u-1');
    });
  });

  describe('the notification list', () => {
    function serviceWith(rows: Array<{ id: string; organizationId: string }>) {
      const where: any[] = [];
      const repo: any = {
        findAndCount: jest.fn(async (opts: any) => {
          where.push(opts.where);
          const hits = rows.filter((r) => !opts.where.organizationId || r.organizationId === opts.where.organizationId);
          return [hits.map((r) => ({ ...r, type: 't', title: 't', body: '', link: '/invites/secret', createdAt: new Date() })), hits.length];
        }),
        count: jest.fn(async (opts: any) => {
          where.push(opts.where);
          return 0;
        }),
        update: jest.fn(async (criteria: any) => {
          where.push(criteria);
          return { affected: 1 };
        }),
      };
      const service = Object.create(NotificationsService.prototype);
      (service as any).notifications = repo;
      return { service: service as NotificationsService, where };
    }

    it('shows an SSO session only its own organization, a password session everything', async () => {
      const rows = [
        { id: 'n-x', organizationId: ORG_X },
        { id: 'n-y', organizationId: 'org-y' },
      ];

      const sso = serviceWith(rows);
      const ssoList: any = await new NotificationsController(sso.service).list({ user: ssoUser });
      expect(ssoList.data.notifications.map((n: any) => n.id)).toEqual(['n-x']);
      expect(sso.where.every((w) => w.organizationId === ORG_X)).toBe(true);

      const plain = serviceWith(rows);
      const plainList: any = await new NotificationsController(plain.service).list({ user: passwordUser });
      expect(plainList.data.notifications.map((n: any) => n.id)).toEqual(['n-x', 'n-y']);
    });

    it('marks read only within that organization', async () => {
      const { service, where } = serviceWith([]);
      const controller = new NotificationsController(service);

      await controller.readAll({ user: ssoUser });
      await controller.read({ user: ssoUser }, '22222222-2222-4222-8222-222222222222');

      expect(where).toEqual([
        expect.objectContaining({ userId: 'u-1', organizationId: ORG_X }),
        expect.objectContaining({ id: '22222222-2222-4222-8222-222222222222', userId: 'u-1', organizationId: ORG_X }),
      ]);
    });
  });
});
