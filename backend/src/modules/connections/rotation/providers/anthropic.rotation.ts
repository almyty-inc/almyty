import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotationCapabilities, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, matchesRedacted, requireField } from '../rotation.http';

/**
 * Anthropic. Verified 2026-09-08 (docs/design/connections-rotation.md):
 * the Admin API lists keys at GET /v1/organizations/api_keys (name,
 * created_at, expires_at, partial_key_hint, status) and updates one at
 * POST /v1/organizations/api_keys/{id} with status `inactive`. There is
 * no create endpoint, so rotation stays manual; revoke and describe
 * work with an Admin API key (sk-ant-admin...) in `adminKey`.
 */
export const ANTHROPIC_API = 'https://api.anthropic.com/v1';
export const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicRotation implements ConnectorRotation {
  readonly key = 'anthropic';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: false, revoke: true, metadata: true, refresh: false };
  }

  requires(): string[] {
    return ['adminKey'];
  }

  private admin(secrets: DecryptedSecrets): Record<string, string> {
    return { 'x-api-key': requireField(secrets, 'adminKey', this.key), 'anthropic-version': ANTHROPIC_VERSION, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async find(secrets: DecryptedSecrets): Promise<any> {
    const apiKey = requireField(secrets, 'apiKey', this.key);
    let after: string | undefined;
    for (let page = 0; page < 10; page++) {
      const url = `${ANTHROPIC_API}/organizations/api_keys?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
      const reply = await callJson(this.http, url, { method: 'GET', headers: this.admin(secrets) });
      failOn(reply, 'anthropic key list');
      const rows: any[] = Array.isArray(reply.json?.data) ? reply.json.data : [];
      const hit = rows.find((r) => (secrets.keyId && r?.id === secrets.keyId) || matchesRedacted(apiKey, r?.partial_key_hint));
      if (hit) return hit;
      if (!reply.json?.has_more || !reply.json?.last_id) break;
      after = String(reply.json.last_id);
    }
    throw new RotationError('ROTATION_FAILED', 'anthropic: the connection key is not among the keys the admin key can see');
  }

  async revoke(current: DecryptedSecrets): Promise<void> {
    const hit = await this.find(current);
    const reply = await callJson(this.http, `${ANTHROPIC_API}/organizations/api_keys/${encodeURIComponent(String(hit.id))}`, {
      method: 'POST', headers: this.admin(current), body: JSON.stringify({ status: 'inactive' }),
    });
    failOn(reply, 'anthropic key deactivate');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const hit = await this.find(current);
    return { label: hit.name, createdAt: isoDate(hit.created_at), expiresAt: isoDate(hit.expires_at) };
  }
}
