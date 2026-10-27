import { HttpException, UnauthorizedException } from '@nestjs/common';

import { SsoController } from '../sso.controller';
import { SsoBrowserErrorFilter } from '../sso-browser-error.filter';
import { OrgDomainService } from '../org-domain.service';
import { ssoErrorRedirect, ssoFailureCode } from '../sso.util';

/**
 * The sign-in page had no way into single sign-on (a person had to be
 * handed the /sso/<org>/<protocol>/login URL), and a refused SSO sign-in --
 * a deactivated member, most often -- left the browser on a raw JSON error.
 */
describe('SSO from the sign-in page', () => {
  describe('discover: does this address sign in with SSO?', () => {
    function controller(opts: { domainOrg?: string | null; config?: any; entitled?: boolean }) {
      const domains = { organizationForEmail: jest.fn(async () => opts.domainOrg ?? null) };
      const configService = {
        getDecrypted: jest.fn(async () => {
          if (opts.entitled === false) throw new HttpException({ code: 'SSO_NOT_ENTITLED' }, 402);
          return opts.config ?? null;
        }),
      };
      const ctl = new SsoController({} as any, {} as any, configService as any, {} as any, domains as any);
      return { ctl, domains };
    }
    const req: any = { headers: {}, protocol: 'https', get: () => 'api.example.com' };

    it('offers the organization sign-in for an address on its verified domain', async () => {
      const { ctl, domains } = controller({ domainOrg: 'org-1', config: { enabled: true, protocol: 'oidc' } });
      const res = await ctl.discover('dana@acme.example', req);
      expect(domains.organizationForEmail).toHaveBeenCalledWith('dana@acme.example');
      expect(res.data).toEqual({ sso: true, protocol: 'oidc', loginUrl: 'https://api.example.com/sso/org-1/oidc/login' });
    });

    it('says no for an unknown domain, SSO switched off, or no SSO on the plan', async () => {
      expect((await controller({ domainOrg: null }).ctl.discover('a@gmail.com', req)).data).toEqual({ sso: false });
      expect((await controller({ domainOrg: 'org-1', config: { enabled: false, protocol: 'saml' } }).ctl.discover('a@acme.example', req)).data).toEqual({ sso: false });
      expect((await controller({ domainOrg: 'org-1', entitled: false }).ctl.discover('a@acme.example', req)).data).toEqual({ sso: false });
      expect((await controller({ domainOrg: 'org-1' }).ctl.discover('not-an-email', req)).data).toEqual({ sso: false });
    });
  });

  describe('organizationForEmail', () => {
    it('matches the domain or its closest verified parent', async () => {
      const repo = {
        find: jest.fn(async ({ where }: any) =>
          [
            { domain: 'acme.example', organizationId: 'org-parent', status: 'verified' },
            { domain: 'eu.acme.example', organizationId: 'org-eu', status: 'verified' },
          ].filter((d) => where.domain._value.includes(d.domain)),
        ),
      };
      const svc = new OrgDomainService(repo as any, {} as any);
      expect(await svc.organizationForEmail('a@eu.acme.example')).toBe('org-eu');
      expect(await svc.organizationForEmail('a@acme.example')).toBe('org-parent');
      expect(await svc.organizationForEmail('a@other.example')).toBeNull();
    });
  });

  describe('a refused sign-in in the browser', () => {
    const run = (exception: unknown, accept: string | undefined) => {
      const res: any = { redirect: jest.fn(), status: jest.fn(() => res), json: jest.fn() };
      const req: any = {
        headers: accept ? { accept } : {},
        accepts: (types: string[]) => (accept?.startsWith('text/html') ? 'html' : types[0]),
      };
      const host: any = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
      new SsoBrowserErrorFilter().catch(exception, host);
      return res;
    };

    it('sends a deactivated member to the error page with the reason, not JSON', () => {
      const res = run(new UnauthorizedException('Your access to this organization has been deactivated'), 'text/html,application/xhtml+xml,*/*;q=0.8');
      expect(res.redirect).toHaveBeenCalledWith(303, ssoErrorRedirect('deactivated'));
      expect(res.json).not.toHaveBeenCalled();
    });

    it('keeps the status and JSON for an API client', () => {
      const res = run(new UnauthorizedException('Sign-in session expired or did not match. Start again.'), undefined);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.redirect).not.toHaveBeenCalled();
    });

    it('names each refusal by a code, never by the text itself', () => {
      expect(ssoFailureCode(new UnauthorizedException('You are not a member of this organization'))).toBe('not_member');
      expect(ssoFailureCode(new UnauthorizedException('Your invitation to this organization has not been accepted yet'))).toBe('invite_pending');
      expect(ssoFailureCode(new UnauthorizedException('No account exists for this identity in this organization'))).toBe('no_account');
      expect(ssoFailureCode(new HttpException({ code: 'SSO_NOT_ENTITLED', message: 'Single sign-on is not included in this organization plan' }, 402))).toBe('not_entitled');
      expect(ssoFailureCode(new Error('socket hang up'))).toBe('failed');
      expect(ssoErrorRedirect('deactivated')).toMatch(/\/auth\/sso-error\?reason=deactivated$/);
    });
  });
});
