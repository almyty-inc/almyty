import { JwtService } from '@nestjs/jwt';

import { fakeRepository } from '../../../test/fake-repository';
import { JwtStrategy } from '../../auth/strategies/jwt.strategy';
import { McpOAuthResolveHelper } from '../controllers/mcp-oauth-resolve.helper';

// The global jest setup replaces jsonwebtoken with a double whose verify
// accepts anything; this spec is about what verification refuses.
jest.unmock('jsonwebtoken');

/**
 * The OAuth authorize and consent GETs identify the signed-in user
 * themselves (they must redirect to login rather than 401, so they cannot
 * sit behind JwtAuthGuard). They did it with a bare `jwtService.verify`
 * and trusted the payload: a deactivated account, a session revoked by a
 * password change (tokenVersion), an SSO session confined to one org, and
 * a member removed since the token was minted all came through, the last
 * with the `organizations` claim the membership check then read.
 *
 * The same validation JwtAuthGuard runs has to decide here too.
 */
describe('OAuth consent GET session validation', () => {
  const SECRET = 'consent-session-test-secret';
  const ORG = 'org-1';
  const OTHER_ORG = 'org-2';
  const config = { get: (key: string) => (key === 'JWT_SECRET' ? SECRET : undefined) } as any;
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { issuer: 'almyty', audience: 'almyty-api', expiresIn: '15m' },
  });

  const membership = (organizationId: string, over: Record<string, any> = {}) => ({
    organizationId,
    organization: { id: organizationId, name: organizationId },
    role: 'member',
    isActive: true,
    ...over,
  });

  function helperFor(user: Record<string, any>) {
    const users = fakeRepository<any>([{ tokenVersion: 0, isActive: true, ...user }]);
    // Constructing the strategy registers it with passport, as AuthModule does.
    new JwtStrategy(config, users as any);
    return new McpOAuthResolveHelper(fakeRepository() as any, fakeRepository() as any, config);
  }

  const token = (claims: Record<string, any> = {}) =>
    jwt.sign({
      sub: 'user-1',
      email: 'u@example.com',
      organizations: [{ id: ORG, name: ORG, role: 'member' }],
      tv: 0,
      ...claims,
    });

  const cookieRequest = (value: string) => ({ cookies: { access_token: value }, headers: {} });
  const orgIds = (user: any) => (user?.organizations ?? []).map((o: any) => o.id);

  it('returns the loaded user for an active member', async () => {
    const helper = helperFor({ id: 'user-1', organizationMemberships: [membership(ORG)] });
    const user = await helper.tryExtractUser(cookieRequest(token()));
    expect(McpOAuthResolveHelper.userIdOf(user)).toBe('user-1');
    expect(orgIds(user)).toEqual([ORG]);
  });

  it('refuses a deactivated account', async () => {
    const helper = helperFor({ id: 'user-1', isActive: false, organizationMemberships: [membership(ORG)] });
    expect(await helper.tryExtractUser(cookieRequest(token()))).toBeNull();
  });

  it('refuses a session revoked by a tokenVersion bump', async () => {
    const helper = helperFor({ id: 'user-1', tokenVersion: 1, organizationMemberships: [membership(ORG)] });
    expect(await helper.tryExtractUser(cookieRequest(token({ tv: 0 })))).toBeNull();
  });

  it('reads current membership, not the organizations claim in the token', async () => {
    const helper = helperFor({
      id: 'user-1',
      organizationMemberships: [membership(ORG, { isActive: false })],
    });
    const user = await helper.tryExtractUser(cookieRequest(token()));
    expect(orgIds(user)).not.toContain(ORG);
  });

  it('confines an SSO session to the organization that asserted it', async () => {
    const helper = helperFor({
      id: 'user-1',
      organizationMemberships: [membership(ORG), membership(OTHER_ORG)],
    });
    const user = await helper.tryExtractUser(
      cookieRequest(token({ sso: OTHER_ORG, organizations: [{ id: ORG }, { id: OTHER_ORG }] })),
    );
    expect(orgIds(user)).toEqual([OTHER_ORG]);
  });

  it('refuses a token not issued for this API', async () => {
    const helper = helperFor({ id: 'user-1', organizationMemberships: [membership(ORG)] });
    const foreign = new JwtService({ secret: SECRET }).sign({ sub: 'user-1', tv: 0 });
    expect(await helper.tryExtractUser(cookieRequest(foreign))).toBeNull();
  });

  it('returns null with no credential at all', async () => {
    const helper = helperFor({ id: 'user-1', organizationMemberships: [membership(ORG)] });
    expect(await helper.tryExtractUser({ headers: {} })).toBeNull();
  });
});
