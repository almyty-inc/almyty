import { BadRequestException } from '@nestjs/common';

import { CredentialSignInController } from '../connections.controller';

/**
 * A sign-in at a service comes back to the Credentials page, where the
 * new credential opens.
 */
describe('the sign-in callback lands on Credentials', () => {
  const config = { get: (key: string) => (key === 'FRONTEND_URL' ? 'https://app.example.com/' : undefined) } as any;
  const response = () => {
    const res: any = {};
    res.redirect = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  it('opens the new credential after a sign-in', async () => {
    const service = { handleCallback: jest.fn().mockResolvedValue({ id: 'cred-1', health: { status: 'valid' } }) } as any;
    const res = response();
    await new CredentialSignInController(service, config).callback({ state: 's', code: 'c' }, res);
    expect(res.redirect).toHaveBeenCalledWith(302, 'https://app.example.com/credentials?connection=cred-1&status=valid');
  });

  it('says what went wrong on the Credentials page when the sign-in fails', async () => {
    const service = { handleCallback: jest.fn().mockRejectedValue(new BadRequestException({ code: 'STATE_EXPIRED', message: 'Too late' })) } as any;
    const res = response();
    await new CredentialSignInController(service, config).callback({ state: 's', code: 'c' }, res);
    const [status, url] = res.redirect.mock.calls[0];
    expect(status).toBe(302);
    expect(url).toMatch(/^https:\/\/app\.example\.com\/credentials\?/);
    expect(new URL(url).searchParams.get('code')).toBe('STATE_EXPIRED');
  });
});
