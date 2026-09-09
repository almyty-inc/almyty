import { ConnectorRotation, DecryptedSecrets, KeyDescription, RotateResult, RotationCapabilities, RotationContext, RotationError, RotationHttp } from '../rotation.interface';
import { callJson, failOn, isoDate, keyLabel, matchesRedacted, requireField } from '../rotation.http';

/**
 * Mistral. Verified 2026-09-08 (docs/design/connections-rotation.md):
 * the beta Admin API, driven by an admin API key, creates keys at
 * POST /v1/admin/api-keys (user_id, workspace_uuid, name; `key`
 * returned once with `key_id`, `hidden_key`, `created_at`,
 * `expiration_date`), lists them at GET /v1/admin/api-keys (`keys`,
 * each with `last_used`) and deletes at DELETE /v1/admin/api-keys/{key_id}.
 */
export const MISTRAL_API = 'https://api.mistral.ai/v1';

export class MistralRotation implements ConnectorRotation {
  readonly key = 'mistral';

  constructor(private readonly http: RotationHttp) {}

  capabilities(): RotationCapabilities {
    return { create: true, revoke: true, metadata: true, refresh: false };
  }

  requires(): string[] {
    return ['adminKey', 'workspaceId', 'userId'];
  }

  private headers(secrets: DecryptedSecrets): Record<string, string> {
    return { Authorization: `Bearer ${requireField(secrets, 'adminKey', this.key)}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async find(secrets: DecryptedSecrets): Promise<any> {
    const apiKey = requireField(secrets, 'apiKey', this.key);
    const reply = await callJson(this.http, `${MISTRAL_API}/admin/api-keys`, { method: 'GET', headers: this.headers(secrets) });
    failOn(reply, 'mistral key list');
    const rows: any[] = Array.isArray(reply.json?.keys) ? reply.json.keys : Array.isArray(reply.json) ? reply.json : [];
    const hit = rows.find((r) => (secrets.keyId && r?.key_id === secrets.keyId) || matchesRedacted(apiKey, r?.hidden_key));
    if (!hit) throw new RotationError('ROTATION_FAILED', 'mistral: the connection key is not among the keys the admin key can see');
    return hit;
  }

  async rotate(current: DecryptedSecrets, ctx: RotationContext): Promise<RotateResult> {
    const name = keyLabel(ctx);
    const body = { user_id: requireField(current, 'userId', this.key), workspace_uuid: requireField(current, 'workspaceId', this.key), name };
    const reply = await callJson(this.http, `${MISTRAL_API}/admin/api-keys`, { method: 'POST', headers: this.headers(current), body: JSON.stringify(body) });
    failOn(reply, 'mistral key create');
    const key = reply.json?.key;
    if (typeof key !== 'string' || !key) throw new RotationError('ROTATION_FAILED', 'mistral: key create answered without a key');
    return { next: { apiKey: key, keyId: String(reply.json.key_id ?? '') }, label: reply.json.name ?? name, expiresAt: isoDate(reply.json.expiration_date) };
  }

  async revoke(current: DecryptedSecrets): Promise<void> {
    const id = typeof current.keyId === 'string' && current.keyId ? current.keyId : String((await this.find(current)).key_id);
    const reply = await callJson(this.http, `${MISTRAL_API}/admin/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this.headers(current) });
    failOn(reply, 'mistral key delete');
  }

  async describe(current: DecryptedSecrets): Promise<KeyDescription> {
    const hit = await this.find(current);
    return { label: hit.name, createdAt: isoDate(hit.created_at), lastUsedAt: isoDate(hit.last_used), expiresAt: isoDate(hit.expiration_date) };
  }
}
