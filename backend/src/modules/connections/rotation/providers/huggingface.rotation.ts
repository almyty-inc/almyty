import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotationCapabilities, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, requireField } from '../rotation.http';

/**
 * Hugging Face, serving both the inference connector (`huggingface`)
 * and the Hub registry connector (`registry-huggingface`). Verified
 * 2026-09-08 (docs/design/connections-rotation.md): tokens are created
 * only in the settings UI; GET /api/whoami-v2 describes the calling
 * token (auth.accessToken.displayName, role, createdAt, expiresAt); and
 * POST /api/credentials/revoke invalidates any token value it is
 * given, no auth needed, always 202.
 */
export const HUGGINGFACE_API = 'https://huggingface.co/api';

export class HuggingFaceRotation implements ConnectorRotation {
  constructor(private readonly http: RotationHttp, readonly key: 'huggingface' | 'registry-huggingface' = 'huggingface') {}

  capabilities(): RotationCapabilities {
    return { create: false, revoke: true, metadata: true, refresh: false };
  }

  async revoke(current: DecryptedSecrets): Promise<void> {
    const token = requireField(current, 'apiKey', this.key);
    const reply = await callJson(this.http, `${HUGGINGFACE_API}/credentials/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ credentials: [token] }),
    });
    failOn(reply, 'huggingface token revoke');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const token = requireField(current, 'apiKey', this.key);
    const reply = await callJson(this.http, `${HUGGINGFACE_API}/whoami-v2`, { method: 'GET', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    failOn(reply, 'huggingface whoami');
    const j = reply.json ?? {};
    const access = j.auth?.accessToken ?? {};
    const who = typeof j.name === 'string' ? j.name : undefined;
    const label = who && access.displayName ? `${who} (${access.displayName})` : who ?? access.displayName;
    return {
      label,
      createdAt: isoDate(access.createdAt),
      expiresAt: isoDate(j.auth?.expiresAt),
      scopes: typeof access.role === 'string' ? [access.role] : undefined,
    };
  }
}
