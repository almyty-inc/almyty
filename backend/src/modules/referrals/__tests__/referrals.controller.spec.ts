import { BadRequestException, HttpException } from '@nestjs/common';

import { ReferralsController } from '../referrals.controller';
import { REFERRAL_COOKIE, clientIpOf } from '../referrals.constants';

describe('ReferralsController', () => {
  let service: any;
  let controller: ReferralsController;

  beforeEach(() => {
    service = {
      getOrCreateCode: jest.fn().mockResolvedValue({ code: 'ABCD2345' }),
      buildShareLink: jest.fn((code: string) => `https://app.example.com/r/${code}`),
      getStats: jest.fn().mockResolvedValue({ invited: 1 }),
      listReferrals: jest.fn().mockResolvedValue([{ id: 'ref-1' }]),
      findActiveCode: jest.fn().mockResolvedValue(null),
    };
    controller = new ReferralsController(service);
  });

  const authedReq = (overrides: any = {}) => ({
    user: { id: 'user-1', currentOrganizationId: 'org-1' },
    ip: '203.0.113.5',
    ...overrides,
  });

  const mockRes = () =>
    ({ cookie: jest.fn(), redirect: jest.fn() }) as any;

  describe('authenticated endpoints scope to the caller', () => {
    it('getCode uses the caller identity and returns the share link', async () => {
      const result = await controller.getCode(authedReq());

      expect(service.getOrCreateCode).toHaveBeenCalledWith('user-1', 'org-1', '203.0.113.5');
      expect(result.data).toEqual({
        code: 'ABCD2345',
        link: 'https://app.example.com/r/ABCD2345',
      });
    });

    it('getCode rejects when no organization is resolved', async () => {
      await expect(
        controller.getCode(authedReq({ user: { id: 'user-1' } })),
      ).rejects.toThrow(HttpException);
      expect(service.getOrCreateCode).not.toHaveBeenCalled();
    });

    it('stats only ever queries the caller own referrals', async () => {
      await controller.getStats(authedReq());
      expect(service.getStats).toHaveBeenCalledWith('user-1');
      expect(service.getStats).toHaveBeenCalledTimes(1);
    });

    it('list only ever queries the caller own referrals', async () => {
      await controller.list(authedReq());
      expect(service.listReferrals).toHaveBeenCalledWith('user-1');
    });

    it('a caller cannot request another user stats — no user-id input exists', async () => {
      // The route derives the user id exclusively from the JWT principal;
      // there is no param/query to override it with.
      const req = authedReq({ user: { id: 'user-2', currentOrganizationId: 'org-9' } });
      await controller.getStats(req);
      expect(service.getStats).toHaveBeenCalledWith('user-2');
    });
  });

  describe('attribute (public)', () => {
    it('sets the attribution cookie for a valid code and redirects to register', async () => {
      service.findActiveCode.mockResolvedValue({ code: 'ABCD2345' });
      const res = mockRes();

      await controller.attribute('ABCD2345', undefined, res);

      expect(res.cookie).toHaveBeenCalledWith(
        REFERRAL_COOKIE,
        'ABCD2345',
        expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
      );
      expect(res.redirect).toHaveBeenCalledWith(302, expect.stringContaining('/auth/register'));
    });

    it('redirects without a cookie for an unknown code', async () => {
      const res = mockRes();

      await controller.attribute('UNKNOWN2', undefined, res);

      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalled();
    });

    it('redirects without a cookie for a malformed code', async () => {
      const res = mockRes();

      await controller.attribute('<script>', undefined, res);

      expect(service.findActiveCode).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
      expect(res.redirect).toHaveBeenCalled();
    });

    it('returns JSON when format=json', async () => {
      service.findActiveCode.mockResolvedValue({ code: 'ABCD2345' });
      const res = mockRes();

      const result = await controller.attribute('ABCD2345', 'json', res);

      expect(result).toEqual({ success: true, data: { attributed: true } });
      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.cookie).toHaveBeenCalled();
    });

    it('rejects malformed codes with 400 in JSON mode', async () => {
      const res = mockRes();
      await expect(controller.attribute('bad code!', 'json', res)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});

describe('clientIpOf', () => {
  it('prefers the first X-Forwarded-For hop over req.ip', () => {
    expect(
      clientIpOf({ ip: '10.0.0.2', headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } }),
    ).toBe('203.0.113.9')
  })

  it('falls back to req.ip when no forwarding header is present', () => {
    expect(clientIpOf({ ip: '127.0.0.1', headers: {} })).toBe('127.0.0.1')
    expect(clientIpOf({ headers: {} })).toBeUndefined()
  })
})
