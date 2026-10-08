import { importPKCS8, SignJWT } from 'jose';
import { safeFetch } from '../../common/security/safe-fetch';

export const GOOGLE_DIRECTORY_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Fixed Google URLs prevent a key file redirecting credentials elsewhere. */
export async function verifyGoogleGroups(config: Record<string, unknown>, adminEmail: string, memberEmail: string,
  allowedGroups: string[], fetcher: typeof safeFetch = safeFetch): Promise<boolean> {
  if (!allowedGroups.length) return true;
  try {
    if (!adminEmail || !memberEmail || typeof config.serviceAccountJson !== 'string') return false;
    const account = JSON.parse(config.serviceAccountJson);
    if (account.type !== 'service_account' || typeof account.client_email !== 'string' || typeof account.private_key !== 'string') return false;
    const key = await importPKCS8(account.private_key, 'RS256');
    const assertion = await new SignJWT({ scope: GOOGLE_DIRECTORY_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuer(account.client_email)
      .setSubject(adminEmail).setAudience(TOKEN_URL).setIssuedAt().setExpirationTime('5m').sign(key);
    const response = await fetcher(TOKEN_URL, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString() });
    if (!response.ok) return false;
    const token = await response.json() as { access_token?: unknown; token_type?: unknown };
    if (typeof token.access_token !== 'string' || !token.access_token || token.token_type?.toString().toLowerCase() !== 'bearer') return false;
    for (const group of allowedGroups) {
      const url = `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group)}/hasMember/${encodeURIComponent(memberEmail)}`;
      const response = await fetcher(url, { headers: { authorization: `Bearer ${token.access_token}` } });
      if (!response.ok) continue;
      const result = await response.json() as { isMember?: unknown };
      if (result.isMember === true) return true;
    }
    return false;
  } catch {
    // Invalid keys, missing delegation and Directory failures deny access.
    return false;
  }
}
