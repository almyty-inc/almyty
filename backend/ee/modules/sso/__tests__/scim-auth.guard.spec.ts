import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ScimAuthGuard } from '../guards/scim-auth.guard';

function contextWith(headers: Record<string, string>): {
  ctx: ExecutionContext;
  req: any;
} {
  const req: any = { headers };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

describe('ScimAuthGuard', () => {
  it('rejects a request with no Authorization header (401)', async () => {
    const configService = { findOrgByScimToken: jest.fn() } as any;
    const guard = new ScimAuthGuard(configService);
    const { ctx } = contextWith({});
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(configService.findOrgByScimToken).not.toHaveBeenCalled();
  });

  it('rejects an unknown bearer token (401)', async () => {
    const configService = { findOrgByScimToken: jest.fn().mockResolvedValue(null) } as any;
    const guard = new ScimAuthGuard(configService);
    const { ctx } = contextWith({ authorization: 'Bearer scim_bogus' });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts a valid token and attaches the resolved org id', async () => {
    const configService = { findOrgByScimToken: jest.fn().mockResolvedValue('org-42') } as any;
    const guard = new ScimAuthGuard(configService);
    const { ctx, req } = contextWith({ authorization: 'Bearer scim_good' });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(req.scimOrgId).toBe('org-42');
    expect(configService.findOrgByScimToken).toHaveBeenCalledWith('scim_good');
  });
});
