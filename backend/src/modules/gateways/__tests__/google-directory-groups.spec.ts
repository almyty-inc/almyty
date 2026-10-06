import { generateKeyPair, exportPKCS8, jwtVerify } from 'jose';
import { GOOGLE_DIRECTORY_SCOPE, verifyGoogleGroups } from '../google-directory-groups';

describe('Google Directory membership', () => {
  let config: Record<string, unknown>;
  let publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
  beforeAll(async () => {
    const keys = await generateKeyPair('RS256', { extractable: true });
    publicKey = keys.publicKey;
    config = { serviceAccountJson: JSON.stringify({ type: 'service_account', client_email: 'service@example.com',
      private_key: await exportPKCS8(keys.privateKey), token_uri: 'http://169.254.169.254/' }) };
  });
  it('signs a delegated readonly assertion and checks any allowed group using fixed Google URLs', async () => {
    const fetcher = jest.fn(async (url: string, init: any) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        const { payload } = await jwtVerify(new URLSearchParams(init.body).get('assertion')!, publicKey,
          { issuer: 'service@example.com', subject: 'admin@example.com', audience: url });
        expect(payload.scope).toBe(GOOGLE_DIRECTORY_SCOPE);
        expect(payload.exp! - payload.iat!).toBe(300);
        return Response.json({ access_token: 'token', token_type: 'Bearer' });
      }
      expect(init.headers.authorization).toBe('Bearer token');
      return Response.json({ isMember: url.includes('staff%40example.com') });
    });
    expect(await verifyGoogleGroups(config, 'admin@example.com', 'person+one@example.com',
      ['other@example.com', 'staff@example.com'], fetcher)).toBe(true);
    expect(fetcher.mock.calls[2][0]).toBe('https://admin.googleapis.com/admin/directory/v1/groups/staff%40example.com/hasMember/person%2Bone%40example.com');
  });
  it.each([false, 'true', undefined])('denies non-boolean membership %s', async isMember => {
    const fetcher = jest.fn().mockResolvedValueOnce(Response.json({ access_token: 'token', token_type: 'Bearer' }))
      .mockResolvedValueOnce(Response.json({ isMember }));
    expect(await verifyGoogleGroups(config, 'admin@example.com', 'person@example.com', ['staff'], fetcher)).toBe(false);
  });
  it('fails closed on delegation failures, malformed keys and network errors', async () => {
    const fetcher = jest.fn().mockResolvedValue(Response.json({}, { status: 403 }));
    expect(await verifyGoogleGroups(config, 'admin@example.com', 'person@example.com', ['staff'], fetcher)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await verifyGoogleGroups({ serviceAccountJson: 'bad' }, 'admin', 'person', ['staff'], fetcher)).toBe(false);
    fetcher.mockReset().mockResolvedValueOnce(Response.json({ access_token: 'token', token_type: 'Bearer' }))
      .mockRejectedValueOnce(new Error('unavailable'));
    expect(await verifyGoogleGroups(config, 'admin@example.com', 'person@example.com', ['staff'], fetcher)).toBe(false);
  });
});
